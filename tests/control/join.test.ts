import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  joinCommand,
  joinedCommands,
  joinMachineScript,
  joinNamespaceManifest,
} from "../../src/control/join.ts";
import { SecretBox } from "../../src/control/secrets.ts";
import { controlOnly, signIn } from "../helpers/control-stack.ts";

const SECRETS = { controlToken: "rig-token-123", harnessSupervisorToken: "hs-token-456" };
const IMAGES = {
  harness: "registry.example.com/harness:1",
  supervisor: "registry.example.com/supervisor:1",
};
const plan = (o: { gpus?: number[]; root?: boolean } = {}) => ({
  rig: "box-a",
  controlUrl: "https://control.example.com",
  images: IMAGES,
  gpus: o.gpus ?? [],
  root: o.root ?? false,
  controlPublicKey: "PUBLIC KEY",
  controlFingerprint: "fp",
});

describe("join a rig yourself: what control renders", () => {
  test("the machine script checks first, then writes the same files and units as the SSH path", () => {
    const user = joinMachineScript(plan({ gpus: [0, 1] }), SECRETS);
    assert.match(user, /command -v podman/);
    assert.match(user, /loginctl show-user "\$\(id -un\)" -p Linger/);
    assert.match(user, /grep -qx 'nvidia.com\/gpu=0'/);
    assert.match(user, /grep -qx 'nvidia.com\/gpu=1'/);
    assert.ok(user.indexOf("command -v podman") < user.indexOf("mkdir -p"), "checks come first");
    assert.match(user, /rig-token-123/);
    assert.match(user, /thermite-box-a-harness\.container/);
    const root = joinMachineScript(plan({ root: true }), SECRETS);
    assert.doesNotMatch(root, /Linger/);
    assert.doesNotMatch(root, /nvidia-ctk/);
    assert.match(root, /\/etc\/containers\/systemd/);
  });

  test("on a machine without Podman the script stops before writing anything", () => {
    const dir = mkdtempSync(join(tmpdir(), "thermite-join-"));
    try {
      const script = join(dir, "join.sh");
      writeFileSync(script, joinMachineScript(plan(), SECRETS));
      const empty = join(dir, "bin");
      const r = spawnSync("/bin/sh", [script], {
        env: { PATH: empty, HOME: join(dir, "home") },
        encoding: "utf8",
      });
      assert.equal(r.status, 4);
      assert.match(r.stderr, /thermite: Podman is missing/);
      assert.ok(!existsSync(join(dir, "home")), "nothing written");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the namespace manifest has no namespace object, and carries the network rules", () => {
    const list = JSON.parse(
      joinNamespaceManifest(
        {
          rig: "box-b",
          namespace: "team-a",
          controlUrl: "https://control.example.com",
          images: IMAGES,
          gpus: 0,
          gpuMode: "device-plugin",
          storageGi: 20,
          controlPublicKey: "PUBLIC KEY",
        },
        SECRETS,
      ),
    ) as { items: { kind: string; metadata: { name: string; namespace?: string } }[] };
    const kinds = list.items.map((o) => o.kind);
    assert.ok(!kinds.includes("Namespace"));
    assert.equal(kinds.filter((k) => k === "NetworkPolicy").length, 2);
    assert.ok(list.items.every((o) => o.metadata.namespace === "team-a"));
  });

  test("the commands shown: the join command, and what the owner runs there afterwards", () => {
    const m = joinCommand("machine", {
      controlUrl: "https://control.example.com/",
      rig: "box-a",
      token: "tok",
    });
    assert.equal(
      m,
      `f=$(mktemp) && curl -fsS -H 'authorization: Bearer tok' "https://control.example.com/v1/join/box-a/script?uid=$(id -u)" -o "$f" && sh "$f"; rm -f "$f"`,
    );
    assert.equal(
      joinCommand("namespace", {
        controlUrl: "https://control.example.com",
        rig: "box-b",
        token: "tok",
        namespace: "team-a",
      }),
      `curl -fsS -H 'authorization: Bearer tok' 'https://control.example.com/v1/join/box-b/manifest' | kubectl apply -n team-a -f -`,
    );
    const user = joinedCommands("machine", "box-a", { gpus: [], images: IMAGES, root: false });
    assert.match(user.stop, /systemctl --user stop thermite-box-a-supervisor\.service/);
    assert.match(user.remove, /podman volume rm/);
    const ns = joinedCommands("namespace", "box-b", {
      gpus: 1,
      images: IMAGES,
      namespace: "team-a",
    });
    assert.match(
      ns.stop,
      /kubectl scale deployment -n team-a -l app\.kubernetes\.io\/instance=box-b --replicas=0/,
    );
  });
});

async function control(o: { rigBus?: { url: string; ca: string } } = {}) {
  const { store, control: api } = controlOnly({
    tokens: { rigs: {} },
    options: {
      secrets: SecretBox.ephemeral(),
      publicUrl: "https://control.example.com",
      rigBus: o.rigBus,
      rigImages: {
        harness: IMAGES.harness,
        harnessCuda: "registry.example.com/harness-cuda:1",
        supervisor: IMAGES.supervisor,
      },
    },
  });
  const { page, csrfOf, post: send } = await signIn(api);
  const csrf = csrfOf(await page("/ui/rigs/add"));
  const post = (path: string, form: Record<string, string>) => send(path, { csrf, ...form });
  const where = async (r: Response) => decodeURIComponent(String(r.headers.get("location")));
  const fetchJoin = (path: string, token: string) =>
    api.request(path, { headers: { authorization: `Bearer ${token}` } });
  /** The join command's token, as the page shows it once. */
  const tokenOf = (html: string) => /Bearer ([A-Za-z0-9_-]{43})/.exec(html)?.[1] ?? "";
  return { store, page, post, where, fetchJoin, tokenOf };
}

describe("join a rig yourself: the dashboard and /v1/join", () => {
  test("a machine: the command is shown once, works once, and the rig's token is in what it fetches", async () => {
    const s = await control();
    const add = await s.page("/ui/rigs/add");
    assert.match(add, /A machine you set it up on yourself/);
    assert.match(add, /A Kubernetes namespace you apply it to yourself/);
    assert.match(
      await s.where(
        await s.post("/ui/rigs/add", { place: "join:machine", rig: "box-a", j_gpus: "0,0" }),
      ),
      /Name each GPU once/,
    );
    assert.match(
      await s.where(
        await s.post("/ui/rigs/add", {
          place: "join:machine",
          rig: "box-a",
          j_gpus: "0,1,2",
          j_judge: "3",
        }),
      ),
      /With 3 GPUs the judge takes 1 to 2 of them/,
    );
    const made = await s.post("/ui/rigs/add", {
      place: "join:machine",
      rig: "box-a",
      j_gpus: "1, 0",
    });
    assert.equal(made.status, 200);
    const html = await made.text();
    const token = s.tokenOf(html);
    assert.ok(token, "the page shows the join command");
    assert.match(html, /Shown once: copy it now/);
    assert.match(html, /\/v1\/join\/box-a\/script\?uid=\$\(id -u\)/);
    assert.match(html, /GPU 0 \(judge\), GPU 1 \(agents\)/);
    // Control keeps only a hash: the page doesn't show the command again.
    const again = await s.page("/ui/rigs/box-a");
    assert.ok(!again.includes(token));
    assert.match(again, /A join command waits, until/);
    assert.match(
      await s.where(await s.post("/ui/rigs/add", { place: "join:machine", rig: "box-a" })),
      /There is a rig named box-a already/,
    );

    // A wrong token, the wrong form and a rig that waits for none all get one answer, and none
    // of them uses the join command.
    const refused = async (path: string, t: string) => {
      const r = await s.fetchJoin(path, t);
      return [r.status, await r.text(), r.headers.get("cache-control")];
    };
    const no = await refused("/v1/join/box-a/script", "wrong");
    assert.deepEqual(no, [
      401,
      "thermite: this join command does not work: it was used, revoked or expired. Make a new one on the rig's page in Thermite.\n",
      "no-store",
    ]);
    assert.deepEqual(await refused("/v1/join/box-a/manifest", token), no);
    assert.deepEqual(await refused("/v1/join/box-z/script", token), no);
    const got = await s.fetchJoin("/v1/join/box-a/script?uid=1000", token);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("cache-control"), "no-store");
    assert.equal(got.headers.get("x-content-type-options"), "nosniff");
    const script = await got.text();
    assert.match(script, /command -v podman/);
    assert.match(script, /AddDevice=nvidia.com\/gpu=0/);
    assert.match(script, /registry\.example\.com\/harness-cuda:1/);
    const rigToken =
      /control-rig-token" <<'THERMITE_EOF_[0-9a-f]+'\n(.+)\n/.exec(script)?.[1] ?? "";
    assert.ok(
      s.store.enrollments.tokenMatches("box-a", rigToken),
      "the script carries the rig's own token",
    );
    // Used once: it stops working.
    const twice = await s.fetchJoin("/v1/join/box-a/script?uid=1000", token);
    assert.equal(twice.status, 401);
    assert.match(await twice.text(), /it was used, revoked or expired/);
    const after = await s.page("/ui/rigs/box-a");
    assert.match(after, /fetched its files from control/);
    assert.match(after, /Join command used: the rig fetched its files from control/);
    assert.match(after, /systemctl --user stop thermite-box-a-supervisor\.service/);

    // A new command for setting it up again gives the rig a new token when it is used.
    const fresh = s.tokenOf(await (await s.post("/ui/rigs/box-a/join/new", {})).text());
    assert.ok(fresh && fresh !== token);
    const second = await (await s.fetchJoin("/v1/join/box-a/script?uid=0", fresh)).text();
    assert.ok(
      !s.store.enrollments.tokenMatches("box-a", rigToken),
      "the old rig token stopped working",
    );
    assert.match(second, /\/etc\/containers\/systemd/);

    assert.match(
      await s.where(await s.post("/ui/rigs/box-a/join/retire", { confirm: "nope" })),
      /Type "retire box-a"/,
    );
    assert.match(
      await s.where(await s.post("/ui/rigs/box-a/join/retire", { confirm: "retire box-a" })),
      /box-a is retired: its token no longer works/,
    );
    assert.equal(s.store.enrollments.rig("box-a"), undefined);
    assert.match(await s.page("/ui/rigs/box-a"), /box-a is retired/);

    // Four GPUs, one for the judge: the lowest-numbered is the judge's, the rest the agents'.
    const four = await (
      await s.post("/ui/rigs/add", {
        place: "join:machine",
        rig: "box-m",
        j_gpus: "3,1,2,0",
        j_judge: "1",
      })
    ).text();
    assert.match(four, /GPU 0 \(judge\), GPU 1 \(agents\), GPU 2 \(agents\), GPU 3 \(agents\)/);
    const units = await (
      await s.fetchJoin("/v1/join/box-m/script?uid=1000", s.tokenOf(four))
    ).text();
    assert.match(units, /^Environment=THERMITE_GPUS=0,1,2,3$/m);
    assert.match(units, /^Environment=THERMITE_JUDGE_GPUS=1$/m);
    assert.match(units, /grep -qx 'nvidia.com\/gpu=3'/);
  });

  test("a namespace: the manifest is applied with the operator's rights; expired and revoked commands don't work", async () => {
    const s = await control();
    assert.match(
      await s.where(
        await s.post("/ui/rigs/add", {
          place: "join:namespace",
          rig: "box-b",
          j_namespace: "team-a",
          j_k_gpus: "2",
          j_mode: "dra",
        }),
      ),
      /Name the DRA device class/,
    );
    const html = await (
      await s.post("/ui/rigs/add", {
        place: "join:namespace",
        rig: "box-b",
        j_namespace: "team-a",
        j_k_gpus: "2",
        j_mode: "dra",
        j_class: "gpu.nvidia.com",
        j_size: "50",
      })
    ).text();
    assert.match(html, /kubectl apply -n team-a -f -/);
    const token = s.tokenOf(html);
    // Revoked: it stops working.
    assert.match(await s.where(await s.post("/ui/rigs/box-b/join/revoke", {})), /no longer works/);
    assert.equal((await s.fetchJoin("/v1/join/box-b/manifest", token)).status, 401);
    // Expired: likewise.
    const late = s.tokenOf(await (await s.post("/ui/rigs/box-b/join/new", {})).text());
    s.store.db
      .prepare("update joined_rig set join_expires_at = ? where rig = ?")
      .run("2000-01-01T00:00:00.000Z", "box-b");
    assert.equal((await s.fetchJoin("/v1/join/box-b/manifest", late)).status, 401);
    const ok = s.tokenOf(await (await s.post("/ui/rigs/box-b/join/new", {})).text());
    const got = await s.fetchJoin("/v1/join/box-b/manifest", ok);
    assert.equal(got.status, 200);
    const list = JSON.parse(await got.text()) as { items: { kind: string }[] };
    const kinds = list.items.map((o) => o.kind);
    assert.ok(!kinds.includes("Namespace"));
    assert.ok(kinds.includes("ResourceClaimTemplate"));
    assert.ok(kinds.includes("NetworkPolicy"));
    assert.ok(s.store.enrollments.rig("box-b"));
    assert.match(await s.page("/ui/rigs/box-b"), /kubectl scale deployment -n team-a/);
  });

  test("a client whose join requests keep failing waits a minute, and the audit log says so once", async () => {
    const s = await control();
    const html = await (
      await s.post("/ui/rigs/add", { place: "join:machine", rig: "box-c", j_gpus: "1, 0" })
    ).text();
    const token = s.tokenOf(html);
    assert.ok(token);
    for (let i = 0; i < 20; i++)
      assert.equal((await s.fetchJoin("/v1/join/box-c/script", `wrong-${i}`)).status, 401);
    const held = await s.fetchJoin("/v1/join/box-c/script", token);
    assert.equal(held.status, 429);
    assert.equal(await held.text(), "thermite: too many join requests failed; wait a minute\n");
    assert.equal(s.store.auditLog.list(5, { action: "join_throttled" }).length, 1);
    // The command itself was not used: it waits for the rig.
    assert.match(await s.page("/ui/rigs/box-c"), /A join command waits, until/);
  });

  test("with the message bus, what a join fetches gives the supervisor the bus and control's authority", async () => {
    const bus = { url: "nats://control.example.com:4222", ca: "-----BEGIN CERTIFICATE-----\nca\n" };
    const s = await control({ rigBus: bus });
    // Add a rig says where the rig will reach the bus.
    assert.match(await s.page("/ui/rigs/add"), /nats:\/\/control\.example\.com:4222/);
    assert.match(await (await control()).page("/ui/rigs/add"), /off: the rig reports over HTTP/);
    const machine = s.tokenOf(
      await (await s.post("/ui/rigs/add", { place: "join:machine", rig: "box-a" })).text(),
    );
    const script = await (await s.fetchJoin("/v1/join/box-a/script?uid=1000", machine)).text();
    assert.match(script, /^Environment=THERMITE_NATS_URL=nats:\/\/control\.example\.com:4222$/m);
    assert.match(script, /^Environment=THERMITE_NATS_CA_FILE=\/keys\/bus-ca\.pem$/m);
    assert.match(
      script,
      /\/bus\/bus-ca\.pem" <<'THERMITE_EOF_[0-9a-f]+'\n-----BEGIN CERTIFICATE-----\nca\n/,
    );
    const ns = s.tokenOf(
      await (
        await s.post("/ui/rigs/add", {
          place: "join:namespace",
          rig: "box-b",
          j_namespace: "team-a",
        })
      ).text(),
    );
    const manifest = await (await s.fetchJoin("/v1/join/box-b/manifest", ns)).text();
    type Item = {
      kind: string;
      metadata: { name: string };
      spec?: { template: { spec: { containers: { env: { name: string; value: string }[] }[] } } };
    };
    const items = (JSON.parse(manifest) as { items: Item[] }).items;
    const supervisor = items.find((o) => o.metadata.name === "thermite-box-b-supervisor");
    const env = Object.fromEntries(
      (supervisor?.spec?.template.spec.containers[0]?.env ?? []).map((e) => [e.name, e.value]),
    );
    assert.equal(env.THERMITE_NATS_URL, bus.url);
    assert.equal(env.THERMITE_NATS_CA, bus.ca);
  });
});
