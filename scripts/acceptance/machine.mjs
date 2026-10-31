#!/usr/bin/env node
// Machines acceptance: control reaches a machine over SSH from its own image. A local container
// stands in for the machine (containers/test-machine; never a real host), on control's compose
// network. Control makes the machine's key, the test adds its public half to the machine, the
// owner's host-key check is compared with the machine's real host key, the read-only check
// reads the machine, Podman is installed only after the owner's yes, and a changed host key is
// refused.
// Usage: COMPOSE="podman compose" node scripts/acceptance/machine.mjs (or "docker compose").
import { execFileSync } from "node:child_process";
import { acceptanceChecks } from "./lib/checks.mjs";
import { control, dc, engine, formAnswer, secret, sh, until } from "./lib/smoke-env.mjs";

const { check, results } = acceptanceChecks();
const box = "thermite-test-machine";
const run = (...a) => sh(engine, a);
const onBox = (cmd, input) =>
  execFileSync(engine, ["exec", "-i", box, "sh", "-c", cmd], { encoding: "utf8", input });

sh("node", ["scripts/dev/init.mjs"]);
const env = { THERMITE_CONTROL_PUBLIC_URL: "http://control:8800" };
console.log("compose: build and start control; build the stand-in machine");
dc(env, "up", "-d", "--build", "control", "nats");
run("build", "-q", "-t", "thermite-test-machine", "containers/test-machine");
try {
  run("rm", "-f", box);
} catch {}
try {
  run("run", "-d", "--name", box, "--network", "thermite_control", "thermite-test-machine");
  // Kubernetes adds no passwd entry for the image's user (Podman does): ssh must work without one.
  if (engine === "podman") {
    const bare = sh("podman", [
      "run",
      "--rm",
      "--passwd=false",
      "--entrypoint",
      "sh",
      "docker.io/library/thermite-control:latest",
      "-c",
      "ssh -V 2>&1; getent passwd $(id -u)",
    ]);
    check(
      "control's user has a passwd entry, so ssh runs as on Kubernetes",
      /OpenSSH/.test(bare) && /^thermite:/m.test(bare),
      bare.trim(),
    );
  }
  await until("control answers", async () => (await fetch(`${control}/v1/health`)).ok, 120_000);
  const login = await fetch(`${control}/ui/login`, {
    method: "POST",
    body: new URLSearchParams({ token: secret("control-admin-token") }),
    redirect: "manual",
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const page = async () => (await fetch(`${control}/ui/settings`, { headers: { cookie } })).text();
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(await page())?.[1] ?? "";
  const post = async (path, form) => {
    const r = await fetch(`${control}${path}`, {
      method: "POST",
      body: new URLSearchParams({ csrf, ...form }),
      headers: { cookie },
      redirect: "manual",
    });
    return formAnswer(r, cookie);
  };

  const added = await post("/ui/settings/add", {
    type: "ssh",
    name: "test-box",
    address: box,
    port: "22",
    user: "thermite",
    private_key: "",
  });
  check(
    "control added the machine and read its host key",
    /Compare its host key/.test(added),
    added,
  );
  let html = await page();
  const pub = /(restrict ssh-ed25519 [A-Za-z0-9+/=]+ thermite test-box)/.exec(html)?.[1];
  check(
    "control made the machine's key and shows only its public half",
    Boolean(pub) && !html.includes("PRIVATE KEY"),
  );
  onBox("cat >> /home/thermite/.ssh/authorized_keys", `${pub}\n`);
  // The fingerprint the owner compares is the machine's real host key.
  const real = onBox("ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub").split(" ")[1];
  check("the host key shown is the machine's own", html.includes(`<code>${real}</code>`), { real });
  const seen = /name="seen" value="([^"]+)"/.exec(html)?.[1]?.replace(/&#39;/g, "'") ?? "";
  const trusted = await post("/ui/settings/machines/test-box/trust", { seen });
  check(
    "trusting the key reads the machine over SSH from control's image",
    /read the machine/.test(trusted),
    trusted,
  );
  html = await page();
  check(
    "the check found the machine's system, no GPU, no Podman, sudo, and control reachable",
    /Debian GNU\/Linux 12/.test(html) &&
      /none: rigs here measure on the CPU/.test(html) &&
      /Podman missing/.test(html) &&
      /sudo without a password/.test(html) &&
      /http:\/\/control:8800 <span class="chip ok">reached/.test(html),
    html
      .match(/<dl class="facts"[\s\S]*?<\/dl>/)?.[0]
      ?.replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  );
  // Podman is missing: control asks, shows exactly what it would run, and installs it on a yes.
  const sha =
    /name="recipe" value="podman"><input type="hidden" name="sha" value="([0-9a-f]{64})"/.exec(
      html,
    )?.[1];
  check(
    "control asks before installing Podman, showing the exact commands",
    Boolean(sha) && /sudo -n apt-get install -y podman/.test(html),
  );
  const started = await post("/ui/settings/machines/test-box/install", { recipe: "podman", sha });
  check(
    "the owner's yes starts the install",
    /Installing Podman on "test-box", as you allowed/.test(started),
    started,
  );
  // The install ends, then control reads the machine again: wait for both, since the read can
  // land a little after the install's "done".
  const done = await until(
    "the install finishes and the machine is read again",
    async () => {
      const h = await page();
      const ended =
        /Last install: Podman, allowed by owner:ui, <span class="chip [a-z]+">(done|failed)/;
      const read = /<span class="chip ok">Podman [0-9.]+<\/span>|chip [a-z]+">failed/;
      return ended.test(h) && read.test(h) ? h : undefined;
    },
    900_000,
    5000,
  );
  check(
    "Podman was installed and the machine read again",
    /Last install: Podman, allowed by owner:ui, <span class="chip ok">done/.test(done) &&
      /<span class="chip ok">Podman [0-9.]+<\/span>/.test(done),
    done.match(/Last install:[^<]*<span class="chip [a-z]+">[a-z]+/)?.[0],
  );
  // A machine presenting another host key is refused, and the new key shown for the owner.
  onBox("rm /etc/ssh/ssh_host_* && ssh-keygen -A >/dev/null && kill -HUP 1");
  const refused = await until(
    "sshd restarts with its new host key",
    async () => {
      const r = await post("/ui/settings/machines/test-box/check", {});
      return /different host key/.test(r) ? r : undefined;
    },
    60_000,
    2000,
  );
  check("a changed host key is refused", Boolean(refused), refused);
  check(
    "the new host key is shown for the owner to decide",
    /The machine now presents a different host key/.test(await page()),
  );
} catch (err) {
  check("acceptance run", false, String(err?.stack ?? err));
} finally {
  try {
    run("rm", "-f", box);
  } catch {}
  dc(env, "down", "-v");
}
const ok = results.every((r) => r.ok);
console.log(ok ? "machine acceptance: OK" : "machine acceptance: FAILED");
process.exit(ok ? 0 : 1);
