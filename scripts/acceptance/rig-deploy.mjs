#!/usr/bin/env node
// Rig deploy acceptance: control sets a rig up on a machine over SSH, and the rig reports.
// A privileged local container with systemd, sshd and rootless Podman stands in for the machine
// (containers/test-host; never a real host), on control's compose network. Control makes the
// machine's key, the owner trusts the host key, lingering is turned on after the owner's yes,
// then Rigs › Add a rig enrolls a CPU rig, writes its files and Quadlet units, starts it, and the
// rig's first report must reach control. Then its services are stopped, started and removed.
// The rig's images are the ones compose builds, loaded into the machine's rootless Podman. The
// rig's supervisor reports over the message bus (compose's nats service, on the same network), over
// TLS, trusting control's authority, which control hands it with its files.
// Usage: COMPOSE="podman compose" node scripts/acceptance/rig-deploy.mjs (Podman only).
import { execSync } from "node:child_process";
import { acceptanceChecks } from "./lib/checks.mjs";
import { control, dc, engine, formAnswer, secret, sh, until } from "./lib/smoke-env.mjs";

const { check, results } = acceptanceChecks();
if (engine !== "podman") {
  console.log("rig deploy acceptance: needs Podman (a privileged systemd container)");
  process.exit(1);
}
const host = "thermite-test-host";
const onHost = (cmd) => sh("podman", ["exec", host, "sh", "-c", cmd]);
const harnessImage = "docker.io/library/thermite-harness:latest";
const supervisorImage = "docker.io/library/thermite-supervisor:latest";
const env = {
  THERMITE_CONTROL_PUBLIC_URL: "http://control:8800",
  // The machine is on control's compose network: it reaches the bus's server by its service name.
  THERMITE_NATS_PUBLIC_URL: "nats://nats:4222",
  THERMITE_RIG_HARNESS_IMAGE: harnessImage,
  THERMITE_RIG_SUPERVISOR_IMAGE: supervisorImage,
};

