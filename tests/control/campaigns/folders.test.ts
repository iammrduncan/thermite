import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { issueCommand } from "../../../src/control/issue/index.ts";
import { STYLE } from "../../../src/control/ui/style/index.ts";
import { parseContract } from "../../../src/core/contract.ts";
import { ADMIN, controlOnly, mcpClient, signIn } from "../../helpers/control-stack.ts";
import { ingestReport } from "../../helpers/control-store.ts";

/**
 * Archive a campaign, and folders for campaigns in the left navigation (goal 077): over REST, MCP
 * and the dashboard, with the same refusals in words; and the navigation without rigs.
 */

type Ev = [string, string, string, Record<string, unknown>];

const TOKENS = {
  admin: ADMIN,
  operator: "operator-token-abcdef",
  agent: "agent-token-abcdef",
  read: "read-token-abcdef",
  rigs: {},
};
const C = "9a41c07e0d1f2a3b4c5d6e7f8091a2b3c4d5e6f7";

/**
 * Control with two rigs. On rig-a: fast-sort-1 at work, old-sweep-1 finished, and wide-gemm-1
 * paused with a change waiting for the owner. On rig-b: survey-1 at work. gemv-speed is assigned
 * to rig-a and the rig has not taken it yet.
 */
async function stack() {
  const { keys, store, control, api } = controlOnly({
    tokens: TOKENS,
    options: { staleAfterMs: 600_000 },
  });
  const next = new Map<string, number>();
  const ingest = async (rig: string, events: Ev[]) => {
    const from = next.get(rig) ?? 0;
    next.set(rig, from + events.length);
    await ingestReport(store, {
      rig,
      ledger_id: `ledger-${rig}`,
      cursor: from,
      next: from + events.length,
      generated_at: new Date().toISOString(),
      events: events.map(([actor, kind, subject, body], i) => ({
        id: from + i + 1,
        at: new Date(Date.now() - (60 - from - i) * 60_000).toISOString(),
        actor,
        kind,
        subject,
        body,
      })),
      summary: {},
    });
  };
  await ingest("rig-a", [
    ["harness", "run_created", "old-sweep-1", { campaign: "old-sweep", mode: "hill_climb" }],
    ["owner", "run_status", "old-sweep-1", { status: "closed", reason: "done" }],
    ["harness", "run_created", "wide-gemm-1", { campaign: "wide-gemm", mode: "hill_climb" }],
    ["judge", "promotion_pending", "a-77", { run: "wide-gemm-1", expected_seq: 2 }],
    ["owner", "run_status", "wide-gemm-1", { status: "paused", reason: "the owner paused it" }],
    ["harness", "run_created", "fast-sort-1", { campaign: "fast-sort", mode: "hill_climb" }],
  ]);
  await ingest("rig-b", [
    ["harness", "run_created", "survey-1", { campaign: "survey", mode: "research" }],
  ]);
  const goal = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../../../examples/contracts/goal-example.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const assign = (campaign: string, run: string) => {
    const parsed = parseContract({ ...goal, campaign, version: 1 });
    assert.ok(parsed.ok);
    return issueCommand(store, keys.privateKeyPem, {
      rig: "rig-a",
      kind: "assign_campaign",
      payload: {
        run,
        contract: parsed.contract,
        contract_sha: parsed.sha,
        seed: { repo: "my-project", commit: C },
        imports: [],
      },
      issuedBy: "owner:api",
    });
  };
  const resume = (run: string) =>
    issueCommand(store, keys.privateKeyPem, {
      rig: "rig-a",
      kind: "resume_run",
      payload: { run },
      issuedBy: "owner:api",
    });
  assign("gemv-speed", "gemv-speed-1");
  const session = await signIn(control);
  const { get, csrfOf } = session;
  const page = async (path: string) => {
    const r = await get(path);
    assert.equal(r.status, 200, path);
    return r.text();
  };
  const csrf = async () => csrfOf(await page("/ui/campaigns"));
  const post = async (path: string, fields: Record<string, string>, json = false) =>
    session.post(
      path,
      { csrf: await csrf(), ...fields },
      json ? { accept: "application/json" } : {},
    );
  const audit = (action: string) =>
    store.auditLog.list(500).filter((a) => a.action === action) as {
      actor: string;
      body: Record<string, unknown>;
    }[];
  return { store, control, rest: api, page, post, get, assign, resume, audit, ingest };
}

