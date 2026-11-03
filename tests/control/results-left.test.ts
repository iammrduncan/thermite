import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { advanceResets } from "../../src/control/lifecycle.ts";
import { exportLeft, resultsLeft } from "../../src/control/results-left.ts";
import { ControlStore } from "../../src/control/store/index.ts";
import { generateSigningKeys } from "../../src/core/commands.ts";
import { controlOnly, signIn } from "../helpers/control-stack.ts";
import { figuresCall } from "../helpers/control-store.ts";

const NAME = "20261020T120000Z-0123abcd";
const OWNER = "owner-token-abcdef";
const RIG = "rig-token-abcdef";

/** The supervisor's export figures, as its report carries them. */
const figures = (o: Record<string, unknown>) => ({
  at: new Date().toISOString(),
  export: {
    remote: false,
    to: "control",
    exports: 3,
    pushed: [],
    last_push_at: null,
    uploaded: [],
    last_upload_at: null,
    waiting: 0,
    champions_waiting: 0,
    last_error: null,
    ...o,
  },
});

/** An export started on control, with two files, none kept yet. */
function startExport(store: ControlStore) {
  store.exports.begin("rig-a", NAME, {
    manifest: { from_event: 0, through_event: 9, files: { a: "a".repeat(64), b: "b".repeat(64) } },
    files: { a: { size: 1, sha256: "a".repeat(64) }, b: { size: 1, sha256: "b".repeat(64) } },
    full: true,
    fromEvent: 0,
    throughEvent: 9,
  });
}

describe("have all results left this rig?", () => {
  test("to a results repository: only when nothing waits and the export is pushed", () => {
    const store = new ControlStore(":memory:");
    assert.deepEqual(resultsLeft(store, "rig-a"), {
      left: false,
      why: "the rig's supervisor has not reported yet",
      to: null,
      waiting: null,
      champions_waiting: null,
      reported_at: null,
    });
    store.reportedRigs.setSupervisor(
      "rig-a",
      figures({ remote: true, to: "repository", waiting: 2 }),
    );
    const two = resultsLeft(store, "rig-a");
    assert.equal(two.left, false);
    assert.equal(two.why, "2 exports wait on the rig to go to the results repository");
    assert.equal(two.to, "repository");
    assert.ok(two.reported_at);
    store.reportedRigs.setSupervisor("rig-a", figures({ remote: true, to: "repository" }));
    assert.equal(resultsLeft(store, "rig-a").left, true);
    const notYet = resultsLeft(store, "rig-a", { export: NAME });
    assert.deepEqual(
      [notYet.left, notYet.why],
      [false, `export ${NAME} is not in the results repository yet`],
    );
    store.reportedRigs.setSupervisor(
      "rig-a",
      figures({ remote: true, to: "repository", pushed: [NAME], pushed_commit: "c".repeat(40) }),
    );
    const done = resultsLeft(store, "rig-a", { export: NAME });
    assert.equal(done.left, true);
    assert.equal(done.why, "every export has left the rig: they are in the results repository");
    assert.equal(exportLeft(store, "rig-a", NAME).commit, "c".repeat(40));
    // Champion patches still on their way to control do not hold back a rig with a repository.
    store.reportedRigs.setSupervisor(
      "rig-a",
      figures({ remote: true, to: "repository", pushed: [NAME], champions_waiting: 3 }),
    );
    assert.equal(resultsLeft(store, "rig-a", { export: NAME }).left, true);
  });

  test("to control: only when control holds every file of the export, and nothing waits", () => {
    const store = new ControlStore(":memory:");
    store.reportedRigs.setSupervisor("rig-a", figures({ uploaded: [NAME] }));
    // The supervisor's word is not enough: control's own copy counts.
    assert.deepEqual(
      [resultsLeft(store, "rig-a", { export: NAME }).why],
      [`export ${NAME} has not reached control yet`],
    );
    startExport(store);
    store.exports.fileDone("rig-a", NAME, "a");
    const half = resultsLeft(store, "rig-a", { export: NAME });
    assert.equal(half.left, false);
    assert.equal(half.why, `export ${NAME} is on its way to control: 1 of 2 files arrived`);
    store.exports.fileDone("rig-a", NAME, "b");
    const all = resultsLeft(store, "rig-a", { export: NAME });
    assert.equal(all.left, true);
    assert.equal(all.to, "control");
    assert.equal(all.why, "every export has left the rig: they are on control");
    store.reportedRigs.setSupervisor("rig-a", figures({ waiting: 1 }));
    assert.equal(
      resultsLeft(store, "rig-a", { export: NAME }).why,
      "1 export waits on the rig to go to control",
    );
    store.reportedRigs.setSupervisor("rig-a", figures({ champions_waiting: 1 }));
    assert.equal(
      resultsLeft(store, "rig-a").why,
      "1 champion patch waits on the rig to go to control",
    );
  });

  test("a supervisor that does not say what waits, or has nowhere to send, never counts as done", () => {
    const store = new ControlStore(":memory:");
    store.reportedRigs.setSupervisor("rig-a", {
      export: { remote: false, exports: 1, pushed: [], last_push_at: null, last_error: null },
    });
    const old = resultsLeft(store, "rig-a");
    assert.equal(old.left, false);
    assert.match(old.why, /does not send exports to control \(an older version\)/);
    assert.equal(exportLeft(store, "rig-a", NAME).never, true);
    store.reportedRigs.setSupervisor("rig-a", { export: { remote: true, pushed: [NAME] } });
    assert.match(resultsLeft(store, "rig-a").why, /does not say what waits to leave/);
  });

  test("the owner asks over REST", async () => {
    const { store, control } = controlOnly({ tokens: { admin: OWNER, rigs: { "rig-a": RIG } } });
    store.reportedRigs.setSupervisor("rig-a", figures({}));
    startExport(store);
    const ask = (token: string) =>
      control.request(`/v1/rigs/rig-a/results-left?export=${NAME}`, {
        headers: { authorization: `Bearer ${token}` },
      });
    assert.equal((await ask(RIG)).status, 401);
    const r = (await (await ask(OWNER)).json()) as { left: boolean; why: string; to: string };
    assert.deepEqual([r.left, r.to], [false, "control"]);
    assert.match(r.why, /0 of 2 files arrived/);
  });
});

