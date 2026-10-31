import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  closedTo,
  layoutProblem,
  leftOut,
  type SnapshotArea,
  snapshotAreas,
} from "../../../../src/harness/broker/snapshot/index.ts";

/**
 * Where the rig's live state and its snapshot are: the folders apart, the rig image's settings,
 * the rigs that keep no snapshot, what a snapshot leaves out, and a folder closed to every user.
 */

const repo = (path: string) => fileURLToPath(new URL(`../../../../${path}`, import.meta.url));

describe("where the snapshot and the live state are", () => {
  test("the live folders stay off the snapshot folder, and apart", () => {
    const a = (name: SnapshotArea["name"], live: string): SnapshotArea => ({
      name,
      live,
      uid: 1,
      gid: 1,
    });
    assert.equal(
      layoutProblem("/workspace/thermite", [a("harness", "/var/lib/rig/harness")]),
      undefined,
    );
    assert.match(
      layoutProblem("/workspace/thermite", [a("harness", "/workspace/thermite/harness")]) ?? "",
      /is in the snapshot folder/,
    );
    assert.match(
      layoutProblem("/var/lib/rig", [a("harness", "/var/lib")]) ?? "",
      /snapshot folder \/var\/lib\/rig is in the harness folder/,
    );
    assert.match(
      layoutProblem("/w", [a("harness", "/s"), a("outbox", "/s/outbox")]) ?? "",
      /outbox folder \/s\/outbox is in the harness folder/,
    );
    assert.equal(layoutProblem("/w", [a("harness", "/s/h"), a("outbox", "/s/hx")]), undefined);
    assert.match(layoutProblem("relative", []) ?? "", /absolute/);
  });

  test("the rig image keeps its live state on the container's disk and its snapshot on the volume", () => {
    const text = readFileSync(repo("containers/rig/Containerfile"), "utf8");
    const env: Record<string, string> = {};
    for (const m of text.matchAll(/^\s*(?:ENV\s+)?(THERMITE_[A-Z_]+)=(\S+?)\s*\\?$/gm))
      env[m[1] as string] = m[2] as string;
    const dir = env.THERMITE_STATE_SNAPSHOT_DIR;
    assert.ok(dir, "the image sets THERMITE_STATE_SNAPSHOT_DIR");
    // RunPod's volume: where the launch mounts it (src/control/runpod/rigs.ts).
    const runpod = readFileSync(repo("src/control/runpod/rigs.ts"), "utf8");
    const volume = /const VOLUME_PATH = "([^"]+)"/.exec(runpod)?.[1];
    assert.ok(volume && dir.startsWith(`${volume}/`), `${dir} is on the pod's volume ${volume}`);
    const areas = snapshotAreas(env);
    assert.deepEqual(
      areas.map((x) => `${x.name} ${x.uid}:${x.gid}${x.only ? ` ${x.only}` : ""}`),
      [
        "harness 10010:10010",
        "outbox 10010:10001",
        "inbox 10001:10010",
        "supervisor 10001:10001",
        "secrets 0:0 supervisor-token",
      ],
    );
    assert.equal(layoutProblem(dir, areas), undefined);
    for (const x of areas)
      assert.ok(!x.live.startsWith(`${volume}/`), `${x.live} is off the volume`);
    // The pod's keys and enrollment are in the supervisor's part, so the snapshot keeps them.
    const home = areas.find((x) => x.name === "supervisor")?.live as string;
    for (const k of ["THERMITE_TUNNEL_DIR", "THERMITE_TUNNEL_ENROLLED_DIR"])
      assert.ok(env[k]?.startsWith(`${home}/`), `${k} is in the supervisor's state`);
  });

  test("compose and Kubernetes rigs keep no snapshot: nothing else sets the setting", () => {
    for (const path of [
      "compose.yaml",
      "containers/release/compose.template.yaml",
      "containers/harness/Containerfile",
      "src/control/clusters/manifests.ts",
      "src/control/machines/deploy.ts",
    ])
      assert.ok(!readFileSync(repo(path), "utf8").includes("THERMITE_STATE_SNAPSHOT_DIR"), path);
    assert.deepEqual(
      snapshotAreas({ THERMITE_STATE_DIR: "/var/lib/thermite" }).map((x) => x.name),
      ["harness", "outbox"],
    );
  });

  test("what a snapshot leaves out", () => {
    const [harness, outbox, , supervisor, secrets] = snapshotAreas({
      THERMITE_ONE_CONTAINER: "1",
      THERMITE_SUPERVISOR_TOKEN_FILE: "/s/secrets/supervisor-token",
    }) as SnapshotArea[];
    assert.equal(leftOut(harness as SnapshotArea, "ledger/ledger.db-wal"), true);
    assert.equal(leftOut(harness as SnapshotArea, "ledger/ledger.db"), false);
    assert.equal(leftOut(outbox as SnapshotArea, ".tmp-1/manifest.json"), true);
    assert.equal(leftOut(outbox as SnapshotArea, "20261022-1/manifest.json"), false);
    assert.equal(leftOut(supervisor as SnapshotArea, "tmp/x"), true);
    assert.equal(leftOut(supervisor as SnapshotArea, "tunnel/keys.json"), false);
    assert.equal(leftOut(secrets as SnapshotArea, "supervisor-token"), false);
    assert.equal(leftOut(secrets as SnapshotArea, "model-key"), true);
  });

  test("the folder must be closed to every user the broker tries", () => {
    const answers: Record<string, string> = {
      thermite: '{"list":"EACCES","create":"EACCES"}',
      supervisor: '{"list":"ALLOWED","create":"EACCES"}',
      "agent-1": "node: not found",
    };
    const seen = closedTo(Object.keys(answers), (u) => ({
      status: u === "agent-1" ? 127 : 0,
      stdout: answers[u]?.startsWith("{") ? (answers[u] as string) : "",
      stderr: answers[u]?.startsWith("{") ? "" : (answers[u] as string),
    }));
    assert.deepEqual(seen, {
      thermite: "refused (EACCES)",
      supervisor: "OPENED: lists it",
      "agent-1": "failed: exit 127 node: not found",
    });
  });
});