const text = (r: unknown) =>
  ((r as { content: { text: string }[] }).content[0] as { text: string }).text;
const json = async <T>(r: Response) => (await r.json()) as T;
/** The page's left navigation. */
const sidebar = (html: string) =>
  /<aside class="sidebar"[^>]*>[\s\S]*?<\/aside>/.exec(html)?.[0] ?? "";

describe("Archive a campaign over REST (goal 077)", () => {
  test("refused in words while a run is at work or waits to start; a paused one is archived, starts no run, and is unarchived", async () => {
    const s = await stack();
    const at = await s.rest("POST", "/v1/campaigns/fast-sort/archive");
    assert.equal(at.status, 409);
    assert.deepEqual(await at.json(), {
      error: "Pause or close its runs first. fast-sort-1 is at work on rig-a.",
    });
    const waits = await s.rest("POST", "/v1/campaigns/gemv-speed/archive");
    assert.equal(waits.status, 409);
    assert.deepEqual(await waits.json(), {
      error: "Pause or close its runs first. gemv-speed-1 waits to start on rig-a.",
    });
    // A resume sent for a paused run waits too, until the rig takes it.
    const resumed = s.resume("wide-gemm-1");
    const r1 = await s.rest("POST", "/v1/campaigns/wide-gemm/archive");
    assert.equal(r1.status, 409);
    assert.match(
      (await json<{ error: string }>(r1)).error,
      /wide-gemm-1 waits to start on rig-a\./,
    );
    assert.ok(s.store.commands.cancel(resumed.id, "owner:ui"));
    const refusals = s.audit("refused").map((a) => a.body.path);
    assert.ok(refusals.includes("/v1/campaigns/fast-sort/archive"));
    assert.ok(refusals.includes("/v1/campaigns/gemv-speed/archive"));

    const ok = await s.rest("POST", "/v1/campaigns/wide-gemm/archive");
    assert.equal(ok.status, 200);
    const a = await json<Record<string, unknown>>(ok);
    assert.equal(a.campaign, "wide-gemm");
    assert.equal(a.archived, true);
    assert.equal(a.by, "owner:api");
    assert.equal(a.changed, true);
    assert.equal(
      (await json<{ changed: boolean }>(await s.rest("POST", "/v1/campaigns/wide-gemm/archive")))
        .changed,
      false,
    );
    assert.deepEqual(
      s.audit("campaign_archived").map((x) => [x.actor, x.body.campaign]),
      [["owner:api", "wide-gemm"]],
    );
    // An archived campaign starts and resumes no run, on any path that signs one.
    assert.throws(
      () => s.resume("wide-gemm-1"),
      /^Error: wide-gemm is archived\. Unarchive it first\.$/,
    );
    assert.throws(
      () => s.assign("wide-gemm", "wide-gemm-2"),
      /wide-gemm is archived\. Unarchive it first\./,
    );
    const listed = await json<{ archived: { campaign: string; by: string }[] }>(
      await s.rest("GET", "/v1/campaign-folders"),
    );
    assert.deepEqual(
      listed.archived.map((x) => [x.campaign, x.by]),
      [["wide-gemm", "owner:api"]],
    );

    const back = await s.rest("POST", "/v1/campaigns/wide-gemm/unarchive");
    assert.equal(back.status, 200);
    assert.deepEqual(await back.json(), {
      campaign: "wide-gemm",
      archived: false,
      at: null,
      by: null,
      folder: null,
      changed: true,
    });
    assert.equal(s.audit("campaign_unarchived").length, 1);
    assert.ok(s.resume("wide-gemm-1").id);

    const none = await s.rest("POST", "/v1/campaigns/no-such/archive");
    assert.equal(none.status, 404);
    assert.deepEqual(await none.json(), { error: "Control has no campaign named no-such." });
    assert.equal(
      (await s.rest("POST", "/v1/campaigns/old-sweep/archive", undefined, "")).status,
      401,
    );
  });
});

