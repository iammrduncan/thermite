import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { type KbItemWire, untoldKinds } from "../../src/core/kb.ts";
import { createHarnessApi } from "../../src/harness/api/index.ts";
import { itemPath } from "../../src/harness/knowledge.ts";
import {
  emptyKbSyncState,
  type KbSyncConfig,
  syncKnowledgeOnce,
} from "../../src/supervisor/kb-sync.ts";
import { makeHarnessEnv } from "../helpers/harness-env.ts";
import { kbFile } from "../helpers/kb-file.ts";

const tokens = { supervisor: "sup-token", proposer: "prop-token" };
const RUN = "smoke-1";

const item = (seq: number, over: Partial<KbItemWire> = {}): KbItemWire => ({
  seq,
  campaign: "kernels",
  rig: "rig-b",
  run: "kernels-7",
  kind: "note",
  ref: String(seq),
  title: `note ${seq}`,
  body: `The body of note ${seq}.`,
  by: "lane-1",
  url: null,
  sub: "lesson",
  at: "2026-10-16T00:00:00.000Z",
  updated_at: "2026-10-16T00:00:00.000Z",
  ...over,
});

/**
 * A fake control that serves the items of the collections a run may read after a cursor, `page` at a
 * time (and records each ask), and the real harness API behind the supervisor's token.
 */
async function setup(items: KbItemWire[], page = 2) {
  const env = makeHarnessEnv();
  const out = await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
  const api = createHarnessApi(env.service, tokens);
  const asked: string[] = [];
  const collections = ["smoke-matmul", "kernels"];
  let harnessDown = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "control") {
      asked.push(`${url.pathname}${url.search}`);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer rig-token");
      const after = Number(url.searchParams.get("after"));
      const next = items
        .filter((i) => i.seq > after && collections.includes(i.campaign))
        .slice(0, page);
      return Response.json({
        campaign: "smoke-matmul",
        collections,
        items: next,
        next: next.at(-1)?.seq ?? after,
        more: items.some(
          (i) => i.seq > (next.at(-1)?.seq ?? after) && collections.includes(i.campaign),
        ),
      });
    }
    if (harnessDown && url.pathname === "/v1/kb") return new Response("down", { status: 503 });
    return api.request(`${url.pathname}${url.search}`, init as RequestInit);
  };
  const cfg: KbSyncConfig = {
    rig: "rig-a",
    controlUrl: "http://control",
    controlToken: "rig-token",
    harnessUrl: "http://harness",
    harnessToken: tokens.supervisor,
    fetchImpl,
  };
  const dir = env.service.knowledge.dir(RUN);
  return {
    env,
    cfg,
    asked,
    dir,
    collections,
    down: (v: boolean) => {
      harnessDown = v;
    },
  };
}