describe("a full reset of a rig without a results repository", () => {
  test("waits for control's copy of its export, then asks the owner", async () => {
    const store = new ControlStore(":memory:");
    const step = () =>
      advanceResets({
        store,
        privateKeyPem: generateSigningKeys().privateKeyPem,
        driver: undefined,
        staleAfterMs: 180_000,
      });
    store.reportedRigs.setSupervisor("rig-a", figures({}));
    const id = store.fullResets.create("rig-a", "owner:test");
    store.fullResets.update(id, { state: "verifying", export_name: NAME, through_event: 9 });
    startExport(store);
    await step();
    assert.equal(store.fullResets.open("rig-a")?.state, "verifying");
    store.exports.fileDone("rig-a", NAME, "a");
    store.exports.fileDone("rig-a", NAME, "b");
    await step();
    const r = store.fullResets.open("rig-a");
    assert.equal(r?.state, "awaiting_owner");
    assert.match(String(r?.detail), new RegExp(`export ${NAME} is on control, every file checked`));
  });

  test("fails at once when the rig has nowhere to send it", async () => {
    const store = new ControlStore(":memory:");
    store.reportedRigs.setSupervisor("rig-a", {
      export: { remote: false, exports: 1, pushed: [], last_push_at: null, last_error: null },
    });
    const id = store.fullResets.create("rig-a", "owner:test");
    store.fullResets.update(id, { state: "verifying", export_name: NAME, through_event: 9 });
    await advanceResets({
      store,
      privateKeyPem: generateSigningKeys().privateKeyPem,
      driver: undefined,
      staleAfterMs: 180_000,
    });
    const r = store.fullResets.list(1)[0];
    assert.equal(r?.state, "failed");
    assert.match(
      String(r?.detail),
      /does not send exports to control .*: its export cannot be verified/,
    );
  });
});

describe("model downloads in the rig's report and history", () => {
  test("each download that starts and ends is a step; the rig's page shows how far it is", async () => {
    const { store, control } = controlOnly({
      tokens: { admin: OWNER, rigs: { "rig-a": RIG } },
      options: { exportsDir: mkdtempSync(join(tmpdir(), "thermite-rl-")) },
    });
    const model = (o: Record<string, unknown>) => ({
      name: "llama-8b",
      path: `models/${"d".repeat(64)}`,
      sha256: "d".repeat(64),
      from: "huggingface.co (via cas-bridge.files.example)",
      state: "downloading",
      bytes: 3_200_000_000,
      total: 16_100_000_000,
      resumed_from: 0,
      started_at: "2026-10-20T10:00:00.000Z",
      updated_at: "2026-10-20T10:01:00.000Z",
      run: "run-1",
      ...o,
    });
    const report = (models: unknown[], extra: Record<string, unknown> = {}) =>
      figuresCall(store, "rig-a", {
        ...figures({ uploaded: [NAME], last_upload_at: new Date().toISOString(), waiting: 2 }),
        models,
        ...extra,
      });
    assert.equal((await report([model({})])).status, 200);
    assert.equal((await report([model({})])).status, 200, "the same download again: no new step");
    const ui = await signIn(control, OWNER);
    const page = await ui.page("/ui/rigs/rig-a");
    assert.match(
      page,
      /<dt>Models<\/dt><dd><b>llama-8b<\/b>: downloading, 3\.2 GB of 16\.1 GB \(19%\)<\/dd>/,
    );
    assert.match(
      page,
      /sent to control .* ago<\/span> · <a href="[^"]+">its exports on control<\/a> · 2 waiting to leave the rig/,
    );
    assert.equal((await report([model({ state: "done", bytes: 16_100_000_000 })])).status, 200);
    const page2 = await ui.page("/ui/rigs/rig-a");
    assert.match(page2, /<b>llama-8b<\/b>: 16\.1 GB, its SHA-256 checked/);
    const wrong = model({
      name: "other",
      path: "models/other",
      started_at: "2026-10-20T11:00:00.000Z",
      state: "refused",
      error: "Its SHA-256 is 0123, not the signed 4567.",
    });
    assert.equal(
      (await report([wrong, model({ state: "done", bytes: 16_100_000_000 })])).status,
      200,
    );
    assert.deepEqual(
      store.rigHistory.list("rig-a").map((e) => [e.step, e.ok, e.detail]),
      [
        [
          "model_started",
          true,
          "llama-8b from huggingface.co (via cas-bridge.files.example), 16.1 GB",
        ],
        ["model_done", true, "llama-8b: 16.1 GB"],
        [
          "model_started",
          true,
          "other from huggingface.co (via cas-bridge.files.example), 16.1 GB",
        ],
        ["model_refused", false, "other: Its SHA-256 is 0123, not the signed 4567."],
      ],
    );
    // The report is checked: a known field must be valid, and nothing but the known fields is
    // kept (a field a newer supervisor adds is dropped, never stored or shown).
    assert.equal((await report([model({ token: "x" })])).status, 200);
    assert.doesNotMatch(JSON.stringify(store.reportedRigs.supervisor("rig-a")), /token/);
    assert.equal((await report([model({ sha256: "not-a-hash" })])).status, 400);
  });
});