describe("Folders for campaigns over REST (goal 077)", () => {
  test("make, refuse a taken or bad name, move, rename, refuse deleting a folder with campaigns, delete an empty one", async () => {
    const s = await stack();
    const made = await s.rest("POST", "/v1/campaign-folders", { name: " Kernels " });
    assert.equal(made.status, 201);
    assert.equal((await json<{ folder: { name: string } }>(made)).folder.name, "Kernels");
    const taken = await s.rest("POST", "/v1/campaign-folders", { name: "kernels" });
    assert.equal(taken.status, 409);
    assert.deepEqual(await taken.json(), { error: "There is a folder named Kernels already." });
    const empty = await s.rest("POST", "/v1/campaign-folders", { name: "  " });
    assert.equal(empty.status, 400);
    assert.deepEqual(await empty.json(), { error: "Give the folder a name." });
    const long = await s.rest("POST", "/v1/campaign-folders", { name: "x".repeat(41) });
    assert.deepEqual(await long.json(), { error: "A folder's name is at most 40 characters." });
    const odd = await s.rest("POST", "/v1/campaign-folders", { title: "Kernels" });
    assert.equal(odd.status, 400);
    assert.match((await json<{ error: string }>(odd)).error, /^bad request: /);

    const moved = await s.rest("POST", "/v1/campaigns/fast-sort/folder", { folder: "kernels" });
    assert.equal(moved.status, 200);
    assert.deepEqual(await moved.json(), {
      campaign: "fast-sort",
      folder: "Kernels",
      changed: true,
    });
    const nowhere = await s.rest("POST", "/v1/campaigns/fast-sort/folder", { folder: "Research" });
    assert.equal(nowhere.status, 404);
    assert.deepEqual(await nowhere.json(), { error: "There is no folder named Research." });
    assert.equal(
      (await s.rest("POST", "/v1/campaigns/no-such/folder", { folder: "Kernels" })).status,
      404,
    );

    const renamed = await s.rest("POST", "/v1/campaign-folders/Kernels/rename", {
      name: "Fast kernels",
    });
    assert.equal(renamed.status, 200);
    const rn = await json<{ folder: { name: string; campaigns: string[] }; was: string }>(renamed);
    assert.deepEqual(
      [rn.folder.name, rn.folder.campaigns, rn.was],
      ["Fast kernels", ["fast-sort"], "Kernels"],
    );
    await s.rest("POST", "/v1/campaign-folders", { name: "Research" });
    const clash = await s.rest("POST", "/v1/campaign-folders/Research/rename", {
      name: "fast KERNELS",
    });
    assert.equal(clash.status, 409);

    const full = await s.rest("POST", "/v1/campaign-folders/Fast%20kernels/delete");
    assert.equal(full.status, 409);
    assert.deepEqual(await full.json(), {
      error: "Fast kernels is not empty. Move its campaign out first: fast-sort.",
    });
    const out = await s.rest("POST", "/v1/campaigns/fast-sort/folder", { folder: null });
    assert.deepEqual(await out.json(), { campaign: "fast-sort", folder: null, changed: true });
    const gone = await s.rest("POST", "/v1/campaign-folders/Fast%20kernels/delete");
    assert.equal(gone.status, 200);
    assert.deepEqual(await gone.json(), { deleted: "Fast kernels" });

    // An archived campaign keeps its folder (the owner, 2026-10-21), and comes back into it.
    await s.rest("POST", "/v1/campaigns/old-sweep/folder", { folder: "Research" });
    const archived = await json<{ folder: string | null }>(
      await s.rest("POST", "/v1/campaigns/old-sweep/archive"),
    );
    assert.equal(archived.folder, "Research");
    const listed = await json<{
      folders: { name: string; campaigns: string[] }[];
      archived: { campaign: string; folder: string | null }[];
    }>(await s.rest("GET", "/v1/campaign-folders"));
    assert.deepEqual(
      listed.folders.map((f) => [f.name, f.campaigns]),
      [["Research", ["old-sweep"]]],
    );
    assert.deepEqual(
      listed.archived.map((a) => [a.campaign, a.folder]),
      [["old-sweep", "Research"]],
    );
    // A folder that holds only an archived campaign is not empty: refused in words.
    const kept = await s.rest("POST", "/v1/campaign-folders/Research/delete");
    assert.equal(kept.status, 409);
    assert.deepEqual(await kept.json(), {
      error: "Research is not empty. Move its campaign out first: old-sweep (archived).",
    });
    const back = await json<{ archived: boolean; folder: string | null; changed: boolean }>(
      await s.rest("POST", "/v1/campaigns/old-sweep/unarchive"),
    );
    assert.deepEqual([back.archived, back.folder, back.changed], [false, "Research", true]);
    assert.deepEqual(s.audit("campaign_unarchived")[0]?.body, {
      campaign: "old-sweep",
      folder: "Research",
    });
    // An archived campaign may move: it comes back into its new folder, or into none.
    await s.rest("POST", "/v1/campaigns/old-sweep/archive");
    const outOf = await s.rest("POST", "/v1/campaigns/old-sweep/folder", { folder: null });
    assert.deepEqual(await outOf.json(), { campaign: "old-sweep", folder: null, changed: true });
    assert.equal((await s.rest("POST", "/v1/campaign-folders/Research/delete")).status, 200);
    const none = await json<{ folder: string | null }>(
      await s.rest("POST", "/v1/campaigns/old-sweep/unarchive"),
    );
    assert.equal(none.folder, null);

    for (const action of [
      "campaign_folder_created",
      "campaign_folder_renamed",
      "campaign_folder_deleted",
      "campaign_moved",
    ])
      assert.ok(
        s.audit(action).every((a) => a.actor === "owner:api") && s.audit(action).length,
        action,
      );
    assert.deepEqual(s.audit("campaign_archived")[0]?.body, {
      campaign: "old-sweep",
      folder: "Research",
    });
    assert.equal((await s.rest("GET", "/v1/campaign-folders", undefined, TOKENS.read)).status, 401);
  });
});

