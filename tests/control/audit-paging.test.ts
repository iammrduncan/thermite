import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type ControlStore, openControlStore } from "../../src/control/store/index.ts";
import { controlOnly, RIG_TOKEN, signIn } from "../helpers/control-stack.ts";

/** Every entry, one page at a time, following one cursor until it ends. */
async function walk(
  store: ControlStore,
  way: "older" | "newer",
  start: { before?: number; after?: number },
  filter: { action?: string; mcp?: boolean } = {},
): Promise<string[]> {
  const seen: string[] = [];
  let cursor: { before?: number; after?: number } = start;
  for (let pages = 0; pages < 100; pages++) {
    const p = await store.auditLog.page(3, filter, cursor);
    seen.push(...p.entries.map((e) => e.action));
    const next = p[way];
    if (next === null) return seen;
    cursor = way === "older" ? { before: next } : { after: next };
  }
  throw new Error("the cursor never ended");
}

describe("paging through control's audit log (goal 015)", () => {
  test("pages go older and newer through every entry once, newest first, with the filters kept", async () => {
    const store = openControlStore(":memory:");
    assert.deepEqual(await store.auditLog.page(3), { entries: [], older: null, newer: null });
    for (let i = 1; i <= 10; i++) {
      await store.auditLog.add("owner:ui", `step_${i}`, { i });
      if (i % 4 === 0) await store.auditLog.add("owner:mcp", "mcp:control_log", {});
    }
    const steps = Array.from({ length: 10 }, (_, i) => `step_${10 - i}`);
    const newest = await store.auditLog.page(3, { mcp: false });
    assert.deepEqual(
      newest.entries.map((e) => e.action),
      ["step_10", "step_9", "step_8"],
    );
    assert.equal(newest.newer, null, "nothing is newer than the newest page");
    assert.equal(newest.older, newest.entries.at(-1)?.id);
    // Older, page by page, to the first entry; then newer, back up to the newest.
    assert.deepEqual(await walk(store, "older", {}, { mcp: false }), steps);
    const oldest = await store.auditLog.page(3, { mcp: false }, { after: 0 });
    assert.deepEqual(
      oldest.entries.map((e) => e.action),
      ["step_3", "step_2", "step_1"],
      "the page just after the cursor, newest first",
    );
    assert.equal(oldest.older, null);
    assert.deepEqual(await walk(store, "newer", { after: 0 }, { mcp: false }), [
      "step_3",
      "step_2",
      "step_1",
      "step_6",
      "step_5",
      "step_4",
      "step_9",
      "step_8",
      "step_7",
      "step_10",
    ]);
    // MCP calls are entries too, unless left out; an action filter pages through its own matches.
    assert.equal((await walk(store, "older", {})).length, 12);
    assert.deepEqual(await walk(store, "older", {}, { action: "step_1" }), ["step_10", "step_1"]);
    // An empty page past either end still points back at the entries.
    const top = newest.entries[0]?.id ?? 0;
    const past = await store.auditLog.page(3, {}, { after: top + 50 });
    assert.deepEqual(past, { entries: [], older: top + 51, newer: null });
    assert.deepEqual(
      (await store.auditLog.page(3, {}, { before: past.older ?? 0 })).entries.map((e) => e.action),
      ["step_10", "step_9", "mcp:control_log"],
    );
    const below = await store.auditLog.page(3, {}, { before: 1 });
    assert.deepEqual(below, { entries: [], older: null, newer: 0 });
    assert.deepEqual(
      await store.auditLog.page(3, {}, { before: 0 }),
      below,
      "never a cursor below 0",
    );
    assert.equal(
      (await store.auditLog.page(3, {}, { after: below.newer ?? 0 })).entries.at(-1)?.action,
      "step_1",
    );
  });

  test("REST pages with before and after, and refuses a cursor that is not a number", async () => {
    const { store, api } = await controlOnly({ tokens: { rigs: {} } });
    for (let i = 1; i <= 5; i++) await store.auditLog.add("owner:api", `step_${i}`, { i });
    const get = async (query: string) => {
      const r = await api("GET", `/v1/audit?${query}`);
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    type Page = { audit: { action: string }[]; older: number | null; newer: number | null };
    const first = (await get("limit=2")).body as Page;
    assert.deepEqual(
      first.audit.map((e) => e.action),
      ["step_5", "step_4"],
    );
    assert.equal(first.newer, null);
    const second = (await get(`limit=2&before=${first.older}`)).body as Page;
    assert.deepEqual(
      second.audit.map((e) => e.action),
      ["step_3", "step_2"],
    );
    const third = (await get(`limit=2&before=${second.older}`)).body as Page;
    assert.deepEqual([third.audit.map((e) => e.action), third.older], [["step_1"], null]);
    const up = (await get(`limit=2&after=${third.newer}`)).body as Page;
    assert.deepEqual(up.audit, second.audit);
    assert.deepEqual(await get("before=null"), {
      status: 400,
      body: { error: "before and after are whole numbers" },
    });
    assert.deepEqual(await get("before=3&after=1"), {
      status: 400,
      body: { error: "give before or after, not both" },
    });
  });

  test("the Audit log page shows 50 entries at a time, with Newest, Newer and Older links", async () => {
    const { store, control } = await controlOnly({ tokens: { rigs: {} } });
    for (let i = 1; i <= 650; i++) await store.auditLog.add("owner:api", `step_${i}`, { i });
    const { page } = await signIn(control);
    const shown = (html: string) =>
      [...html.matchAll(/<span class="muted xs">(step_\d+)<\/span>/g)].map((m) => m[1]);
    const link = (html: string, word: string) =>
      new RegExp(
        `<a class="btn sm" href="(/ui/audit(?:\\?(?:before|after)=\\d+)?)">${word}</a>`,
      ).exec(html)?.[1];
    // The newest page: the sign-in's entry, then the newest 49 steps; nothing newer.
    const newest = await page("/ui/audit");
    assert.deepEqual(shown(newest).slice(0, 2), ["step_650", "step_649"]);
    assert.equal(shown(newest).length, 49);
    assert.match(newest, /1–50 of 651/);
    assert.equal(link(newest, "‹ Newer"), undefined);
    const olderHref = link(newest, "Older ›");
    assert.ok(olderHref);
    const middle = await page(olderHref);
    assert.deepEqual(shown(middle).slice(0, 1), ["step_601"]);
    assert.equal(shown(middle).length, 50);
    assert.match(middle, /51–100 of 651/);
    assert.equal(link(middle, "Newest"), "/ui/audit");
    // Older, page by page, to the first entry.
    let last = middle;
    for (let pages = 0; link(last, "Older ›") && pages < 20; pages++)
      last = await page(link(last, "Older ›") as string);
    assert.deepEqual(shown(last), ["step_1"], "the first entry is on the last page");
    assert.match(last, /651–651 of 651/);
    const newerHref = link(last, "‹ Newer");
    assert.ok(newerHref);
    assert.deepEqual(shown(await page(newerHref)).slice(-1), ["step_2"]);
    // Past the newest entry, the page says so and links back.
    const empty = await page("/ui/audit?after=100000");
    assert.match(empty, /No entry matches\./);
    assert.ok(link(empty, "Older ›"));
  });

  test("the Audit log page filters by kind, who and words, and leaves MCP calls out unless asked", async () => {
    const { store, control } = await controlOnly({ tokens: { rigs: {} } });
    await store.auditLog.add("owner:ui", "command_issued", {
      id: "c-1",
      rig: "rig-a",
      kind: "pause_run",
    });
    await store.auditLog.add("owner:mcp", "mcp:list_rigs", {});
    await store.auditLog.add("rig:rig-b", "join_throttled", { rig: "rig-b" });
    await store.auditLog.add("control", "export_deleted", { rig: "rig-a", name: "x" });
    const { page, get } = await signIn(control);
    const actions = (html: string) =>
      [...html.matchAll(/<span class="muted xs">([a-z_:]+)<\/span>/g)].map((m) => m[1]);
    assert.deepEqual(
      actions(await page("/ui/audit")).filter((a) => a !== "login"),
      ["export_deleted", "join_throttled", "command_issued"],
      "no MCP call by default",
    );
    assert.deepEqual(actions(await page("/ui/audit?type=mcp")), ["mcp:list_rigs"]);
    assert.deepEqual(actions(await page("/ui/audit?type=command")), ["command_issued"]);
    assert.deepEqual(actions(await page("/ui/audit?who=rig")), ["join_throttled"]);
    assert.deepEqual(actions(await page("/ui/audit?rig=rig-a")), [
      "export_deleted",
      "command_issued",
    ]);
    assert.deepEqual(actions(await page("/ui/audit?q=deleted")), ["export_deleted"]);
    // The Commands page is the audit log's commands.
    const old = await get("/ui/commands");
    assert.deepEqual([old.status, old.headers.get("location")], [302, "/ui/audit?type=command"]);
  });

  test("a refusal that repeats is one entry, with its count and its first and last time; the rest stay", async () => {
    const { store, api, control } = await controlOnly();
    const refused = { tool: "mcp:start_run", why: "no campaign speed" };
    await store.auditLog.refusal("owner:operator", "refused", refused);
    await store.auditLog.refusal("owner:operator", "refused", refused);
    // Another caller, another reason or another action is an entry of its own.
    await store.auditLog.refusal("agent:mcp", "refused", refused);
    await store.auditLog.refusal("owner:operator", "refused", {
      ...refused,
      why: "no campaign size",
    });
    await store.auditLog.refusal("owner:operator", "refused_again", refused);
    await store.auditLog.refusal("owner:operator", "refused", refused);
    // Every other entry is kept as it comes, the same twice too.
    await store.auditLog.add("owner:ui", "rig_retired", { rig: "rig-b" });
    await store.auditLog.add("owner:ui", "rig_retired", { rig: "rig-b" });
    const entries = await store.auditLog.list(20);
    const said = entries.map((e) => [e.actor, e.action, e.count]);
    assert.deepEqual(said, [
      ["owner:ui", "rig_retired", 1],
      ["owner:ui", "rig_retired", 1],
      ["owner:operator", "refused_again", 1],
      ["owner:operator", "refused", 1],
      ["agent:mcp", "refused", 1],
      ["owner:operator", "refused", 3],
      // The test's rig-a, enrolled as control started.
      ["test", "rig_enrolled", 1],
    ]);
    const merged = entries.at(-2);
    assert.deepEqual(merged?.body, refused);
    assert.ok(merged && merged.last_at >= merged.at, "its last time is its newest");
    assert.equal(entries[0]?.last_at, entries[0]?.at, "an entry that came once has one time");

    // Over REST: a rig's call refused three times for one reason is one entry, by the rig, and a
    // page of the log gives its count and both times.
    for (let i = 0; i < 3; i++) {
      const r = await api("POST", "/v1/rigs/rig-a/supervisor", { status: "done" }, RIG_TOKEN);
      assert.equal(r.status, 400);
    }
    type Entry = { actor: string; action: string; body: { path: string }; count: number };
    const page = (await (await api("GET", "/v1/audit?limit=1")).json()) as { audit: Entry[] };
    const failed = page.audit[0] as Entry & { at: string; last_at: string };
    assert.deepEqual(
      [failed.actor, failed.action, failed.body.path, failed.count],
      ["rig:rig-a", "failed", "/v1/rigs/rig-a/supervisor", 3],
    );
    assert.ok(failed.last_at >= failed.at);
    // The Audit log page says how often, and when the last came.
    const { page: html } = await signIn(control);
    assert.match(await html("/ui/audit"), /<div class="xs">3 times, the last \d+s ago<\/div>/);
  });
  test("a request with no token, or one its route doesn't take, is one entry for each route, by control", async () => {
    const { store, control } = await controlOnly({ tokens: { read: "read-token-abcdef" } });
    const call = (path: string, token?: string, method = "GET") =>
      control.request(path, {
        method,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
    for (const rig of ["rig-a", "rig-b", "rig-c"])
      assert.equal((await call(`/v1/rigs/${rig}/git/kits/k.git/info/refs`, "wrong")).status, 401);
    assert.equal((await call("/v1/commands")).status, 401);
    assert.equal((await call("/v1/commands", "read-token-abcdef")).status, 401);
    assert.equal((await call("/mcp", "wrong", "POST")).status, 401);
    const seen = (await store.auditLog.list(10, { action: "unauthorized" })).map((e) => [
      e.actor,
      e.body,
      e.count,
    ]);
    assert.deepEqual(seen, [
      ["control", { method: "POST", route: "/mcp", token: "refused" }, 1],
      ["control", { method: "GET", route: "/v1/commands", token: "refused" }, 1],
      ["control", { method: "GET", route: "/v1/commands", token: "none" }, 1],
      ["control", { method: "GET", route: "/v1/rigs/:rig/git/kits/:repo/*", token: "refused" }, 3],
    ]);
  });
});