sh("node", ["scripts/dev/init.mjs"]);
console.log("compose: build the images and start control; build the stand-in machine");
dc(env, "build", "control", "harness", "supervisor");
dc(env, "up", "-d", "control", "nats");
sh("podman", ["build", "-q", "-t", "thermite-test-host", "containers/test-host"]);
const cleanup = () => {
  try {
    sh("podman", ["rm", "-f", "-t", "5", host]);
  } catch {}
  try {
    sh("podman", ["volume", "rm", "-f", "thermite-test-host-storage"]);
  } catch {}
};
cleanup();
try {
  sh("podman", [
    "run",
    "-d",
    "--name",
    host,
    "--privileged",
    "--systemd=always",
    "--network",
    "thermite_control",
    "-v",
    "thermite-test-host-storage:/home/thermite/.local/share/containers",
    "thermite-test-host",
  ]);
  await until(
    "the machine's systemd is up",
    async () => /running|degraded/.test(onHost("systemctl is-system-running || true")),
    120_000,
  );
  onHost("chown -R thermite:thermite /home/thermite/.local");
  console.log("loading the rig images into the machine's rootless Podman");
  execSync(
    `podman save ${harnessImage} ${supervisorImage} | podman exec -i ${host} su - thermite -c 'podman load -q'`,
    { stdio: ["ignore", "inherit", "inherit"], shell: "/bin/sh" },
  );
  await until("control answers", async () => (await fetch(`${control}/v1/health`)).ok, 120_000);
  const login = await fetch(`${control}/ui/login`, {
    method: "POST",
    body: new URLSearchParams({ token: secret("control-admin-token") }),
    redirect: "manual",
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const get = async (path) => (await fetch(`${control}${path}`, { headers: { cookie } })).text();
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(await get("/ui/settings"))?.[1] ?? "";
  const post = async (path, form) => {
    const r = await fetch(`${control}${path}`, {
      method: "POST",
      body: new URLSearchParams({ csrf, ...form }),
      headers: { cookie },
      redirect: "manual",
    });
    return formAnswer(r, cookie);
  };

  // The machine, as the owner adds it in Providers.
  await post("/ui/settings/add", {
    type: "ssh",
    name: "test-host",
    address: host,
    port: "22",
    user: "thermite",
    private_key: "",
  });
  let html = await get("/ui/settings");
  const pub = /(restrict ssh-ed25519 [A-Za-z0-9+/=]+ thermite test-host)/.exec(html)?.[1];
  execSync(`podman exec -i ${host} sh -c 'cat >> /home/thermite/.ssh/authorized_keys'`, {
    input: `${pub}\n`,
    shell: "/bin/sh",
  });
  const seen = /name="seen" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const trusted = await post("/ui/settings/machines/test-host/trust", { seen });
  check(
    "control trusted the machine's host key and read it",
    /read the machine/.test(trusted),
    trusted,
  );
  html = await get("/ui/settings");
  // Lingering is off on a fresh machine: control asks, and turns it on after the owner's yes.
  const sha =
    /name="recipe" value="linger"><input type="hidden" name="sha" value="([0-9a-f]{64})"/.exec(
      html,
    )?.[1];
  check("control asks before turning lingering on", Boolean(sha));
  await post("/ui/settings/machines/test-host/install", { recipe: "linger", sha });
  await until(
    "lingering is on",
    async () =>
      /Last install: Lingering for the user's services, allowed by owner:ui, <span class="chip ok">done/.test(
        await get("/ui/settings"),
      ),
    120_000,
    2000,
  );
  check(
    "lingering is on after the owner's yes",
    /Linger=yes/.test(onHost("loginctl show-user thermite -p Linger")),
  );

  // Rigs › Add a rig: a CPU rig on the machine.
  const addPage = await get("/ui/rigs/add");
  check(
    "Add a rig offers the machine",
    /name="place" value="machine:test-host"(?! disabled)/.test(addPage) &&
      !/Not ready/.test(addPage),
    addPage
      .match(/<label class="ch[^>]*>[\s\S]*?<\/label>/)?.[0]
      ?.replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  );
  const made = await post("/ui/rigs/add", { machine: "test-host", rig: "box-rig-1" });
  check("control took the rig and shows its setup", made === "/ui/rigs/box-rig-1", made);
  const reported = await until(
    "the rig's first report reaches control",
    async () => {
      const h = await get("/ui/rigs/box-rig-1");
      if (/First report reached control/.test(h)) return h;
      if (/✕/.test(h))
        throw new Error(
          h
            .match(/<div class="tl"[\s\S]*?<\/div><\/div>/)?.[0]
            ?.replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " "),
        );
      return undefined;
    },
    900_000,
    5000,
  ).catch((err) => String(err?.message ?? err));
  check(
    "the rig was enrolled, set up and started on the machine, and reported",
    /Enrolled with control/.test(reported) &&
      /Files and units written, images ready, services started/.test(reported) &&
      /First report reached control/.test(reported),
    reported.length < 400 ? reported : undefined,
  );
  check(
    "the rig's supervisor registered its key on the bus, and its units name the bus and control's authority",
    /Its key on the message bus registered/.test(reported) &&
      /THERMITE_NATS_URL=nats:\/\/nats:4222/.test(
        onHost(
          "cat /home/thermite/.config/containers/systemd/thermite-box-rig-1-supervisor.container",
        ),
      ) &&
      /BEGIN CERTIFICATE/.test(
        onHost("cat /home/thermite/.local/share/thermite/rigs/box-rig-1/bus/bus-ca.pem"),
      ),
  );
  check(
    "the rig's services run as the machine user's systemd units",
    /active\s+active/.test(
      onHost(
        "su - thermite -c 'XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active thermite-box-rig-1-supervisor thermite-box-rig-1-harness' || true",
      ).replace(/\n/g, " "),
    ),
  );
  // Stop and start from the rig's page, then remove it.
  const stopped = await post("/ui/rigs/box-rig-1/machine/stop", {});
  check("stop from the rig's page", /ok=Stopped/.test(stopped), stopped);
  const started = await post("/ui/rigs/box-rig-1/machine/start", {});
  check("start from the rig's page", /ok=Started/.test(started), started);
  const refused = await post("/ui/rigs/box-rig-1/machine/remove", { confirm: "remove" });
  check("remove asks for the rig's name", /Type "remove box-rig-1"/.test(refused), refused);
  const removed = await post("/ui/rigs/box-rig-1/machine/remove", { confirm: "remove box-rig-1" });
  check(
    "remove takes the rig's units and files off the machine",
    /ok=Removed/.test(removed) &&
      onHost(
        "ls /home/thermite/.config/containers/systemd /home/thermite/.local/share/thermite/rigs 2>/dev/null | grep -c box-rig-1 || true",
      ).trim() === "0",
    removed,
  );
} catch (err) {
  check("acceptance run", false, String(err?.stack ?? err));
} finally {
  cleanup();
  dc(env, "down", "-v");
}
const ok = results.every((r) => r.ok);
console.log(ok ? "rig deploy acceptance: OK" : "rig deploy acceptance: FAILED");
process.exit(ok ? 0 : 1);