describe("Archive and folders over MCP (goal 077)", () => {
  test("the owner and an operator change them, a reader reads them, an agent has neither; refusals in words", async () => {
    const s = await stack();
    const names = async (token: string) =>
      (await (await mcpClient(s.control, token)).listTools()).tools.map((t) => t.name);
    const tools = [
      "archive_campaign",
      "unarchive_campaign",
      "create_campaign_folder",
      "rename_campaign_folder",
      "delete_campaign_folder",
      "move_campaign",
    ];
    for (const token of [TOKENS.admin, TOKENS.operator]) {
      const have = await names(token);
      for (const t of [...tools, "campaign_folders"]) assert.ok(have.includes(t), t);
    }
    const reader = await names(TOKENS.read);
    assert.ok(reader.includes("campaign_folders"));
    for (const t of tools) assert.ok(!reader.includes(t), t);
    const agent = await names(TOKENS.agent);
    for (const t of [...tools, "campaign_folders"]) assert.ok(!agent.includes(t), t);

    const op = await mcpClient(s.control, TOKENS.operator);
    const call = (name: string, args: Record<string, unknown>) =>
      op.callTool({ name, arguments: args });
    const refused = await call("archive_campaign", { campaign: "survey" });
    assert.equal(refused.isError, true);
    assert.equal(
      JSON.parse(text(refused)).error,
      "Pause or close its runs first. survey-1 is at work on rig-b.",
    );
    const archived = JSON.parse(text(await call("archive_campaign", { campaign: "old-sweep" })));
    assert.deepEqual(
      [archived.archived, archived.by, archived.changed],
      [true, "owner:operator", true],
    );
    assert.ok(
      s
        .audit("campaign_archived")
        .some((a) => a.actor === "owner:operator" && a.body.campaign === "old-sweep"),
    );
    JSON.parse(text(await call("create_campaign_folder", { name: "Kernels" })));
    const moved = JSON.parse(
      text(await call("move_campaign", { campaign: "fast-sort", folder: "Kernels" })),
    );
    assert.deepEqual(moved, { campaign: "fast-sort", folder: "Kernels", changed: true });
    const full = await call("delete_campaign_folder", { folder: "Kernels" });
    assert.equal(full.isError, true);
    assert.match(
      JSON.parse(text(full)).error,
      /Kernels is not empty\. Move its campaign out first: fast-sort\./,
    );
    JSON.parse(text(await call("rename_campaign_folder", { folder: "Kernels", name: "Sorts" })));
    const read = await mcpClient(s.control, TOKENS.read);
    const listed = JSON.parse(
      text(await read.callTool({ name: "campaign_folders", arguments: {} })),
    );
    assert.deepEqual(
      listed.folders.map((f: { name: string; campaigns: string[] }) => [f.name, f.campaigns]),
      [["Sorts", ["fast-sort"]]],
    );
    assert.deepEqual(
      listed.archived.map((a: { campaign: string }) => a.campaign),
      ["old-sweep"],
    );
    const back = JSON.parse(text(await call("unarchive_campaign", { campaign: "old-sweep" })));
    assert.equal(back.changed, true);
    assert.ok(s.audit("mcp:archive_campaign").length >= 2);
  });
});

