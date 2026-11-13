import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ControlOptions } from "../../src/control/api/index.ts";
import { makeDeployKey } from "../../src/control/git-keys.ts";
import { CHECK_SCRIPT } from "../../src/control/machines/facts.ts";
import { type MachineSsh, parseHostKeys, type SshTarget } from "../../src/control/machines/ssh.ts";
import { SecretBox } from "../../src/control/secrets.ts";
import { controlOnly, signIn } from "../helpers/control-stack.ts";
import { ingestReport } from "../helpers/control-store.ts";

const HOST = makeDeployKey("host").publicKey.split(" ")[1] as string;
const OTHER = makeDeployKey("other").publicKey.split(" ")[1] as string;
const FACTS_GPU = "gpu=0, GPU-aaaa, NVIDIA GeForce RTX 4090, 24564, 412, 0";
const FACTS = [
  "os=Ubuntu 24.04.1 LTS",
  "os_id=ubuntu debian",
  "kernel=6.8.0-45-generic",
  "arch=x86_64",
  "cpus=32",
  "mem_kib=131072000",
  "disk_free_kib=1610612736",
  "user=thermite",
  FACTS_GPU,
  "driver=550.127.05",
  "cuda=12.4",
  "podman=4.9.3",
  "systemd=255",
  "linger=yes",
  "sudo=yes",
  "reaches_control=200",
].join("\n");

/** A machine behind a fake SSH layer: its host key can change, and every call is recorded. */
function fakeMachine(facts = FACTS) {
  const state = {
    hostKey: HOST,
    calls: [] as { target: SshTarget; script: string; args: string[] }[],
  };
  const ssh: MachineSsh = {
    scanHostKeys: async (address, port) =>
      parseHostKeys(
        `${port === 22 ? address : `[${address}]:${port}`} ssh-ed25519 ${state.hostKey}\n`,
      ),
    publicKeyOf: async () => {
      throw new Error("not used");
    },
    sshScript: async (target, script, args = []) => {
      state.calls.push({ target, script, args });
      if (!target.hostKeys.some((l) => l.endsWith(state.hostKey)))
        throw new Error(
          "the machine presented a different host key from the one you trusted: control refused it",
        );
      return { code: 0, stdout: facts, stderr: "" };
    },
  };
  return { state, ssh };
}

async function control(ssh: MachineSsh, extra: Partial<ControlOptions> = {}) {
  const secrets = SecretBox.ephemeral();
  const { store, control: api } = await controlOnly({
    tokens: { rigs: {} },
    options: {
      secrets,
      machineSsh: ssh,
      publicUrl: "https://control.example.com",
      ...extra,
    },
  });
  const { page, csrfOf, post: send } = await signIn(api);
  const csrf = csrfOf(await page("/ui/settings"));
  const post = async (path: string, form: Record<string, string> | [string, string][]) =>
    decodeURIComponent(
      String(
        (
          await send(path, [["csrf", csrf], ...(Array.isArray(form) ? form : Object.entries(form))])
        ).headers.get("location"),
      ),
    );
  return { store, secrets, page, post };
}

