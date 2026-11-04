import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { makeDeployKey } from "../../../src/control/git-keys.ts";
import { CHECK_SCRIPT } from "../../../src/control/machines/facts.ts";
import { type MachineSsh, parseHostKeys } from "../../../src/control/machines/ssh.ts";
import { SecretBox } from "../../../src/control/secrets.ts";
import { controlOnly, signIn } from "../../helpers/control-stack.ts";
import { ingestReport } from "../../helpers/control-store.ts";

/**
 * Goal 206, step 4c: control sets a rig's runner process up on a machine over SSH, as Quadlet
 * units named for the runner, started as a runner with a token of its own, on one GPU of the
 * machine; then it gives the runner to the rig. A GPU a rig or another runner uses is refused.
 */

const HOST = makeDeployKey("host").publicKey.split(" ")[1] as string;
const FACTS = [
  "os=Ubuntu 24.04.1 LTS",
  "arch=aarch64",
  "cpus=20",
  "mem_kib=125000000",
  "disk_free_kib=1610612736",
  "user=thermite",
  "gpu=0, GPU-aaaa, NVIDIA GB10, 122000, 412, 0",
  "driver=580.95",
  "cuda=13.0",
  "podman=5.4.0",
  "systemd=255",
  "linger=yes",
  "sudo=yes",
  "nvidia_ctk=1.17.8",
  "cdi=/etc/cdi/nvidia.yaml",
  "reaches_control=200",
].join("\n");

async function withMachine() {
  const scripts: string[] = [];
  const ssh: MachineSsh = {
    scanHostKeys: async (address) => parseHostKeys(`${address} ssh-ed25519 ${HOST}\n`),
    publicKeyOf: async () => {
      throw new Error("not used");
    },
    sshScript: async (_target, script) => {
      if (script === CHECK_SCRIPT) return { code: 0, stdout: FACTS, stderr: "" };
      scripts.push(script);
      return { code: 0, stdout: "started", stderr: "" };
    },
  };
  const { store, control: api } = controlOnly({
    tokens: { rigs: {} },
    options: {
      secrets: SecretBox.ephemeral(),
      machineSsh: ssh,
      publicUrl: "https://control.example.com",
      rigImages: {
        harness: "registry.example.com/thermite/harness:1",
        harnessCuda: "registry.example.com/thermite/harness-cuda:1",
        harnessCuda13: "registry.example.com/thermite/harness-cuda13:1",
        supervisor: "registry.example.com/thermite/supervisor:1",
      },
    },
  });
  const { page, csrfOf, post: send } = await signIn(api);
  const csrf = csrfOf(await page("/ui/settings"));
  const post = async (path: string, form: Record<string, string>) =>
    decodeURIComponent(
      String((await send(path, [["csrf", csrf], ...Object.entries(form)])).headers.get("location")),
    );
  await post("/ui/settings/add", {
    type: "ssh",
    name: "spark-02",
    address: "spark-02",
    port: "22",
    user: "thermite",
  });
  const seen = /name="seen" value="([^"]+)"/.exec(await page("/ui/settings/machines"))?.[1] ?? "";
  await post("/ui/settings/machines/spark-02/trust", { seen });
  store.enrollments.enroll("core-1", "a".repeat(64), "test");
  await ingestReport(store, {
    rig: "core-1",
    ledger_id: "ledger-core-1",
    cursor: 0,
    next: 0,
    generated_at: new Date().toISOString(),
    events: [],
    summary: { settings: { lanes: 2, promotion: "auto", runners: [] } },
  });
  return { store, page, post, scripts };
}

describe("a rig's runner process on a machine over SSH (goal 206)", () => {
  test("its units go by its own name and start as a runner; it is given to the rig", async () => {
    const s = await withMachine();
    const edit = await s.page("/ui/rigs/core-1/edit");
    assert.match(edit, /value="@machine\|spark-02\|0">spark-02 › over SSH › GPU 0 · NVIDIA GB10/);
    const said = await s.post("/ui/rigs/core-1/runners", {
      runner: "spark-02",
      where: "@machine|spark-02|0",
      gpus: "1",
      pool: "judge",
    });
    assert.match(said, /Control sets spark-02 up on spark-02, on its GPU 0/);
    for (let i = 0; i < 100 && !s.scripts.length; i++) await new Promise((r) => setTimeout(r, 20));
    const deploy = s.scripts[0] ?? "";
    assert.match(deploy, /thermite-core-1-spark-02-harness\.container/);
    assert.match(deploy, /Environment=THERMITE_RIG_ID=core-1/);
    assert.match(deploy, /Environment=THERMITE_ROLE=runner/);
    assert.match(deploy, /Environment=THERMITE_RUNNER=spark-02/);
    assert.match(deploy, /AddDevice=nvidia\.com\/gpu=0/);
    assert.match(deploy, /harness-cuda13:1/, "the GB10, arm64: the CUDA 13 harness");
    const r = s.store.rigRunners.get("core-1", "spark-02");
    assert.equal(r?.placement, "machine");
    assert.equal(r?.spec.gpuIndex, 0);
    for (let i = 0; i < 100 && !s.store.commands.pending("core-1").length; i++)
      await new Promise((done) => setTimeout(done, 20));
    assert.deepEqual(
      s.store.commands
        .pending("core-1")
        .filter((c) => c.envelope.kind === "rig_settings")
        .map((c) => c.envelope.payload),
      [{ runners: [{ name: "spark-02", pools: ["judge"] }] }],
    );
    // Its GPU is taken now: another runner on it is refused.
    assert.match(
      await s.post("/ui/rigs/core-1/runners", {
        runner: "spark-02-b",
        where: "@machine|spark-02|0",
        gpus: "1",
        pool: "shared",
      }),
      /GPU 0 of spark-02 is used by runner spark-02 of core-1/,
    );
  });
});