describe("The navigation and archive on the dashboard (goal 077)", () => {
  test("the navigation lists no rigs; Rigs stays in the main navigation", async () => {
    const s = await stack();
    for (const path of ["/ui", "/ui/campaigns", "/ui/rigs", "/ui/campaigns/fast-sort"]) {
      const side = sidebar(await s.page(path));
      assert.match(
        side,
        /<a href="\/ui\/rigs" class="[^"]*">.*<span>Rigs<\/span><span class="count">2<\/span><\/a>/s,
        path,
      );
      assert.doesNotMatch(side, /rig-a|rig-b|\/ui\/rigs\/|<div class="section">Rigs<\/div>/, path);
    }
    // The status bar at the foot still counts them.
    assert.match(await s.page("/ui"), /2 rigs/);
  });

  test("a campaign in the navigation shows a link's pointer; the grabbing hand only while it is held or dragged", () => {
    assert.match(STYLE, /\.side-row\[draggable="true"\] \{ cursor: pointer; \}/);
    assert.match(
      STYLE,
      /\.side-row\[draggable="true"\]:active, \.side-dragging \.side-row \{ cursor: grabbing; \}/,
    );
    assert.doesNotMatch(STYLE, /\.side-row\[draggable="true"\] \{ cursor: grab; \}/);
  });

  test("folders hold their campaigns; drag and drop and Move to folder move them; a folder with campaigns is not deleted", async () => {
    const s = await stack();
    let side = sidebar(await s.page("/ui"));
    // Every campaign that is not archived, finished ones too; no folder yet, so no drop target.
    for (const k of ["fast-sort", "old-sweep", "wide-gemm", "survey"])
      assert.match(side, new RegExp(`data-campaign="${k}"`), k);
    assert.doesNotMatch(side, /side-drop/);
    assert.match(side, /<details class="fnew"><summary class="ib" title="New folder"/);
    assert.match(
      side,
      /<label class="sfd"><span class="lb">New folder<i class="ii" tabindex="0" data-tip="/,
    );

    const made = await s.post("/ui/campaign-folders", { name: "Kernels", back: "/ui/campaigns" });
    assert.equal(made.status, 303);
    assert.match(
      made.headers.get("location") ?? "",
      /^\/ui\/campaigns\?sent=Made%20the%20folder%20Kernels\./,
    );
    const again = await s.post("/ui/campaign-folders", { name: "KERNELS", back: "/ui" });
    const loc = again.headers.get("location") ?? "";
    assert.match(
      loc,
      /^\/ui\?error=No%20folder%20made\.%20There%20is%20a%20folder%20named%20Kernels%20already\.&on=shelf$/,
    );
    assert.match(
      await s.page(loc),
      /<b class="bad">No folder made\.<\/b> There is a folder named Kernels already\./,
    );
    const id = String(s.store.folders.get("Kernels")?.id);

    // Dropped on a folder: the navigation's script asks for JSON.
    const drop = await s.post("/ui/campaigns/fast-sort/folder", { folder: id }, true);
    assert.deepEqual(await drop.json(), {
      campaign: "fast-sort",
      folder: "Kernels",
      changed: true,
      said: "Moved fast-sort to Kernels.",
    });
    // Move to folder on a campaign's page: a form, back to the page.
    const page = await s.page("/ui/campaigns/old-sweep");
    assert.match(page, /<details class="menu" data-campaign-more>/);
    assert.match(page, /<span class="lb">Move to folder<i class="ii" tabindex="0" data-tip="/);
    assert.match(page, new RegExp(`<option value="${id}">Kernels</option>`));
    const form = await s.post("/ui/campaigns/old-sweep/folder", { folder: id });
    assert.equal(
      form.headers.get("location"),
      "/ui/campaigns/old-sweep?sent=Moved%20old-sweep%20to%20Kernels.",
    );

    side = sidebar(await s.page("/ui/campaigns/old-sweep"));
    const fold =
      /<div class="side-fold" data-folder="\d+">[\s\S]*?<\/details><details class="fmenu">/.exec(
        side,
      )?.[0] ?? "";
    assert.match(fold, /<span class="fname">Kernels<\/span><span class="n">2<\/span>/);
    assert.match(fold, /data-campaign="fast-sort"/);
    assert.match(fold, /data-campaign="old-sweep" aria-current="page"/);
    assert.match(side, /<div class="side-drop" data-drop="">Drop here: no folder<\/div>/);
    assert.match(side, /<span class="lb">Folder name<i class="ii"/);

    const full = await s.post(`/ui/campaign-folders/${id}/delete`, { back: "/ui" });
    assert.match(
      await s.page(full.headers.get("location") ?? ""),
      /<b class="bad">Not deleted\.<\/b> Kernels is not empty\. Move its 2 campaigns out first: fast-sort, old-sweep\./,
    );
    const renamed = await s.post(`/ui/campaign-folders/${id}/rename`, {
      name: "Sorts",
      back: "/ui",
    });
    assert.equal(renamed.headers.get("location"), "/ui?sent=Renamed%20Kernels%20to%20Sorts.");
    for (const k of ["fast-sort", "old-sweep"])
      await s.post(`/ui/campaigns/${k}/folder`, { folder: "" }, true);
    const deleted = await s.post(`/ui/campaign-folders/${id}/delete`, { back: "/ui" });
    assert.equal(deleted.headers.get("location"), "/ui?sent=Deleted%20the%20folder%20Sorts.");
    assert.deepEqual(s.store.folders.list(), []);
    assert.ok(s.audit("refused").some((a) => a.body.path === `/ui/campaign-folders/${id}/delete`));
  });

  test("Archive is refused in words while a run is at work; an archived campaign leaves the navigation, Needs you and the Overview, and Campaigns › Archived unarchives it", async () => {
    const s = await stack();
    let overview = await s.page("/ui");
    assert.match(overview, /Make this change the new champion\?/);
    assert.match(sidebar(overview), /<span class="badge">1<\/span>/);

    const refused = await s.post("/ui/campaigns/fast-sort/archive", {});
    const loc = refused.headers.get("location") ?? "";
    assert.match(loc, /^\/ui\/campaigns\/fast-sort\?error=Not%20archived\./);
    const said = await s.page(loc);
    assert.match(
      said,
      /<b class="bad">Not archived\.<\/b> Pause or close its runs first\. fast-sort-1 is at work on rig-a\./,
    );
    // Not read as a run that did not start.
    assert.doesNotMatch(said, /Not started\./);

    const ok = await s.post("/ui/campaigns/wide-gemm/archive", {});
    assert.equal(
      ok.headers.get("location"),
      "/ui/campaigns/wide-gemm?sent=Archived%20wide-gemm.%20It%20left%20the%20navigation%2C%20Needs%20you%20and%20the%20Overview.",
    );
    overview = await s.page("/ui");
    assert.doesNotMatch(sidebar(overview), /wide-gemm|class="badge"/);
    assert.doesNotMatch(overview, /Make this change the new champion\?|wide-gemm/);
    const list = await s.page("/ui/campaigns");
    assert.doesNotMatch(list, /data-campaign="wide-gemm"|kname" href="\/ui\/campaigns\/wide-gemm"/);
    assert.match(
      list,
      /<a class="fchip" href="\/ui\/campaigns\?f=archived">Archived <span class="n">1<\/span><\/a>/,
    );
    const all = await s.page("/ui/campaigns?f=all");
    assert.match(
      all,
      /<b>wide-gemm<\/b> <span class="muted small">hill climb<\/span> <span class="chip">archived<\/span>/,
    );

    // Its page says so, with Unarchive; it has no Start a run button or panel.
    const own = await s.page("/ui/campaigns/wide-gemm");
    assert.match(own, /Archived<\/b> [^<]+ ago by you\./);
    assert.match(
      own,
      /<form class="inline" method="post" action="\/ui\/campaigns\/wide-gemm\/unarchive">/,
    );
    assert.doesNotMatch(own, /data-open="#start"|id="start"/);

    const shelf = await s.page("/ui/campaigns?f=archived");
    assert.match(shelf, /<th>Archived<\/th>/);
    const row =
      /<tr class="click"><td><a class="kname" href="\/ui\/campaigns\/wide-gemm">[\s\S]*?<\/tr>/.exec(
        shelf,
      )?.[0] ?? "";
    assert.match(row, /1 paused/);
    assert.match(row, /ago by you/);
    assert.match(
      row,
      /action="\/ui\/campaigns\/wide-gemm\/unarchive"><input type="hidden" name="csrf" value="[^"]+"><input type="hidden" name="back" value="\/ui\/campaigns\?f=archived"><button class="sm">Unarchive<\/button>/,
    );
    const back = await s.post("/ui/campaigns/wide-gemm/unarchive", {
      back: "/ui/campaigns?f=archived",
    });
    assert.equal(
      back.headers.get("location"),
      "/ui/campaigns?f=archived&sent=Unarchived%20wide-gemm.%20It%20is%20back%20in%20the%20navigation%2C%20in%20no%20folder.",
    );
    assert.match(sidebar(await s.page("/ui")), /data-campaign="wide-gemm"/);
    assert.deepEqual(
      s.audit("campaign_archived").map((a) => a.actor),
      ["owner:ui"],
    );
  });

  test("an archived campaign keeps its folder: the folder's count leaves it out, the folder is not deleted, and Unarchive brings it back into it", async () => {
    const s = await stack();
    await s.post("/ui/campaign-folders", { name: "Old" });
    const id = String(s.store.folders.get("Old")?.id);
    for (const k of ["old-sweep", "wide-gemm"])
      await s.post(`/ui/campaigns/${k}/folder`, { folder: id }, true);
    const fold = (html: string) =>
      /<div class="side-fold" data-folder="\d+">[\s\S]*?<\/details><details class="fmenu">/.exec(
        sidebar(html),
      )?.[0] ?? "";
    assert.match(
      fold(await s.page("/ui")),
      /<span class="fname">Old<\/span><span class="n">2<\/span>/,
    );

    await s.post("/ui/campaigns/wide-gemm/archive", {});
    let f = fold(await s.page("/ui"));
    assert.match(f, /<span class="n">1<\/span>/);
    assert.match(f, /data-archived="1"/);
    assert.doesNotMatch(f, /data-campaign="wide-gemm"/);
    await s.post("/ui/campaigns/old-sweep/archive", {});
    f = fold(await s.page("/ui"));
    assert.match(f, /<span class="n">0<\/span>/);
    assert.match(f, /<div class="side-empty">2 archived campaigns, not shown\.<\/div>/);

    // Its page and Campaigns › Archived name the folder it keeps; ⋯ can still move it.
    const own = await s.page("/ui/campaigns/old-sweep");
    assert.match(own, /and it keeps its folder, Old\./);
    assert.match(own, /It comes back to the navigation, in Old\./);
    assert.match(own, new RegExp(`<option value="${id}" selected>Old</option>`));
    assert.match(await s.page("/ui/campaigns?f=archived"), /ago by you · in Old/);

    // A folder that holds only archived campaigns is not deleted, in words.
    const refused = await s.post(`/ui/campaign-folders/${id}/delete`, { back: "/ui" });
    assert.match(
      await s.page(refused.headers.get("location") ?? ""),
      /<b class="bad">Not deleted\.<\/b> Old is not empty\. Move its 2 campaigns out first: old-sweep \(archived\), wide-gemm \(archived\)\./,
    );

    const back = await s.post("/ui/campaigns/old-sweep/unarchive", {});
    assert.equal(
      back.headers.get("location"),
      "/ui/campaigns/old-sweep?sent=Unarchived%20old-sweep.%20It%20is%20back%20in%20the%20navigation%2C%20in%20Old.",
    );
    f = fold(await s.page("/ui"));
    assert.match(f, /<span class="n">1<\/span>/);
    assert.match(f, /data-campaign="old-sweep"/);
    assert.match(f, /data-archived="1"/);
  });
});
