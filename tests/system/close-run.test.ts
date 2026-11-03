import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Progress } from "../../src/control/command-progress.ts";
import { ADMIN, controlStack, mcpClient, signIn } from "../helpers/control-stack.ts";
import { FAST_KERNEL } from "../helpers/judge-env.ts";

/**
 * The owner closes a run by hand (goal 087): Close run in the ⋯ of a run's page sends close_run,
 * and the page then shows the run closed with the owner's reason. REST takes it with the owner's
 * token; over MCP, only the owner's token issues it. Control here has one rig whose harness is
 * real; the supervisor's relay is called by hand.
 */

const OPERATOR = "operator-token-abcdef";
const AGENT = "agent-token-abcdef";
type Answer = Progress & { follow?: string };

async function stack() {
  const { env, store, control, relay } = controlStack({
    tokens: { operator: OPERATOR, agent: AGENT },
  });
  const { cookie, page } = await signIn(control);
  await env.service.applyCommand(env.assign);
  await relay();
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(await page("/ui/rigs/rig-a"))?.[1] ?? "";
  /** A form as a browser posts it without the page's script. */
  const post = (form: Record<string, string>) =>
    control.request("/ui/commands", {
      method: "POST",
      body: new URLSearchParams({ csrf, ...form }),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    });
  /** A form as the page's script sends it: with fetch, asking for JSON. */
  const send = async (form: Record<string, string>) => {
    const r = await control.request("/ui/commands", {
      method: "POST",
      body: new URLSearchParams({ csrf, ...form }),
      headers: {
        cookie,
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
    });
    return { status: r.status, answer: JSON.parse(await r.text()) as Answer };
  };
  const follow = async (url: string) => JSON.parse(await page(url)) as Answer;
  return { env, store, control, relay, page, post, send, follow };
}

const RUN_PAGE = "/ui/campaigns/js-sum/runs/js-1";
/** The run page's header: the title bar with its buttons. */
const headerOf = (html: string) =>
  /<header class="topbar">[\s\S]*?<\/header>/.exec(html)?.[0] ?? "";
const closeFormOf = (html: string) =>
  /<form method="post" action="\/ui\/commands" class="stack close-run">[\s\S]*?<\/form>/.exec(
    html,
  )?.[0] ?? "";

describe("Close run on a run's page (goal 087)", () => {
  test("⋯ has Close run with a reason and a typed confirmation; the page then shows the run closed with the reason", async () => {
    const s = await stack();
    const before = await s.page(RUN_PAGE);
    const form = closeFormOf(headerOf(before));
    assert.ok(form, "Close run is in the run's header, under ⋯");
    assert.match(
      form,
      /<b>Close run\.<\/b> <span class="muted">The run ends for good: nothing more starts, and it can't be resumed\. Its results stay\.<\/span>/,
    );
    assert.match(form, /<input type="hidden" name="kind" value="close_run">/);
    assert.match(form, /<input type="hidden" name="run" value="js-1">/);
    assert.match(form, /<span class="lb">Why<i class="ii" tabindex="0" data-tip="Why you close/);
    assert.match(form, /<input name="reason" required maxlength="500"/);
    assert.match(form, /data-confirm="close js-1"/);
    assert.match(form, /<button class="danger">Close the run<\/button>/);
    // Restart the lanes stays first in the same menu.
    assert.match(headerOf(before), /Restart the lanes[\s\S]*Close run\./);

    // Control refuses it without a reason or the typed words, in words, and signs nothing.
    const noWhy = await s.send({
      rig: "rig-a",
      kind: "close_run",
      run: "js-1",
      confirm: "close js-1",
    });
    assert.equal(noWhy.status, 400);
    assert.equal(noWhy.answer.said, "Not sent: Write why you close the run first.");
    const noWords = await s.send({
      rig: "rig-a",
      kind: "close_run",
      run: "js-1",
      reason: "done",
      confirm: "close js-2",
    });
    assert.equal(noWords.answer.said, "Not sent: Type close js-1 to confirm.");
    const plain = await s.post({ rig: "rig-a", kind: "close_run", run: "js-1", reason: "done" });
    assert.equal(plain.status, 400);
    assert.equal(await plain.text(), "refused: type close js-1 to confirm");
    assert.equal(s.store.commands.list(10).filter((c) => c.kind === "close_run").length, 0);

    // Sent, taken by the rig, then done once its report came, as every command's button.
    const why = "another run finished the work";
    const sent = await s.send({
      rig: "rig-a",
      kind: "close_run",
      run: "js-1",
      reason: ` ${why} `,
      confirm: "close js-1",
      back: RUN_PAGE,
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.answer.state, "sent");
    assert.match(sent.answer.follow ?? "", /^\/ui\/commands\/[0-9a-f-]+\.json$/);
    const cmd = s.store.commands.list(10).find((c) => c.kind === "close_run");
    assert.equal(cmd?.issued_by, "owner:ui");
    await s.relay();
    assert.equal(s.env.ledger.runs.get("js-1")?.status, "closed");
    assert.equal(s.env.ledger.runs.get("js-1")?.pause_reason, why, "the reason, trimmed");
    await s.relay();
    const done = await s.follow(sent.answer.follow ?? "");
    assert.deepEqual([done.state, done.final, done.tone], ["done", true, "ok"]);

    // The page now shows the run closed with the reason: no Pause, Resume or Close run.
    const after = await s.page(RUN_PAGE);
    assert.match(headerOf(after), /Finished/);
    assert.doesNotMatch(headerOf(after), /Pause|Resume|Close run|title="More"/);
    assert.match(after, new RegExp(`This run is <b>closed: ${why}</b>\\. It is finished\\.`));
    const history = await s.page(`${RUN_PAGE}/history`);
    assert.match(history, new RegExp(`Run js-1 closed: ${why}\\.`));
  });

  test("a paused run has Close run beside Resume; a run already closed is refused in words", async () => {
    const s = await stack();
    await s.env.service.applyCommand(
      s.env.sign("pause_run", { run: "js-1", reason: "seen enough" }),
    );
    await s.relay();
    const head = headerOf(await s.page(RUN_PAGE));
    assert.match(head, />Resume<\/button>/);
    assert.ok(closeFormOf(head), "Close run on a paused run");
    assert.doesNotMatch(head, /Restart the lanes/, "a paused run has no lanes to restart");
    // The rig closed it meanwhile (the page was older): the rig refuses the second close.
    await s.env.service.applyCommand(s.env.sign("close_run", { run: "js-1", reason: "first" }));
    const sent = await s.send({
      rig: "rig-a",
      kind: "close_run",
      run: "js-1",
      reason: "second",
      confirm: "close js-1",
    });
    await s.relay();
    await s.relay();
    const out = await s.follow(sent.answer.follow ?? "");
    assert.equal(out.final, true);
    assert.equal(out.tone, "bad");
    assert.match(out.said, /run js-1 is already closed \(first\): there is nothing to close/);
    assert.equal(s.env.ledger.runs.get("js-1")?.pause_reason, "first");
  });
});

describe("close_run over REST and MCP (goal 087)", () => {
  test("POST /v1/commands takes it with the owner's token; over MCP only the owner's token issues it", async () => {
    const s = await stack();
    const rest = (token: string, payload: unknown) =>
      s.control.request("/v1/commands", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ rig: "rig-a", kind: "close_run", payload }),
      });
    // Not the operator's or an agent's token: REST commands are the owner's.
    for (const t of [OPERATOR, AGENT])
      assert.equal((await rest(t, { run: "js-1", reason: "x" })).status, 401);
    const bad = await rest(ADMIN, { run: "js-1", reason: "  " });
    assert.equal(bad.status, 400);
    assert.match(
      ((await bad.json()) as { error: string }).error,
      /^bad close_run payload: reason: /,
    );

    // MCP: the operator's and an agent's issue_command don't take close_run.
    const issue = async (client: Client, payload: Record<string, unknown>) => {
      try {
        const r = (await client.callTool({
          name: "issue_command",
          arguments: { rig: "rig-a", kind: "close_run", payload },
        })) as { isError?: boolean; content: { text: string }[] };
        return r.isError ? undefined : (JSON.parse(r.content[0]?.text ?? "{}") as { id?: string });
      } catch {
        return undefined;
      }
    };
    for (const token of [OPERATOR, AGENT]) {
      const client = await mcpClient(s.control, token);
      const tool = (await client.listTools()).tools.find((t) => t.name === "issue_command");
      assert.doesNotMatch(String(tool?.description), /close_run/, token);
      assert.equal(await issue(client, { run: "js-1", reason: "x" }), undefined, token);
      await client.close();
    }
    assert.equal(s.store.commands.list(10).filter((c) => c.kind === "close_run").length, 0);
    const owner = await mcpClient(s.control, ADMIN);
    const tool = (await owner.listTools()).tools.find((t) => t.name === "issue_command");
    assert.match(String(tool?.description), /close_run \{run, reason\} \(the owner's token only/);
    const viaMcp = await issue(owner, { run: "js-1", reason: "closed over MCP" });
    assert.ok(viaMcp?.id, "the owner's MCP token closes a run");
    await owner.close();
    await s.relay();
    assert.deepEqual(
      [s.env.ledger.runs.get("js-1")?.status, s.env.ledger.runs.get("js-1")?.pause_reason],
      ["closed", "closed over MCP"],
    );
    const ev = s.env.ledger.db
      .prepare("select actor from event where kind = 'run_status' order by id desc limit 1")
      .get() as { actor: string };
    assert.equal(ev.actor, "control:owner:mcp");

    // REST: the owner's token issues it; the rig refuses a second close in words.
    const again = await rest(ADMIN, { run: "js-1", reason: "twice" });
    assert.equal(again.status, 201);
    const { id } = (await again.json()) as { id: string };
    await s.relay();
    const c = s.store.commands.get(id) as { status: string; outcome?: { result?: unknown } };
    assert.equal(c.status, "failed");
    assert.match(JSON.stringify(c), /run js-1 is already closed \(closed over MCP\)/);
  });
});

describe("A closed run's waiting decisions (goal 087; the owner, 2026-10-22)", () => {
  test("a change waiting for approval leaves Needs you and its counts when its run closes; its page has no buttons and says why; the rig refuses an approval in words", async () => {
    const s = await stack();
    // A change that waits for the owner's approval, as the judge leaves one the run asks about.
    const { attempt } = (await s.env.service.submitAttempt(
      {
        run: "js-1",
        patch_base64: s.env.patch(FAST_KERNEL),
        hypothesis: "less work",
        known_flaws: [],
      },
      "proposer",
    )) as { attempt: string };
    s.env.ledger.attempts.setLifecycle(attempt, "awaiting_approval", "judge");
    s.env.ledger.appendEvent("judge", "promotion_pending", attempt, {
      run: "js-1",
      expected_seq: 1,
      commit: s.env.ledger.attempts.get(attempt)?.commit_sha,
      reason: "you asked to decide every change (promotion: owner approval)",
    });
    await s.relay();
    const ATTEMPT_PAGE = `/ui/campaigns/js-sum/runs/js-1/attempts/${attempt}`;
    const approveButton = /name="kind" value="approve_promotion"/;
    const declineButton = /name="kind" value="decline_promotion"/;
    const waiting = await s.page("/ui");
    assert.match(waiting, /Make this change the new champion\?/);
    assert.match(waiting, /<h2>Needs you<\/h2><span class="n">1<\/span>/);
    assert.match(waiting, /Needs you 1<\/a>/, "the count in the status bar");
    assert.match(await s.page(ATTEMPT_PAGE), approveButton);
    assert.match(
      await s.page("/ui/campaigns"),
      /<h2>Waiting for you<\/h2><span class="n">1<\/span>[\s\S]*1 decision waits for you\./,
    );

    // The owner closes the run.
    const why = "another run finished the work";
    await s.send({
      rig: "rig-a",
      kind: "close_run",
      run: "js-1",
      reason: why,
      confirm: "close js-1",
    });
    await s.relay();
    await s.relay();
    assert.equal(s.env.ledger.runs.get("js-1")?.status, "closed");

    // Needs you leaves it out, and every count with it.
    const overview = await s.page("/ui");
    assert.doesNotMatch(overview, /Make this change the new champion\?/);
    assert.match(overview, /<h2>Needs you<\/h2><span class="n">0<\/span>/);
    assert.match(overview, /Nothing waits for you\. The campaigns go on by themselves\./);
    assert.doesNotMatch(overview, /Needs you \d+<\/a>/, "no count in the status bar");
    assert.doesNotMatch(overview, /<span class="badge">\d+<\/span>/, "no count beside Overview");
    const campaigns = await s.page("/ui/campaigns");
    assert.doesNotMatch(campaigns, /<h2>Waiting for you<\/h2>|decision waits for you/);
    assert.match(campaigns, /0 decisions wait for you/);
    const run = await s.page(RUN_PAGE);
    assert.doesNotMatch(run, /id="needs"/);
    assert.match(
      run,
      /It is finished\. When it closed, 1 change waited for a decision\. It does not become the champion, and nothing in this run waits for you\./,
    );

    // The change's own page: no buttons, and why.
    const page = await s.page(ATTEMPT_PAGE);
    assert.doesNotMatch(page, approveButton);
    assert.doesNotMatch(page, declineButton);
    assert.doesNotMatch(page, /<h2>Your decision<\/h2>/);
    assert.match(page, /<span class="chip ">Run closed<\/span>/);
    assert.match(
      page,
      /The run closed while this change waited for a decision\. It does not become the champion, and the rig refuses a decision on it\./,
    );
    assert.match(page, /Waited for your approval/);
    assert.match(page, /The run closed: no decision now/);

    // REST and MCP list no pending promotion for it.
    const view = (await (
      await s.control.request("/v1/rigs/rig-a/view", {
        headers: { authorization: `Bearer ${ADMIN}` },
      })
    ).json()) as { runs: { id: string; pending_promotions: string[] }[] };
    assert.deepEqual(view.runs.find((r) => r.id === "js-1")?.pending_promotions, []);
    const owner = await mcpClient(s.control, ADMIN);
    const listed = (await owner.callTool({ name: "list_rigs", arguments: {} })) as {
      content: { text: string }[];
    };
    const rigs = JSON.parse(listed.content[0]?.text ?? "[]") as {
      runs: { run: string; pending_promotions: string[] }[];
    }[];
    assert.deepEqual(rigs[0]?.runs.find((r) => r.run === "js-1")?.pending_promotions, []);
    await owner.close();

    // An approval sent from a page opened before the close: the rig refuses it, in words, and
    // nothing comes back to Needs you.
    const sent = await s.send({ rig: "rig-a", kind: "approve_promotion", run: "js-1", attempt });
    await s.relay();
    await s.relay();
    const out = await s.follow(sent.answer.follow ?? "");
    assert.deepEqual([out.final, out.tone], [true, "bad"]);
    assert.match(out.said, /run js-1 is closed: none of its changes can become the champion/);
    assert.equal(String(s.env.ledger.attempts.get(attempt)?.lifecycle), "awaiting_approval");
    assert.equal(s.env.ledger.champions.current("js-1").seq, 1, "the champion stays");
    assert.match(await s.page("/ui"), /Nothing waits for you\./);
  });
});