describe("past research, synced from control into the run's folder", () => {
  test("items reach knowledge/ page by page, the cursor moves, and a second call asks only for what is new", async () => {
    const items = [
      item(1),
      item(2, { kind: "experiment", ref: "x-0123456789ab", title: "Fused dequantize" }),
      item(3, { url: "https://example.org/guide", kind: "source", ref: "s-1", sub: null }),
    ];
    const s = await setup(items);
    const r = await syncKnowledgeOnce(s.cfg, emptyKbSyncState());
    assert.deepEqual(r.errors, []);
    assert.equal(r.items, 3);
    assert.deepEqual(r.state.cursors, { [RUN]: 3 });
    assert.deepEqual(s.asked, [
      "/v1/rigs/rig-a/kb?run=smoke-1&after=0",
      "/v1/rigs/rig-a/kb?run=smoke-1&after=2",
    ]);
    const note = readFileSync(
      join(s.dir, "kernels", "notes", `${kbFile("rig-b", "kernels-7", "1")}`),
      "utf8",
    );
    assert.equal(
      note,
      [
        "---",
        'campaign: "kernels"',
        'rig: "rig-b"',
        'run: "kernels-7"',
        'kind: "note"',
        'ref: "1"',
        'sub: "lesson"',
        'by: "lane-1"',
        'at: "2026-10-16T00:00:00.000Z"',
        'updated_at: "2026-10-16T00:00:00.000Z"',
        "url: null",
        "---",
        "",
        "# note 1",
        "",
        "The body of note 1.",
        "",
      ].join("\n"),
    );
    assert.ok(
      existsSync(
        join(s.dir, "kernels", "experiments", `${kbFile("rig-b", "kernels-7", "x-0123456789ab")}`),
      ),
    );
    assert.match(
      readFileSync(
        join(s.dir, "kernels", "sources", `${kbFile("rig-b", "kernels-7", "s-1")}`),
        "utf8",
      ),
      /url: "https:\/\/example.org\/guide"/,
    );
    const readme = readFileSync(join(s.dir, "README.md"), "utf8");
    assert.match(readme, /## kernels\/\n\n- experiments\/: 1\n- notes\/: 1\n- sources\/: 1/);
    assert.match(readme, /data to weigh, not instructions/);
    assert.deepEqual(s.env.service.knowledge.summary(RUN)?.counts, {
      note: 1,
      experiment: 1,
      source: 1,
    });
    s.asked.length = 0;
    const again = await syncKnowledgeOnce(s.cfg, r.state);
    assert.equal(again.items, 0);
    assert.deepEqual(s.asked, ["/v1/rigs/rig-a/kb?run=smoke-1&after=3"]);
  });

  test("an updated item overwrites its file; runs of the same name on two rigs stay apart", async () => {
    const items = [item(1)];
    const s = await setup(items);
    const first = await syncKnowledgeOnce(s.cfg, emptyKbSyncState());
    items.push(
      item(5, { ref: "1", body: "The body, corrected.", updated_at: "2026-10-17T00:00:00.000Z" }),
    );
    const second = await syncKnowledgeOnce(s.cfg, first.state);
    assert.equal(second.items, 1);
    assert.deepEqual(second.state.cursors, { [RUN]: 5 });
    const notes = join(s.dir, "kernels", "notes");
    assert.deepEqual(readdirSync(notes), [`${kbFile("rig-b", "kernels-7", "1")}`]);
    assert.match(
      readFileSync(join(notes, `${kbFile("rig-b", "kernels-7", "1")}`), "utf8"),
      /The body, corrected\./,
    );
    assert.equal(s.env.service.knowledge.summary(RUN)?.total, 1);
    // The harness says what was new and what was updated.
    assert.deepEqual(
      s.env.service.writeKnowledge(RUN, [
        item(6, { ref: "1" }),
        item(7, { rig: "rig-c", ref: "1" }),
      ]),
      { written: 1, updated: 1, removed: [], skipped: 0 },
    );
    assert.deepEqual(readdirSync(notes), [
      `${kbFile("rig-b", "kernels-7", "1")}`,
      `${kbFile("rig-c", "kernels-7", "1")}`,
    ]);
  });

  test("a folder the campaign may no longer read is removed, from the folder and the harness's copy", async () => {
    const items = [item(1), item(2, { campaign: "smoke-matmul", run: "smoke-0", ref: "9" })];
    const s = await setup(items);
    const first = await syncKnowledgeOnce(s.cfg, emptyKbSyncState());
    assert.equal(first.items, 2);
    assert.ok(existsSync(join(s.dir, "kernels")));
    // The owner revokes the grant: control no longer lists the folder, and sends nothing new.
    s.collections.splice(s.collections.indexOf("kernels"), 1);
    const second = await syncKnowledgeOnce(s.cfg, first.state);
    assert.deepEqual(second.errors, []);
    assert.equal(second.items, 0);
    assert.ok(!existsSync(join(s.dir, "kernels")), "the revoked folder is gone");
    assert.ok(
      existsSync(join(s.dir, "smoke-matmul", "notes", `${kbFile("rig-b", "smoke-0", "9")}`)),
    );
    const readme = readFileSync(join(s.dir, "README.md"), "utf8");
    assert.doesNotMatch(readme, /## kernels\//);
    assert.match(readme, /## smoke-matmul\//);
    assert.deepEqual(s.env.service.knowledge.summary(RUN)?.collections, ["smoke-matmul"]);
    // Scratch cleared: the harness's copy shows only what the run may still read.
    rmSync(s.dir, { recursive: true, force: true });
    s.env.service.knowledge.show(RUN);
    assert.deepEqual(readdirSync(s.dir).sort(), ["README.md", "smoke-matmul"]);
    // An empty list of folders says nothing: nothing is removed.
    assert.deepEqual(s.env.service.writeKnowledge(RUN, [], []).removed, []);
    assert.ok(existsSync(join(s.dir, "smoke-matmul")));
  });

  test("after scratch was cleared, the earlier items come back with the next ones", async () => {
    const items = [item(1)];
    const s = await setup(items);
    const first = await syncKnowledgeOnce(s.cfg, emptyKbSyncState());
    rmSync(s.dir, { recursive: true, force: true });
    items.push(item(2));
    await syncKnowledgeOnce(s.cfg, first.state);
    assert.deepEqual(readdirSync(join(s.dir, "kernels", "notes")).sort(), [
      `${kbFile("rig-b", "kernels-7", "1")}`,
      `${kbFile("rig-b", "kernels-7", "2")}`,
    ]);
  });

  test("an item's names never lead out of knowledge/", async () => {
    const s = await setup([]);
    s.env.service.writeKnowledge(RUN, [
      item(1, { campaign: "../../escape", rig: "../r", run: "../up", ref: "../../../x" }),
    ]);
    const folders = readdirSync(s.dir).filter((f) => f !== "README.md");
    assert.deepEqual(folders, ["escape"]);
    assert.deepEqual(readdirSync(join(s.dir, "escape", "notes")), [
      kbFile("../r", "../up", "../../../x"),
    ]);
    assert.match(kbFile("../r", "../up", "../../../x"), /^r--up--x--[0-9a-f]{8}\.md$/);
  });

  test("each kind has its folder, and the README counts each", async () => {
    const s = await setup([]);
    const kinds = ["run", "trial", "doc", "hypothesis", "source"] as const;
    s.env.service.writeKnowledge(
      RUN,
      kinds.map((kind, i) => item(i + 1, { kind, ref: `${kind}-1`, sub: null })),
    );
    assert.deepEqual(readdirSync(join(s.dir, "kernels")).sort(), [
      "docs",
      "hypotheses",
      "runs",
      "sources",
      "trials",
    ]);
    const readme = readFileSync(join(s.dir, "README.md"), "utf8");
    assert.match(readme, /- hypotheses\/: 1\n/);
    assert.match(readme, /- docs\/: 1\n/);
    assert.equal(
      s.env.service.knowledge.summary(RUN)?.counts.hypothesis,
      1,
      "counted under its own kind",
    );
  });

  test("a harness that cannot take the items leaves the cursor, so they come again", async () => {
    const s = await setup([item(1), item(2)]);
    s.down(true);
    const r = await syncKnowledgeOnce(s.cfg, emptyKbSyncState());
    assert.equal(r.items, 0);
    assert.match(r.errors[0] ?? "", /smoke-1: the harness's \/v1\/kb: HTTP 503/);
    assert.deepEqual(r.state.cursors, {});
    s.down(false);
    const again = await syncKnowledgeOnce(s.cfg, r.state);
    assert.equal(again.items, 2);
  });

  test("a run control did not assign is no error, and is left alone for an hour; one control has not heard of yet is asked again", async () => {
    const s = await setup([item(1)]);
    let clock = Date.parse("2026-10-20T12:00:00.000Z");
    // Control's 404 names its code when it did not assign the run; its words are for people.
    let answer: { error: string; code?: string } = {
      error: "control did not assign run smoke-1 to this rig",
      code: "not_assigned",
    };
    const fetchImpl: typeof fetch = async (input, init) => {
      if (new URL(String(input)).host !== "control")
        return (s.cfg.fetchImpl as typeof fetch)(input, init);
      s.asked.push(String(input));
      return Response.json(answer, { status: 404 });
    };
    const cfg = { ...s.cfg, fetchImpl, now: () => clock };
    const r = await syncKnowledgeOnce(cfg, emptyKbSyncState());
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.state, {
      cursors: {},
      skipped: { [RUN]: "2026-10-20T13:00:00.000Z" },
    });
    assert.equal(s.asked.length, 1);
    clock += 59 * 60_000;
    const later = await syncKnowledgeOnce(cfg, r.state);
    assert.equal(s.asked.length, 1, "not asked again within the hour");
    assert.deepEqual(later.state, r.state);
    clock += 2 * 60_000;
    answer = { error: "this rig has no run smoke-1" };
    const after = await syncKnowledgeOnce(cfg, later.state);
    assert.equal(s.asked.length, 2, "asked again after the hour");
    assert.deepEqual(after.errors, []);
    assert.deepEqual(after.state, { cursors: {} }, "not heard of yet: no skip");
    await syncKnowledgeOnce(cfg, after.state);
    assert.equal(s.asked.length, 3, "so it is asked again at the next sync");
    // Any other answer is still an error.
    const failing: typeof fetch = async (input, init) =>
      new URL(String(input)).host === "control"
        ? new Response("no", { status: 500 })
        : (s.cfg.fetchImpl as typeof fetch)(input, init);
    const bad = await syncKnowledgeOnce({ ...cfg, fetchImpl: failing }, emptyKbSyncState());
    assert.match(bad.errors[0] ?? "", /smoke-1: control's knowledge base: HTTP 500/);
  });

  test("an item of a kind this build does not know is left out and the sync goes on; once an update knows the kind, the run syncs again from the start", async () => {
    // "verdict" stands in for a kind a newer control has and this build does not.
    const newer = (seq: number) =>
      item(seq, {
        kind: "verdict" as KbItemWire["kind"],
        ref: `v-${seq}`,
        title: "From a newer control",
      });
    const s = await setup([item(1), newer(2), newer(3), item(4)]);
    const logged: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      logged.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    let r: Awaited<ReturnType<typeof syncKnowledgeOnce>>;
    try {
      r = await syncKnowledgeOnce(s.cfg, emptyKbSyncState());
    } finally {
      process.stdout.write = write;
    }
    assert.deepEqual(r.errors, []);
    assert.equal(r.items, 2);
    assert.deepEqual(r.unknownKinds, { verdict: 2 });
    // The cursor moved past them: the sync never sticks on what it cannot read.
    assert.deepEqual(r.state.cursors, { [RUN]: 4 });
    assert.deepEqual(r.state.unknown_kinds, ["verdict"]);
    assert.ok(existsSync(join(s.dir, "kernels", "notes", `${kbFile("rig-b", "kernels-7", "1")}`)));
    assert.ok(existsSync(join(s.dir, "kernels", "notes", `${kbFile("rig-b", "kernels-7", "4")}`)));
    assert.ok(!existsSync(join(s.dir, "kernels", "verdicts")));
    // The supervisor left them out, so the harness never saw one.
    assert.equal(logged.filter((l) => l.includes("unknown kind")).length, 0);
    // Each kind is told once, however often it comes.
    const told = new Set<string>();
    assert.deepEqual(untoldKinds(told, r.unknownKinds), [["verdict", 2]]);
    assert.deepEqual(untoldKinds(told, { verdict: 5, finding_v2: 1 }), [["finding_v2", 1]]);
    assert.deepEqual(untoldKinds(told, { verdict: 1 }), []);
    // Nothing new next time, and the kind is still remembered.
    s.asked.length = 0;
    const again = await syncKnowledgeOnce(s.cfg, r.state);
    assert.deepEqual(s.asked, ["/v1/rigs/rig-a/kb?run=smoke-1&after=4"]);
    assert.deepEqual(again.state.unknown_kinds, ["verdict"]);
    // After an update that knows a kind it left out ("trial" stands in for it), every run starts
    // again from 0, so the items left out arrive; a kind still unknown stays remembered.
    s.asked.length = 0;
    const updated = await syncKnowledgeOnce(s.cfg, {
      ...again.state,
      unknown_kinds: ["trial", "verdict"],
    });
    assert.deepEqual(updated.errors, []);
    assert.equal(s.asked[0], "/v1/rigs/rig-a/kb?run=smoke-1&after=0");
    assert.deepEqual(updated.state.cursors, { [RUN]: 4 });
    assert.deepEqual(updated.state.unknown_kinds, ["verdict"]);
  });

  test("the harness, too, leaves out an item of a kind it does not know, and logs the kind once", () => {
    const env = makeHarnessEnv();
    const k = env.service.knowledge;
    const logged: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      logged.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    let first: ReturnType<typeof k.write>;
    let second: ReturnType<typeof k.write>;
    try {
      const odd = { ...item(2), kind: "verdict" };
      first = k.write(RUN, [item(1), odd, odd]);
      second = k.write(RUN, [odd]);
    } finally {
      process.stdout.write = write;
    }
    assert.deepEqual(first, { written: 1, updated: 0, removed: [], skipped: 2 });
    assert.deepEqual(second, { written: 0, updated: 0, removed: [], skipped: 1 });
    const lines = logged.filter((l) => l.includes("past research of an unknown kind left out"));
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /"kind":"verdict","items":2/);
    // A known kind must still be well formed.
    assert.throws(() => k.write(RUN, [{ ...item(3), seq: -1 }]));
  });

  test("without control the sync does nothing", async () => {
    const s = await setup([item(1)]);
    let called = 0;
    const r = await syncKnowledgeOnce(
      {
        ...s.cfg,
        controlUrl: undefined,
        fetchImpl: async () => {
          called++;
          return new Response("{}");
        },
      },
      emptyKbSyncState(),
    );
    assert.equal(called, 0);
    assert.deepEqual(r, { state: { cursors: {} }, items: 0, errors: [], unknownKinds: {} });
    assert.equal(s.env.service.knowledge.summary(RUN), undefined);
  });

  test("the harness takes past research only with the supervisor's token, for a run it has", async () => {
    const s = await setup([]);
    const api = createHarnessApi(s.env.service, tokens);
    const post = (body: unknown, t: string) =>
      api.request("/v1/kb", {
        method: "POST",
        headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    assert.equal((await post({ run: RUN, items: [item(1)] }, tokens.proposer)).status, 401);
    assert.equal((await post({ run: RUN, items: [item(1)] }, "trial.x")).status, 401);
    assert.equal((await post({ run: "no-run", items: [item(1)] }, tokens.supervisor)).status, 404);
    // A kind this build does not know is left out, not refused: a newer control may send it.
    const unknown = await post(
      { run: RUN, items: [{ ...item(1), kind: "secret" }] },
      tokens.supervisor,
    );
    assert.equal(unknown.status, 200);
    assert.deepEqual(await unknown.json(), { written: 0, updated: 0, removed: [], skipped: 1 });
    assert.equal(
      (await post({ run: RUN, items: [{ ...item(1), kind: 7 }] }, tokens.supervisor)).status,
      400,
    );
    const { rig: _rig, ...noRig } = item(1);
    assert.equal(
      (await post({ run: RUN, items: [noRig] }, tokens.supervisor)).status,
      400,
      "an item names its rig",
    );
    assert.equal((await post({ run: RUN, items: [item(1)] }, tokens.supervisor)).status, 200);
  });
});

describe("two documents never share one file in knowledge/ (goal 162)", () => {
  test("names that read the same once cleaned or cut get files of their own", () => {
    const at = (ref: string) => itemPath({ campaign: "c", kind: "doc", rig: "r", run: "u", ref });
    assert.notEqual(at("lane-1/a-b.md"), at("lane-1/a/b.md"));
    const long = "x".repeat(150);
    assert.notEqual(at(`${long}-1`), at(`${long}-2`));
    assert.equal(at("lane-1/a-b.md"), at("lane-1/a-b.md"), "the same item, the same file");
  });
});