describe("machines in Providers", () => {
  test("a machine is added, its host key trusted once, and read without changing anything", async () => {
    const m = fakeMachine();
    const s = await control(m.ssh);
    const added = await s.post("/ui/settings/add", {
      type: "ssh",
      name: "gpu-box-1",
      address: "gpu-box.example.com",
      port: "22",
      user: "thermite",
      private_key: "",
    });
    assert.match(added, /"gpu-box-1" is added. Compare its host key below/);
    // Control made the key: its public half is shown, its private half sealed.
    const machine = await s.store.machines.get("gpu-box-1");
    assert.ok(machine);
    assert.match(s.secrets.open(machine.key_sealed), /OPENSSH PRIVATE KEY/);
    let page = await s.page("/ui/settings/machines");
    assert.ok(page.includes(machine.public_key));
    assert.ok(!page.includes("PRIVATE KEY"));
    assert.match(page, /Check the host key\./);
    assert.match(page, /class="kind r">Machine</);
    // Nothing connects before the owner trusts the key.
    assert.match(
      await s.post("/ui/settings/machines/gpu-box-1/check", {}),
      /Trust the machine's host key first/,
    );
    assert.equal(m.state.calls.length, 0);
    // The key trusted must be the one the page showed.
    assert.match(
      await s.post("/ui/settings/machines/gpu-box-1/trust", {
        seen: `gpu-box.example.com ssh-ed25519 ${OTHER}`,
      }),
      /changed since the page showed it/,
    );
    const shown = /name="seen" value="([^"]+)"/.exec(page)?.[1] ?? "";
    assert.match(
      await s.post("/ui/settings/machines/gpu-box-1/trust", { seen: shown }),
      /Trusted "gpu-box-1"'s host key and read the machine/,
    );
    // The check ran the read-only script, with control's health address to reach.
    assert.equal(m.state.calls.length, 1);
    assert.equal(m.state.calls[0]?.script, CHECK_SCRIPT);
    assert.deepEqual(m.state.calls[0]?.args, ["https://control.example.com/v1/health"]);
    assert.equal(m.state.calls[0]?.target.user, "thermite");
    page = await s.page("/ui/settings/machines");
    assert.match(
      page,
      /1 × NVIDIA GeForce RTX 4090 · Ubuntu 24\.04\.1 LTS · 32 CPUs · 125 GB memory · Podman 4\.9\.3/,
    );
    assert.match(page, /GPU 0: NVIDIA GeForce RTX 4090, 24 GB, 0% busy/);
    assert.match(page, /Missing for a rig:<\/b> NVIDIA(&#39;|')s container toolkit\./);
    // Every label on the page says what it is for.
    const labels = page.match(/class="lb"/g)?.length ?? 0;
    const tips = page.match(/class="ii" tabindex="0" data-tip="[^"]+"/g)?.length ?? 0;
    assert.ok(tips === labels, `${labels} labels, ${tips} with descriptions`);
  });

  test("a changed host key is refused and shown for the owner to decide", async () => {
    const m = fakeMachine();
    const s = await control(m.ssh);
    await s.post("/ui/settings/add", {
      type: "ssh",
      name: "box",
      address: "192.0.2.10",
      port: "2222",
      user: "thermite",
    });
    const first =
      /name="seen" value="([^"]+)"/.exec(await s.page("/ui/settings/machines"))?.[1] ?? "";
    assert.equal(first, `[192.0.2.10]:2222 ssh-ed25519 ${HOST}`);
    await s.post("/ui/settings/machines/box/trust", { seen: first });
    m.state.hostKey = OTHER;
    assert.match(
      await s.page(await s.post("/ui/settings/machines/box/check", {})),
      /different host key/,
    );
    const page = await s.page("/ui/settings/machines");
    assert.match(page, /The machine now presents a different host key/);
    assert.match(page, /showing the last check/);
    // Trusting the new key is the owner's choice; then it connects again.
    const now = /name="seen" value="([^"]+)"/.exec(page)?.[1] ?? "";
    assert.equal(now, `[192.0.2.10]:2222 ssh-ed25519 ${OTHER}`);
    assert.match(
      await s.post("/ui/settings/machines/box/trust", { seen: now }),
      /read the machine/,
    );
    assert.match(await s.post("/ui/settings/machines/box/delete", {}), /"box" is deleted/);
    assert.equal(await s.store.machines.get("box"), undefined);
  });

  test("a machine with several host keys is trusted from the form a browser sends", async () => {
    const m = fakeMachine();
    const scan = m.ssh.scanHostKeys;
    m.ssh.scanHostKeys = async (address, port) => [
      ...(await scan(address, port)),
      ...parseHostKeys(`${address} ssh-ed25519 ${OTHER}\n`),
    ];
    const s = await control(m.ssh);
    await s.post("/ui/settings/add", {
      type: "ssh",
      name: "box",
      address: "192.0.2.10",
      port: "22",
      user: "thermite",
    });
    const shown =
      /name="seen" value="([^"]+)"/.exec(await s.page("/ui/settings/machines"))?.[1] ?? "";
    assert.equal(shown.split("\n").length, 2);
    // A browser sends the hidden field's line breaks as CRLF.
    assert.match(
      await s.post("/ui/settings/machines/box/trust", { seen: shown.replace(/\n/g, "\r\n") }),
      /Trusted "box"'s host key and read the machine/,
    );
    assert.equal((await s.store.machines.get("box"))?.host_keys.length, 2);
  });

  test("bad addresses, users and ports are refused before anything connects", async () => {
    const m = fakeMachine();
    const s = await control(m.ssh);
    const add = (over: Record<string, string>) =>
      s.post("/ui/settings/add", {
        type: "ssh",
        name: "box",
        address: "box.example.com",
        port: "22",
        user: "thermite",
        ...over,
      });
    assert.match(await add({ address: "-oProxyCommand=id" }), /host name or an IP address/);
    assert.match(await add({ user: "root;id" }), /Unix account name/);
    assert.match(await add({ port: "70000" }), /from 1 to 65535/);
    assert.equal((await s.store.machines.list()).length, 0);
  });

  test("an install runs only with the owner's yes, for the exact script shown, once", async () => {
    const m = fakeMachine();
    let finish: () => void = () => {};
    const ran: string[] = [];
    const base = m.ssh.sshScript;
    m.ssh.sshScript = async (target, script, args) => {
      if (script === CHECK_SCRIPT) return base(target, script, args);
      ran.push(script);
      await new Promise<void>((r) => {
        finish = r;
      });
      return { code: 0, stdout: "installed", stderr: "" };
    };
    const s = await control(m.ssh);
    await s.post("/ui/settings/add", {
      type: "ssh",
      name: "box",
      address: "box",
      port: "22",
      user: "thermite",
    });
    const seen =
      /name="seen" value="([^"]+)"/.exec(await s.page("/ui/settings/machines"))?.[1] ?? "";
    await s.post("/ui/settings/machines/box/trust", { seen });
    let page = await s.page("/ui/settings/machines");
    assert.match(
      page,
      /May control install NVIDIA&#39;s container toolkit\?|May control install NVIDIA's container toolkit\?/,
    );
    const sha =
      /name="recipe" value="nvidia_toolkit"><input type="hidden" name="sha" value="([0-9a-f]{64})"/.exec(
        page,
      )?.[1] ?? "";
    assert.equal(ran.length, 0);
    // A yes to a script other than the one shown, or to something not missing, is refused.
    assert.match(
      await s.post("/ui/settings/machines/box/install", {
        recipe: "nvidia_toolkit",
        sha: "0".repeat(64),
      }),
      /changed since the page showed it/,
    );
    assert.match(
      await s.post("/ui/settings/machines/box/install", { recipe: "podman", sha }),
      /isn't missing/,
    );
    assert.match(
      await s.post("/ui/settings/machines/box/decline", { recipe: "nvidia_toolkit" }),
      /Control won't install NVIDIA's container toolkit/,
    );
    assert.equal(ran.length, 0);
    assert.match(
      await s.post("/ui/settings/machines/box/install", { recipe: "nvidia_toolkit", sha }),
      /Installing NVIDIA's container toolkit on "box", as you allowed/,
    );
    assert.equal(ran.length, 1);
    assert.match(ran[0] ?? "", /nvidia-ctk cdi generate/);
    page = await s.page("/ui/settings/machines");
    assert.match(
      page,
      /<b>Installing NVIDIA&#39;s container toolkit<\/b>|<b>Installing NVIDIA's container toolkit<\/b>/,
    );
    assert.match(
      await s.post("/ui/settings/machines/box/install", { recipe: "nvidia_toolkit", sha }),
      /already running/,
    );
    // The approval is recorded, and can't be used again.
    const [inst] = await s.store.machines.installs("box");
    assert.equal(inst?.approved_by, "owner:ui");
    assert.equal(
      await s.store.machines.startInstall(inst?.id ?? 0, "box", "nvidia_toolkit", sha),
      false,
    );
    finish();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await s.store.machines.installs("box"))[0]?.ok, true);
    assert.match(
      await s.page("/ui/settings/machines"),
      /Last install: NVIDIA(&#39;|')s container toolkit, allowed by owner:ui, <span class="chip ok">done/,
    );
  });

  test("Add a rig enrolls the rig, deploys it over SSH, and manages it from its page", async () => {
    const m = fakeMachine();
    const scripts: string[] = [];
    const base = m.ssh.sshScript;
    m.ssh.sshScript = async (target, script, args) => {
      if (script === CHECK_SCRIPT) return base(target, script, args);
      scripts.push(script);
      return { code: 0, stdout: "started", stderr: "" };
    };
    const s = await control(m.ssh, {
      rigImages: {
        harness: "registry.example.com/thermite/harness:1",
        harnessCuda: "registry.example.com/thermite/harness-cuda:1",
        supervisor: "registry.example.com/thermite/supervisor:1",
      },
    });
    await s.post("/ui/settings/add", {
      type: "ssh",
      name: "box",
      address: "box",
      port: "22",
      user: "thermite",
    });
    const seen =
      /name="seen" value="([^"]+)"/.exec(await s.page("/ui/settings/machines"))?.[1] ?? "";
    await s.post("/ui/settings/machines/box/trust", { seen });
    const add = await s.page("/ui/rigs/add");
    assert.match(add, /name="place" value="machine:box" checked/);
    assert.match(add, /<script src="\/ui\/assets\/add-rig.js" defer>/);
    // Every field's label has its description; the wizard's steps have more besides.
    const labels = add.match(/class="lb"/g)?.length ?? 0;
    const described =
      add.match(/class="lb">[^<]*<i class="ii" tabindex="0" data-tip="[^"]+"/g)?.length ?? 0;
    assert.ok(
      labels > 0 && described === labels,
      `${labels} labels, ${described} with descriptions`,
    );
    // The GPU needs NVIDIA's toolkit first; a bad name or a taken GPU is refused.
    assert.match(
      await s.post("/ui/rigs/add", { machine: "box", rig: "box-a", gpus: "0" }),
      /needs NVIDIA's container toolkit first/,
    );
    const twice: [string, string][] = [
      ["machine", "box"],
      ["rig", "box-a"],
      ["gpus", "0"],
      ["gpus", "0"],
    ];
    assert.match(await s.post("/ui/rigs/add", twice), /Name each GPU once/);
    assert.match(
      await s.post("/ui/rigs/add", { machine: "box", rig: "Box A" }),
      /A rig's name is 2 to 40 characters of a-z, 0-9 and -/,
    );
    assert.equal((await s.store.machines.rigs()).length, 0);
    assert.equal(await s.post("/ui/rigs/add", { machine: "box", rig: "box-a" }), "/ui/rigs/box-a");
    await new Promise((r) => setTimeout(r, 20));
    // Enrolled with a token of its own; the deploy script carries it, and the units the CPU image.
    assert.ok(await s.store.enrollments.rig("box-a"));
    assert.equal(scripts.length, 1);
    assert.match(scripts[0] ?? "", /Image=registry\.example\.com\/thermite\/harness:1/);
    assert.match(scripts[0] ?? "", /Environment=CONTROL_URL=https:\/\/control\.example\.com/);
    assert.equal((await s.store.machines.rig("box-a"))?.status, "starting");
    let page = await s.page("/ui/rigs/box-a");
    assert.match(page, /Control is setting box-a up on box/);
    assert.match(page, /Enrolled with control: a token of its own/);
    assert.match(page, /Files and units written, images ready, services started/);
    assert.match(
      await s.post("/ui/rigs/add", { machine: "box", rig: "box-a" }),
      /There is a rig named box-a already/,
    );
    // Managed from its page: stop, start, and remove only with its name typed.
    assert.match(await s.post("/ui/rigs/box-a/machine/stop", {}), /ok=Stopped/);
    assert.match(
      scripts[1] ?? "",
      /systemctl --user stop thermite-box-a-supervisor\.service thermite-box-a-harness\.service/,
    );
    assert.equal((await s.store.machines.rig("box-a"))?.status, "stopped");
    assert.match(await s.post("/ui/rigs/box-a/machine/start", {}), /ok=Started/);
    assert.match(
      await s.post("/ui/rigs/box-a/machine/remove", { confirm: "remove" }),
      /Type "remove box-a"/,
    );
    // Refused while its results have not left it (goal 165), with how to get them out.
    const exports = (waiting: number) => ({ export: { remote: false, to: "control", waiting } });
    await s.store.reportedRigs.setSupervisor("box-a", exports(2));
    assert.match(
      await s.post("/ui/rigs/box-a/machine/remove", { confirm: "remove box-a" }),
      /box-a still holds results: 2 exports wait on the rig to go to control\. Use Export/,
    );
    assert.equal((await s.store.machines.rig("box-a"))?.status, "running");
    assert.equal(scripts.length, 3);
    await s.store.reportedRigs.setSupervisor("box-a", exports(0));
    assert.match(
      await s.post("/ui/rigs/box-a/machine/remove", { confirm: "remove box-a" }),
      /ok=Removed/,
    );
    assert.equal((await s.store.machines.rig("box-a"))?.status, "removed");
    assert.equal(await s.store.enrollments.rig("box-a"), undefined);
    page = await s.page("/ui/rigs/box-a");
    assert.match(page, /Removed from the machine/);
  });

  // A GPU machine ready for rigs: NVIDIA's toolkit and its CDI file are there.
  const gpuFacts = (gpu: string, arch = "x86_64") =>
    `${FACTS.replace("arch=x86_64", `arch=${arch}`).replace(/^gpu=.*$/m, gpu)}\nnvidia_ctk=1.17.3\ncdi=/etc/cdi/nvidia.yaml`;
  /** gpu-a, set up on GPU 0 of gpu-host-1 with these facts by Add a rig; the scripts it ran. */
  const gpuRig = async (
    facts: string,
    rigImages: NonNullable<ControlOptions["rigImages"]> = {
      harness: "registry.example.com/thermite/harness:1",
      harnessCuda: "registry.example.com/thermite/harness-cuda:1",
      harnessCuda13: "registry.example.com/thermite/harness-cuda13:1",
      supervisor: "registry.example.com/thermite/supervisor:1",
    },
  ) => {
    const m = fakeMachine(facts);
    const scripts: string[] = [];
    const base = m.ssh.sshScript;
    m.ssh.sshScript = async (target, script, args) => {
      if (script === CHECK_SCRIPT) return base(target, script, args);
      scripts.push(script);
      return {
        code: 0,
        stdout: script.includes("echo updated") ? "updated\n" : "started",
        stderr: "",
      };
    };
    const s = await control(m.ssh, { rigImages });
    await s.post("/ui/settings/add", {
      type: "ssh",
      name: "gpu-host-1",
      address: "gpu-host-1",
      port: "22",
      user: "thermite",
    });
    const seen =
      /name="seen" value="([^"]+)"/.exec(await s.page("/ui/settings/machines"))?.[1] ?? "";
    await s.post("/ui/settings/machines/gpu-host-1/trust", { seen });
    assert.equal(
      await s.post("/ui/rigs/add", { machine: "gpu-host-1", rig: "gpu-a", gpus: "0" }),
      "/ui/rigs/gpu-a",
    );
    await new Promise((r) => setTimeout(r, 20));
    return { s, scripts };
  };
  for (const [what, facts, image] of [
    ["an RTX 4090 takes the CUDA 12 harness", gpuFacts(FACTS_GPU), "harness-cuda:1"],
    [
      "a Blackwell GPU takes the CUDA 13 harness",
      gpuFacts("gpu=0, GPU-bbbb, NVIDIA RTX PRO 6000 Blackwell Workstation Edition, 97887, 225, 0"),
      "harness-cuda13:1",
    ],
    [
      "an arm64 machine takes the CUDA 13 harness",
      gpuFacts("gpu=0, GPU-cccc, NVIDIA GH200 480GB, 97871, 0, 0", "aarch64"),
      "harness-cuda13:1",
    ],
  ] as const) {
    test(`Add a rig on a machine: ${what} (goal 132)`, async () => {
      const { s, scripts } = await gpuRig(facts);
      assert.equal(
        (await s.store.machines.rig("gpu-a"))?.images.harness,
        `registry.example.com/thermite/${image}`,
      );
      assert.ok(scripts[0]?.includes(`Image=registry.example.com/thermite/${image}\n`));
    });
  }

  /** The harness image Update to control's version moves gpu-a onto, over SSH. */
  const updatedTo = async (s: Awaited<ReturnType<typeof gpuRig>>["s"], scripts: string[]) => {
    await ingestReport(s.store, {
      rig: "gpu-a",
      ledger_id: "ledger-gpu-a",
      cursor: 0,
      next: 0,
      summary: {},
      events: [],
    });
    assert.match(await s.post("/ui/rigs/gpu-a/update", {}), /ok=The update of gpu-a/);
    const end = Date.now() + 5000;
    while (!scripts.some((x) => x.includes("echo updated")) && Date.now() < end)
      await new Promise((r) => setTimeout(r, 10));
    return /Image=(\S+harness\S*)\n/.exec(
      scripts.find((x) => x.includes("echo updated")) ?? "",
    )?.[1];
  };
  test("Update to control's version keeps a rig on the CUDA 13 harness when the facts lose its GPU (goal 132)", async () => {
    const blackwell =
      "gpu=0, GPU-bbbb, NVIDIA RTX PRO 6000 Blackwell Workstation Edition, 97887, 225, 0";
    const { s, scripts } = await gpuRig(gpuFacts(blackwell));
    // Read again while the driver was down: the facts name no GPU.
    const facts = (await s.store.machines.get("gpu-host-1"))?.facts as Record<string, unknown>;
    await s.store.machines.setFacts("gpu-host-1", { facts: { ...facts, gpus: [] } });
    assert.equal(await updatedTo(s, scripts), "registry.example.com/thermite/harness-cuda13:1");
  });
  test("Update to control's version moves a Blackwell machine rig onto the CUDA 13 harness (goal 132)", async () => {
    const blackwell =
      "gpu=0, GPU-bbbb, NVIDIA RTX PRO 6000 Blackwell Workstation Edition, 97887, 225, 0";
    const { s, scripts } = await gpuRig(gpuFacts(blackwell));
    // Set up before control told Blackwell apart: it runs the CUDA 12 harness.
    await s.store.machines.setRigImages("gpu-a", {
      harness: "registry.example.com/thermite/harness-cuda:1",
      supervisor: "registry.example.com/thermite/supervisor:1",
    });
    assert.equal(await updatedTo(s, scripts), "registry.example.com/thermite/harness-cuda13:1");
  });
  test("Update to control's version keeps a CUDA 13 rig on CUDA 13 after control's new release (goal 132)", async () => {
    const blackwell =
      "gpu=0, GPU-bbbb, NVIDIA RTX PRO 6000 Blackwell Workstation Edition, 97887, 225, 0";
    const rigImages = {
      harness: "registry.example.com/thermite/harness:1",
      harnessCuda: "registry.example.com/thermite/harness-cuda:1",
      harnessCuda13: "registry.example.com/thermite/harness-cuda13:1",
      supervisor: "registry.example.com/thermite/supervisor:1",
    };
    const { s, scripts } = await gpuRig(gpuFacts(blackwell), rigImages);
    assert.equal((await s.store.machines.rig("gpu-a"))?.images.cuda, "13");
    // Control moved to a new release, and the facts, read while the driver was down, name no GPU.
    rigImages.harnessCuda13 = "registry.example.com/thermite/harness-cuda13:2";
    const facts = (await s.store.machines.get("gpu-host-1"))?.facts as Record<string, unknown>;
    await s.store.machines.setFacts("gpu-host-1", { facts: { ...facts, gpus: [] } });
    assert.equal(await updatedTo(s, scripts), "registry.example.com/thermite/harness-cuda13:2");
    assert.equal((await s.store.machines.rig("gpu-a"))?.images.cuda, "13");
  });
  test("A Blackwell machine rig takes the CUDA image while control has no CUDA 13 image (goal 132)", async () => {
    const blackwell =
      "gpu=0, GPU-bbbb, NVIDIA RTX PRO 6000 Blackwell Workstation Edition, 97887, 225, 0";
    const { s, scripts } = await gpuRig(gpuFacts(blackwell), {
      harness: "registry.example.com/thermite/harness:1",
      harnessCuda: "registry.example.com/thermite/harness-cuda:1",
      supervisor: "registry.example.com/thermite/supervisor:1",
    });
    const r = await s.store.machines.rig("gpu-a");
    assert.equal(r?.images.harness, "registry.example.com/thermite/harness-cuda:1");
    assert.equal(r?.images.cuda, "13");
    assert.ok(scripts[0]?.includes("Image=registry.example.com/thermite/harness-cuda:1\n"));
  });
});
