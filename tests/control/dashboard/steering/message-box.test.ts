import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runMessages } from "../../../../src/control/views/index.ts";
import { parseContract } from "../../../../src/core/contract.ts";
import { Scheduler } from "../../../../src/harness/agents/scheduler/index.ts";
import { LocalRunner } from "../../../../src/harness/broker/runner.ts";
import { Research } from "../../../../src/harness/research/research/index.ts";
import { briefText } from "../../../helpers/brief-text.ts";
import { researchFixture } from "../../../helpers/fixtures.ts";
import { makeHarnessEnv } from "../../../helpers/harness-env.ts";
import { makeJudgeEnv } from "../../../helpers/judge-env.ts";
import { form, recipients, stream, yours } from "./page.ts";
import { stack } from "./stack.ts";

/**
 * Live's message box, driven as a browser drives it: each recipient, a message kept in force
 * and removed, who read it, and the advisors' answers under You.
 */

describe("Live's message box", () => {
  test("each recipient, kept in force and removed; who read it from the rig's own record, and the advisors' answers, under You", async () => {
    const env = makeJudgeEnv({ lanes: { count: 2, trials_per_epoch: 1 } });
    const s = await stack(env);
    await env.start();
    await s.sync();
    await s.advisorsSetUp({ teachers: 2, merged_by: true, auditor: true, review_panel: 1 });
    // Two lanes at work: the first lines of their agents.
    const t1 = { id: "t-1111111111111111", run: "js-1", lane: "lane-1" };
    const t2 = { id: "t-2222222222222222", run: "js-1", lane: "lane-2" };
    env.service.trialReport(t1, { entries: [{ kind: "text", text: "Profiling first." }] });
    env.service.trialReport(t2, { entries: [{ kind: "text", text: "Reading the kernel." }] });
    await s.sync();
    const LIVE = "/ui/campaigns/js-sum/runs/js-1/live";
    let live = await s.get(LIVE);

    // Who a message can go to: everyone working (chosen first), each lane, the planner and the
    // advisors. Only the review panel is greyed out: this hill climb has no goal it reviews.
    const to = recipients(live);
    assert.deepEqual(
      to.map((o) => o.label),
      [
        "To everyone working",
        "To lane-1",
        "To lane-2",
        "To the planner",
        "To all advisors",
        "To the teachers",
        "To the auditor",
        "To the review panel",
      ],
    );
    assert.deepEqual(
      to.filter((o) => o.chosen).map((o) => o.to),
      ["all"],
    );
    assert.deepEqual(
      to.filter((o) => o.greyed).map((o) => [o.to, o.greyed]),
      [["review_panel", "This run has no goal the review panel reviews."]],
    );
    // Each says when it is read: the placeholder shows the chosen one's.
    const hint = (v: string) => to.find((o) => o.to === v)?.hint;
    assert.match(hint("all") ?? "", /^Each agent reads it [^;]+; the planner at its next plan$/);
    assert.match(hint("lane-2") ?? "", /^lane-2 reads it /);
    assert.equal(hint("planner"), "The planner reads it when it plans the next round");
    assert.equal(hint("teachers"), "The teachers read it in their next round and answer here");
    assert.equal(hint("auditor"), "The auditor reads it before its next audit and answers here");
    assert.match(
      live,
      /placeholder="Each agent reads it [^"]*; the planner at its next plan · ⌘↩ sends"/,
    );
    // Filters: everyone, each lane, the planner, the judge, the advisors and you.
    assert.deepEqual(
      [...live.matchAll(/class="lchip[^"]*" data-w="([^"]+)"/g)].map((m) => m[1]),
      ["all", "lane-1", "lane-2", "planner", "judge", "advisors", "you"],
    );
    // The lane you watch is the one you write to; the judge takes no messages.
    const watching = async (w: string) => {
      const page = await s.get(`${LIVE}?w=${w}`);
      return { page, to: recipients(page).find((o) => o.chosen)?.to };
    };
    const lane2 = await watching("lane-2");
    assert.equal(lane2.to, "lane-2");
    assert.match(lane2.page, /<a class="lchip on" data-w="lane-2"/);
    const advisors = await watching("advisors");
    assert.equal(advisors.to, "advisors");
    assert.equal((await watching("judge")).to, "all");

    // Send, as the box is filled in: a message kept in force (📌) and one per recipient.
    const send = (page: string, set: Record<string, string>) => s.submit(form(page, "Send"), set);
    assert.equal(
      await send(live, { text: "  Keep the public API unchanged.  ", keep: "1" }),
      "/ui/campaigns/js-sum/runs/js-1/live",
    );
    assert.equal(
      await send(lane2.page, { text: "Look at the cache misses first." }),
      "/ui/campaigns/js-sum/runs/js-1/live?w=lane-2",
    );
    // Only a message to everyone working or to a lane stays in force: 📌 here is ignored.
    await send(live, { to: "planner", text: "Spread the lanes wider.", keep: "1" });
    await send(advisors.page, { to: "teachers", text: "Cite the paper." });
    await send(advisors.page, { to: "auditor", text: "Check the timer first." });
    await send(advisors.page, { text: "Be strict." });
    // A greyed-out recipient is refused with the words it shows; nothing is signed.
    assert.match(
      await send(advisors.page, { to: "review_panel", text: "Judge it strictly." }),
      /&msgerror=This run has no goal the review panel reviews, so nothing would read it\.$/,
    );
    assert.deepEqual(s.signed("message_agent"), [
      { run: "js-1", to: "all", text: "Keep the public API unchanged.", keep: true },
      { run: "js-1", to: "lane-2", text: "Look at the cache misses first." },
      { run: "js-1", to: "planner", text: "Spread the lanes wider." },
      { run: "js-1", to: "teachers", text: "Cite the paper." },
      { run: "js-1", to: "auditor", text: "Check the timer first." },
      { run: "js-1", to: "advisors", text: "Be strict." },
    ]);
    await s.sync();
    const cmds = s.store.commands.list(50).filter((c) => c.kind === "message_agent");
    assert.deepEqual(
      cmds.map((c) => c.status),
      Array(6).fill("delivered"),
    );

    // Each message in the stream once the rig has it, under You and its recipient's filter.
    live = await s.get(LIVE);
    const lines = stream(live);
    const line = (re: RegExp) => lines.find((l) => re.test(l.text));
    assert.deepEqual(
      line(/To everyone working: Keep the public API unchanged\. 📌 kept in force$/)?.who,
      ["you", "all"],
    );
    assert.deepEqual(line(/To lane-2: Look at the cache misses first\.$/)?.who, ["you", "lane-2"]);
    assert.deepEqual(line(/To the planner: Spread the lanes wider\.$/)?.who, ["you", "planner"]);
    assert.deepEqual(line(/To the teachers: Cite the paper\.$/)?.who, ["you", "advisors"]);
    assert.deepEqual(line(/To the auditor: Check the timer first\.$/)?.who, ["you", "advisors"]);
    assert.deepEqual(line(/To all the advisors: Be strict\.$/)?.who, ["you", "advisors"]);
    assert.doesNotMatch(live, /read your message/, "nobody has read one yet");
    // The kept message sits behind "📌 1 kept", with Remove.
    assert.match(
      live,
      /📌 1 kept<\/summary>[\s\S]*?<b>To everyone:<\/b> Keep the public API unchanged\./,
    );

    // The readers, as the rig's harness gives them the text: each lane's Pi worker at its next
    // step, the planner at its next plan, and the advisors in their round or package (the
    // supervisor reports what each read and answered).
    const ids = new Map([...runMessages(s.store, "rig-a", "js-1")].map(([id, m]) => [m.text, id]));
    const id = (text: string) => ids.get(text) ?? 0;
    const step = (t: typeof t1) => {
      const inbox = env.service.trialInbox(t);
      const waiting = inbox.waiting();
      inbox.given(waiting.map((m) => m.id));
      return waiting.map((m) => m.text);
    };
    assert.deepEqual(step(t1), ["Keep the public API unchanged."]);
    assert.deepEqual(step(t2), [
      "Keep the public API unchanged.",
      "Look at the cache misses first.",
    ]);
    assert.deepEqual(env.service.takePlannerMessages("js-1"), [
      "Keep the public API unchanged.",
      "Spread the lanes wider.",
    ]);
    const teachers = await s.toHarness("/v1/advisor-messages", {
      run: "js-1",
      role: "teachers",
      read: [id("Cite the paper."), id("Be strict.")],
      answers: [
        {
          message: id("Cite the paper."),
          text: "Understood: the paper first.",
          advisor: "teacher-a",
        },
      ],
    });
    assert.equal(teachers.status, 200, await teachers.clone().text());
    const auditor = await s.toHarness("/v1/advisor-messages", {
      run: "js-1",
      role: "auditor",
      read: [id("Check the timer first."), id("Be strict.")],
      answers: [
        {
          message: id("Check the timer first."),
          text: "I will look at the timer before I decide.",
        },
      ],
    });
    assert.equal(auditor.status, 200, await auditor.clone().text());
    await s.sync();

    // Control's record of who read each message comes from the rig's own events.
    const record = (await s.run("js-1")).messages.map((m) => ({
      to: m.to,
      reads: m.reads.map((r) => (r.trial ? `${r.by} in ${r.trial}` : r.by)),
      answers: m.answers.map((a) => `${a.role}: ${a.text}`),
    }));
    assert.deepEqual(record, [
      {
        to: "all",
        reads: [`lane-1 in ${t1.id}`, `lane-2 in ${t2.id}`, "planner"],
        answers: [],
      },
      { to: "lane-2", reads: [`lane-2 in ${t2.id}`], answers: [] },
      { to: "planner", reads: ["planner"], answers: [] },
      { to: "teachers", reads: ["teachers"], answers: ["teachers: Understood: the paper first."] },
      {
        to: "auditor",
        reads: ["auditor"],
        answers: ["auditor: I will look at the timer before I decide."],
      },
      { to: "advisors", reads: ["teachers", "auditor"], answers: [] },
    ]);

    // You: the messages, then a receipt for each read and the answers, in the order they came.
    // On the bus each source's lines come as a message of their own: the planner's after the
    // others of the same round.
    live = await s.get(LIVE);
    assert.deepEqual(yours(live), [
      "To everyone working: Keep the public API unchanged. 📌 kept in force",
      "To lane-2: Look at the cache misses first.",
      "To the teachers: Cite the paper.",
      "To the auditor: Check the timer first.",
      "To all the advisors: Be strict.",
      "To the planner: Spread the lanes wider.",
      "✓ lane-1 read your message (in force): “Keep the public API unchanged.”",
      "✓ lane-2 read your message (in force): “Keep the public API unchanged.”",
      "✓ lane-2 read your message: “Look at the cache misses first.”",
      "✓ planner read your message (in force): “Keep the public API unchanged.”",
      "✓ planner read your message: “Spread the lanes wider.”",
      "✓ the teachers read your message: “Cite the paper.”",
      "✓ the teachers read your message: “Be strict.”",
      "the teachers (teacher-a) answered you: Understood: the paper first.",
      "✓ the auditor read your message: “Check the timer first.”",
      "✓ the auditor read your message: “Be strict.”",
      "the auditor answered you: I will look at the timer before I decide.",
    ]);
    // A receipt also shows under its reader's filter; the agents' own lines never under You.
    assert.deepEqual(stream(live).find((l) => /lane-1 read your/.test(l.text))?.who, [
      "lane-1",
      "you",
    ]);
    assert.deepEqual(stream(live).find((l) => /Profiling first/.test(l.text))?.who, ["lane-1"]);

    // Remove the kept message from "📌 1 kept": new trials no longer get it.
    const remove = form(live, "Remove", "📌 1 kept");
    assert.equal(remove.fields.kind, "unkeep_message");
    assert.equal(remove.fields.message, String(id("Keep the public API unchanged.")));
    await s.submit(remove);
    await s.sync();
    live = await s.get(LIVE);
    assert.doesNotMatch(live, /kept<\/summary>/);
    assert.equal(
      yours(live).at(-1),
      "📌 You removed your kept message: “Keep the public API unchanged.”. New trials no longer get it.",
    );
    assert.deepEqual(env.service.messages.inForce("js-1", "lane-1"), []);
    assert.equal((await s.run("js-1")).messages[0]?.unkept, true);

    // A message the rig refuses (a lane this run doesn't have) shows above the box, with the
    // rig's reason, until a newer message to the run goes through.
    await send(live, { to: "lane-3", text: "Try the third lane." });
    await s.sync();
    live = await s.get(LIVE);
    assert.match(
      live,
      /<div class="lnotice">[\s\S]*?<b>Not sent\.<\/b> The rig refused your last message: run js-1 has 2 lanes<\/span>/,
    );
    await send(live, { to: "lane-1", text: "Thanks." });
    await s.sync();
    assert.doesNotMatch(await s.get(LIVE), /class="lnotice"/);
  });

  test("a research run offers its planner (goals 047 and 117) and its review panel (goal 112), no auditor; everyone working, kept in force, reaches each new trial", async () => {
    const env = makeHarnessEnv("rig-a");
    const s = await stack(env);
    const parsed = parseContract({ ...researchFixture, lanes: { count: 1, trials_per_epoch: 1 } });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const assigned = await s.api("POST", "/v1/commands", {
      rig: "rig-a",
      kind: "assign_campaign",
      payload: { run: "r-1", contract: parsed.contract, contract_sha: parsed.sha, imports: [] },
    });
    assert.equal(assigned.status, 201, await assigned.clone().text());
    await s.sync();
    const LIVE = "/ui/campaigns/topic-survey/runs/r-1/live";
    let live = await s.get(LIVE);
    const to = recipients(live);
    assert.deepEqual(
      to.filter((o) => o.greyed).map((o) => [o.to, o.greyed]),
      [["auditor", "A research run has no attempts to audit."]],
    );
    // Its planner plans its rounds from the answer cards, and reads the owner's messages.
    assert.equal(to.find((o) => o.to === "planner")?.greyed, undefined);
    // The review panel checks whether a research run's questions are answered (goal 112).
    assert.equal(to.find((o) => o.to === "review_panel")?.greyed, undefined);
    assert.equal(
      to.find((o) => o.to === "all")?.hint,
      "Each agent reads it when it can; the planner at its next plan",
    );
    // Its planner to watch (goal 117), and no judge.
    assert.deepEqual(
      [...live.matchAll(/class="lchip[^"]*" data-w="([^"]+)"/g)].map((m) => m[1]),
      ["all", "planner", "advisors", "you"],
    );
    for (const [who, why] of [["auditor", "A research run has no attempts to audit."]] as const)
      assert.ok(
        (await s.submit(form(live, "Send"), { to: who, text: "Hello." })).endsWith(
          `?msgerror=${why}`,
        ),
      );
    assert.deepEqual(s.signed("message_agent"), []);
    await s.submit(form(live, "Send"), { text: "Prefer primary sources.", keep: "1" });
    await s.sync();

    // Two rounds of the research plan: each new trial's brief carries the kept message.
    const briefs: string[] = [];
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.service.paths.scratchDir),
      model: {
        baseUrl: "http://127.0.0.1:9",
        model: "m",
        apiKey: "k",
        contextWindow: 1,
        maxTokens: 1,
      },
      owner: "steering-ui-test",
      research: new Research(env.service.ledger, env.service.paths.stateDir, {
        allowPrivate: true,
      }),
      runTrial: async () => ({
        stopped: "error",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
      runResearchTrial: async (spec) => {
        briefs.push(briefText(spec.brief));
        return { stopped: "finished", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
      },
    });
    for (let round = 0; round < 2; round++) {
      assert.ok(await scheduler.tick(), "a trial started");
      await scheduler.idle();
      await scheduler.tick();
    }
    assert.equal(briefs.length, 2);
    for (const b of briefs)
      assert.match(
        b,
        /# Messages from the campaign's owner, in force\n- Prefer primary sources\.$/,
      );
    await s.sync();
    live = await s.get(LIVE);
    assert.deepEqual(yours(live), [
      "To everyone working: Prefer primary sources. 📌 kept in force",
      "✓ lane-1 read your message (in force): “Prefer primary sources.”",
      "✓ lane-1 read your message (in force): “Prefer primary sources.”",
    ]);
    const [m] = (await s.run("r-1")).messages;
    assert.deepEqual(
      m?.reads.map((r) => r.by),
      ["lane-1"],
      "the lane's first read is the rig's event; each new trial's read is a line",
    );
  });
});
