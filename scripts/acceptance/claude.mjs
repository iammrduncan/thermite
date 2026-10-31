#!/usr/bin/env node
// Claude Code acceptance under compose, with a stand-in for Claude Code mounted in the harness
// (containers/test-claude; no subscription and no download needed). Through the dashboard: a
// Claude subscription added in Providers, its model given to the rig (in Claude Code), then:
//   - the rig takes the route; its model check runs one Bash call through Claude Code;
//   - the planner plans in Claude Code's own terminal (goal 169: the default), with no tools, as
//     planner-<run>-<round>: one owner's message to it goes in inside its turn, through its Stop
//     hook with the call's own credential, and the owner's console types into it;
//   - a worker trial runs Claude Code in its own terminal (goal 169: the default, on a rig nobody
//     set), as the lane's user, with the token on file descriptor 3 (in no environment), the
//     safety flags, its seeds (no screen waits) and its transcript copied for the harness, edits
//     the code and submits with thermite-trial;
//   - its first turn meets a full five-hour usage window that the stand-in resets 30 s later
//     (goal 169): the trial waits it out in its terminal, with the run's wait recorded
//     (`agents_wait_for_limit`, in the trial) and nothing typed into Claude Code meanwhile; the
//     owner's input sent during the wait (`terminal_input`) is queued for the reset; Claude Code goes
//     on by itself after the reset (Thermite's settings turn autoContinueAtUsageLimit on), the
//     queued input is typed into its turn then (`typed_after_reset`), and the same trial submits;
//   - it compacts once: Thermite's PreCompact hook copies its transcript and names the file in
//     the summary, and the harness keeps the conversation and records the compaction;
//   - Thermite's hooks run in it as the lane's user and reach the harness with the trial's token:
//     of two owner's messages sent to the running trial, the PostToolUse hook gives the first
//     after a command and the Stop hook the second at the end of the turn, each read once with
//     how it went in;
//   - the rig set to headless over REST, a later trial runs Claude Code headless (`-p`), with
//     the same token, flags, hooks and two messages inside its turn, and submits: headless stays
//     an advanced choice, so both modes keep a trial here;
//   - the rig set back to terminals over REST, the auditor, given the subscription's model on
//     Edit rig, audits a large gain in Claude Code's own terminal in the supervisor (goal 169), as
//     an advisor user through the advisors' runner, with no tools, no settings or MCP, its effort,
//     and the token on file descriptor 3 (in no environment), without the scrub; an input typed
//     into its terminal from the owner's console (`terminal_input`, handed from the harness to the
//     supervisor) reaches it, and one owner's message to the auditor goes in inside its turn,
//     through its Stop hook and the call's own turn routes;
//   - the subscription's usage windows reach the Providers page;
//   - the token shows in no page, event or record.
// Usage: COMPOSE="podman compose" node scripts/acceptance/claude.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { acceptanceChecks } from "./lib/checks.mjs";
import {
  api,
  assign,
  candidatePatch,
  command,
  control,
  dc,
  events,
  plannerInTerminal,
  prepare,
  secret,
  submit,
  until,
} from "./lib/smoke-env.mjs";

const TOKEN = "sk-ant-oat01-acceptance-stand-in-token-0000"; // public-check: allow (a made-up token for the stand-in)
const files = ["-f", "compose.yaml", "-f", "containers/test-claude/compose.yaml"];
const composeEnv = {
  THERMITE_POLL_SECONDS: "2",
  THERMITE_PROMOTION: "auto",
  THERMITE_CALIBRATION_BLOCKS: "0",
  THERMITE_MAX_TRIALS: "1",
  THERMITE_MODEL_ROUTE_POLL_SECONDS: "2",
};
const { check, results } = acceptanceChecks({ max: 400 });

/** A form's current values from its page (inputs, checked boxes and radios, selected options). */
const formOf = (html, id) => {
  const start = html.indexOf(`<form id="${id}"`);
  const form = html.slice(start, html.indexOf("</form>", start));
  const unesc = (v) =>
    v
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  const f = {};
  for (const [, a] of form.matchAll(/<input ([^>]*)>/g)) {
    const name = /name="([^"]+)"/.exec(a)?.[1];
    const type = /type="([^"]+)"/.exec(a)?.[1] ?? "text";
    if (!name || /\sdisabled/.test(a)) continue;
    if ((type === "checkbox" || type === "radio") && !/\schecked/.test(a)) continue;
    f[name] = unesc(/value="([^"]*)"/.exec(a)?.[1] ?? "");
  }
  for (const [, name, body] of form.matchAll(/<select name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const picked =
      /<option value="([^"]*)"[^>]*\sselected/.exec(body) ?? /<option value="([^"]*)"/.exec(body);
    f[name] = unesc(picked?.[1] ?? "");
  }
  return f;
};

const env = prepare();
const contract = JSON.parse(readFileSync(env.contractFile, "utf8"));
contract.lanes = { count: 1, trials_per_epoch: 1 };
// Audits for any win above 1% (the smoke kit's good kernel wins far more).
contract.acceptance.audit = { ratio_to_median: 3, absolute: 0.01 };
writeFileSync(env.contractFile, JSON.stringify(contract));
dc(composeEnv, ...files, "up", "-d", "--build");
try {
  await until("control health", async () => (await fetch(`${control}/v1/health`)).ok);
  const reported = await until("the rig reports its settings", async () => {
    const view = (await api("/v1/rigs/local-1/view")).body;
    return view?.hardware && view.settings ? view : undefined;
  });
  check(
    "a rig nobody set runs its agent programs in their own terminal (the default)",
    reported.settings?.program_mode === "terminal",
    reported.settings,
  );
  const login = await fetch(`${control}/ui/login`, {
    method: "POST",
    body: new URLSearchParams({ token: secret("control-admin-token") }),
    redirect: "manual",
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const page = async (path) => (await fetch(`${control}${path}`, { headers: { cookie } })).text();
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(await page("/ui/settings"))?.[1] ?? "";
  const post = async (path, form) =>
    decodeURIComponent(
      String(
        (
          await fetch(`${control}${path}`, {
            method: "POST",
            body: new URLSearchParams({ csrf, ...form }),
            headers: { cookie },
            redirect: "manual",
          })
        ).headers.get("location"),
      ),
    );
  const added = await post("/ui/settings/add", {
    type: "claude",
    name: "claude-test",
    claude_token: TOKEN,
  });
  check("a Claude subscription is added in Providers", /"claude-test" is saved/.test(added), added);
  await post("/ui/settings/rigs", {
    rig: "local-1",
    harness: "pi",
    choice: `claude-test|${encodeURIComponent("opus-5.5[1m]")}`,
  });
  const model = await until("the rig runs its agents in Claude Code", async () => {
    const m = (await api("/v1/rigs/local-1/view")).body.model;
    return m?.source === "control" && m.harness === "claude-code" ? m : undefined;
  });
  check(
    "the rig took the subscription's model in Claude Code",
    model.model === "claude-opus-5-5",
    model,
  );
  // The auditor on the subscription too, through Edit rig's agents table (the form as it stands).
  const form = formOf(await page("/ui/rigs/local-1/edit"), "edit-rig");
  form.role_auditor = `claude-test|${encodeURIComponent("opus-5.5")}`;
  form.effort_auditor = "high";
  const edited = await post("/ui/rigs/local-1/edit", form);
  check(
    "the auditor is given the subscription's model on Edit rig",
    /a model for the auditor/.test(edited),
    edited,
  );
  const modelCheck = await until(
    "the model check through Claude Code",
    async () =>
      (await events()).find(
        (e) => e.kind === "rig_check_finished" && e.body.detail?.harness === "claude-code",
      ),
    300_000,
    2000,
  );
  check(
    "the model check ran one Bash call through Claude Code",
    modelCheck.body.ok === true,
    modelCheck.body.summary,
  );
  await assign(env, "smoke-1");
  // Goal 169: the planner's call runs in Claude Code's own terminal (the default), as
  // planner-<run>-<round>, with a credential bound to the call; one owner's message to the planner
  // goes in inside its turn, at its end (the Stop hook: it has no tools), and the owner's console
  // types into it.
  const plannerCall = await plannerInTerminal();
  await command("message_agent", {
    run: "smoke-1",
    to: "planner",
    text: "OWNER-PLANNER Plan the tidy-up first.",
  });
  const plannerTyped = await command("terminal_input", {
    run: "smoke-1",
    trial: plannerCall.id,
    text: "Plan the tidy-up first.",
  });
  const epoch = await until(
    "the first epoch, planned",
    async () => (await events()).find((e) => e.kind === "epoch_started" && e.subject === "smoke-1"),
    300_000,
    2000,
  );
  const planned = String(epoch.body.notes ?? "");
  check(
    "the planner planned in Claude Code's own terminal, with no tools",
    epoch.body.source === "planner" &&
      epoch.body.planner_valid === true &&
      epoch.body.assignments?.[0]?.family === "cc-tidy" &&
      /in its terminal/.test(planned) &&
      /tools=none /.test(planned),
    {
      source: epoch.body.source,
      valid: epoch.body.planner_valid,
      assignments: epoch.body.assignments,
      notes: planned,
    },
  );
  const plannerRead = (await events()).find(
    (e) => e.kind === "agent_message_read" && e.body.by === "planner",
  );
  check(
    "the planner's call in its terminal took the owner's message inside its turn, at its end, and the owner's input was typed into it",
    /^planner-smoke-1-\d+$/.test(plannerCall.id) &&
      plannerRead?.body.how === "turn-end" &&
      /the owner's message came inside its turn/.test(planned) &&
      plannerTyped.outcome?.result?.outcome === "typed",
    { call: plannerCall, read: plannerRead?.body, typed: plannerTyped.outcome },
  );
  // Goal 169: two messages to the trial while it runs; the stand-in waits for both to wait.
  const started = await until(
    "the Claude Code trial started",
    async () => (await events()).find((e) => e.kind === "trial_started" && e.subject === "smoke-1"),
    300_000,
    2000,
  );
  const trialId = String(started.body.trial);
  const messaged = new Set([trialId]);
  for (const text of ["Look at the inner loop first.", "Keep the change small."])
    await command("message_agent", { run: "smoke-1", to: `trial:${trialId}`, text });
  // Its first turn meets a full five-hour window, which resets 30 s later: the trial waits in its
  // terminal, and the owner's input sent meanwhile waits for the reset.
  const wait = await until(
    "the trial waits for its usage window in its terminal",
    async () =>
      (await events()).find((e) => e.kind === "agents_wait_for_limit" && e.body.trial === trialId),
    300_000,
    1000,
  );
  const queued = await command("terminal_input", {
    run: "smoke-1",
    trial: trialId,
    text: "OWNER-QUEUED-1 Look at the tests too.",
  });
  check(
    "a full usage window in Claude Code's terminal is the run's wait, recorded in the trial, and the owner's input sent during it waits for the reset",
    wait.body.in_trial === true &&
      Date.parse(String(wait.body.until)) > Date.parse(wait.at) &&
      queued.outcome?.result?.outcome === "queued",
    { wait: wait.body, queued: queued.outcome },
  );
  // Once the trial has its first message, it runs in the mode it started with: the rig is set to
  // headless for the trials after it.
  await until(
    "the terminal trial read its first message",
    async () =>
      (await events()).find((e) => e.kind === "agent_message_read" && e.body.trial === trialId),
    300_000,
    2000,
  );
  const headless = await api("/v1/rigs/local-1/settings", {
    method: "POST",
    body: JSON.stringify({ program_mode: "headless" }),
  });
  check(
    "the rig is set to run its agent programs headless over REST",
    headless.status === 200 && headless.body.sent?.program_mode === "headless",
    headless.body,
  );
  const attempt = await until(
    "a trial in Claude Code submitted",
    async () =>
      (await events()).find(
        (e) =>
          e.kind === "attempt_recorded" &&
          /claude code harness/.test(String(e.body.hypothesis ?? "")),
      ),
    600_000,
    3000,
  );
  const said = String(attempt.body.hypothesis);
  check(
    "Claude Code ran in its own terminal as the lane's user, with the token on file descriptor 3, its own sandbox off, no settings or MCP, its seeds and no question tool, and submitted with thermite-trial",
    /uid=10101 /.test(said) &&
      /token=set /.test(said) &&
      /token_on=fd3 /.test(said) &&
      /scrub=unset /.test(said) &&
      /strict_mcp=true /.test(said) &&
      /no_settings=true /.test(said) &&
      / mode=terminal tty=true seeded=yes bypass_warning=skipped no_questions=true /.test(said) &&
      /model=claude-opus-5-5\)/.test(said),
    said,
  );
  const trial = await until(
    "the Claude Code trial's end, with its turns",
    async () =>
      (await events()).find(
        (e) => e.kind === "trial_finished" && e.body.attempt === attempt.subject,
      ),
    120_000,
    2000,
  );
  check(
    "the controller followed Claude Code's transcript in its terminal (turns and tokens counted)",
    Number(trial.body.turns) >= 1 && Number(trial.body.tokens_in) > 0,
    trial.body,
  );
  const inputs = (await events()).filter(
    (e) => e.kind === "terminal_input" && e.body.trial === trialId,
  );
  check(
    "Claude Code waited out its usage window and went on by itself, nothing typed into it during the wait; the queued input went into its turn after the reset; the same trial submitted",
    / window=went-on typed=OWNER-QUEUED-1 typed_in_wait=0 /.test(said) &&
      inputs.map((e) => e.body.outcome).join(",") === "queued,typed_after_reset" &&
      trial.body.trial === trialId &&
      trial.body.stopped === "submitted",
    { said, inputs: inputs.map((e) => e.body), trial: trial.body },
  );
  const reads = (await events()).filter(
    (e) => e.kind === "agent_message_read" && e.body.trial === trialId,
  );
  check(
    "Thermite's hooks ran in Claude Code and gave the owner's messages inside its turn: one after a command, one at the turn's end, each read once with how",
    /hooks=\d+ steered=after-tool:owner,turn-end:owner /.test(said) &&
      Number(/hooks=(\d+)/.exec(said)?.[1]) >= 5 &&
      reads.length === 2 &&
      reads.map((e) => e.body.how).join(",") === "after-tool,turn-end",
    { said, reads: reads.map((e) => e.body) },
  );
  // Goal 070: Claude Code's PreCompact hook (Thermite's program, in the image, run as the lane's
  // user) copied the transcript and told the summary where the run keeps it; the harness kept
  // that copy in the run's research folder and recorded the compaction.
  const compacted = (await events()).find(
    (e) =>
      e.kind === "context_compacted" &&
      e.body.harness === "claude-code" &&
      e.body.trial === trialId,
  );
  const kept = String(compacted?.body.snapshot ?? "");
  check(
    "Claude Code's compaction kept its own transcript in the run's research folder, with a summary naming the file",
    /compacted=hook /.test(said) &&
      compacted?.body.number === 1 &&
      compacted?.body.how === "harness" &&
      /^compactions\/[A-Za-z0-9._-]+-1\.md$/.test(kept) &&
      String(compacted?.body.summary ?? "").includes(`/${kept}. Name that file in your summary`) &&
      /from Claude Code's own transcript of the session/.test(String(compacted?.body.text ?? "")) &&
      Number(trial.body.compactions) === 1,
    { said, compacted: compacted?.body, compactions: trial.body.compactions },
  );
  // The later trial, headless: the owner's two messages go to each trial that starts, until one
  // submits headless.
  const later = await until(
    "a trial in Claude Code submitted headless",
    async () => {
      const all = await events();
      for (const e of all.filter((x) => x.kind === "trial_started" && x.subject === "smoke-1")) {
        const id = String(e.body.trial);
        if (messaged.has(id)) continue;
        messaged.add(id);
        for (const text of ["Look at the inner loop first.", "Keep the change small."])
          await command("message_agent", { run: "smoke-1", to: `trial:${id}`, text });
      }
      return all.find(
        (e) =>
          e.kind === "attempt_recorded" &&
          /claude code harness/.test(String(e.body.hypothesis ?? "")) &&
          String(e.body.hypothesis).includes(" mode=headless "),
      );
    },
    900_000,
    3000,
  );
  const saidLater = String(later.body.hypothesis);
  const laterTrial = await until(
    "the headless trial's end",
    async () =>
      (await events()).find((e) => e.kind === "trial_finished" && e.body.attempt === later.subject),
    120_000,
    2000,
  );
  const laterReads = (await events()).filter(
    (e) => e.kind === "agent_message_read" && e.body.trial === laterTrial.body.trial,
  );
  check(
    "a trial after the change ran Claude Code headless, with the same token, flags and hooks, gave the owner's two messages inside its turn, and submitted",
    /uid=10101 /.test(saidLater) &&
      /token=set /.test(saidLater) &&
      /token_on=fd3 /.test(saidLater) &&
      /strict_mcp=true /.test(saidLater) &&
      /no_settings=true /.test(saidLater) &&
      /steered=after-tool:owner,turn-end:owner /.test(saidLater) &&
      laterReads.map((e) => e.body.how).join(",") === "after-tool,turn-end" &&
      Number(laterTrial.body.turns) >= 1,
    { said: saidLater, reads: laterReads.map((e) => e.body), trial: laterTrial.body },
  );
  // The rig set back to its agents' own terminals: the auditor's call runs in Claude Code's
  // terminal in the supervisor (goal 169), as an advisor user, through the advisors' runner.
  const inTerminals = await api("/v1/rigs/local-1/settings", {
    method: "POST",
    body: JSON.stringify({ program_mode: "terminal" }),
  });
  check(
    "the rig is set back to run its agent programs in their own terminals over REST",
    inTerminals.status === 200 && inTerminals.body.sent?.program_mode === "terminal",
    inTerminals.body,
  );
  const good = submit(
    composeEnv,
    "smoke-1",
    candidatePatch(env, "kits/smoke-cpu/candidates/good"),
    "good kernel",
  );
  // While it audits in its terminal: one input typed into it from the owner's console, then one
  // owner's message to the auditor, which goes in inside its turn through its Stop hook.
  const auditing = await until(
    "the auditor's call in its own terminal",
    async () =>
      ((await api("/v1/rigs/local-1/view")).body.summary?.work?.terminals ?? []).find(
        (x) => x.role === "auditor" && x.run === "smoke-1",
      ),
    600_000,
    1000,
  );
  const typedToAuditor = await command("terminal_input", {
    run: "smoke-1",
    trial: auditing.id,
    text: "OWNER-TYPED-AUDITOR Look at the timer code.",
  });
  await command("message_agent", {
    run: "smoke-1",
    to: "auditor",
    text: "Check the timer code before you clear it.",
  });
  const audited = await until(
    "the good kernel's audit, in Claude Code in the supervisor",
    async () =>
      (await api("/v1/rigs/local-1/view")).body.runs
        ?.find((r) => r.id === "smoke-1")
        ?.audits?.find((a) => a.attempt === good.attempt && a.decision),
    1_200_000,
    3000,
  );
  const why = String(audited.reasons ?? "");
  check(
    "the auditor ran in Claude Code's own terminal in the supervisor, as an advisor user, with no tools, no settings or MCP, its effort, the token on file descriptor 3 (in no environment) and its own sandbox off",
    audited.decision === "clear" &&
      /Claude Code stand-in/.test(why) &&
      /mode=terminal /.test(why) &&
      /uid=1008[1-8] /.test(why) &&
      /tty=true /.test(why) &&
      /seeded=yes /.test(why) &&
      /tools=none /.test(why) &&
      /effort=high /.test(why) &&
      /token=set /.test(why) &&
      /token_on=fd3 /.test(why) &&
      /scrub=unset /.test(why) &&
      /strict_mcp=true /.test(why) &&
      /no_settings=true /.test(why) &&
      /model=claude-opus-5-5/.test(why),
    { audited, id: auditing.id },
  );
  check(
    "the owner's message to the auditor went in inside its turn, through its Stop hook, and the input typed into its terminal reached it",
    /steered=turn-end:owner /.test(why) &&
      /typed=OWNER-TYPED-AUDITOR /.test(why) &&
      typedToAuditor.outcome?.result?.outcome === "typed" &&
      !/the owner's message none /.test(why),
    { why, typed: typedToAuditor.outcome },
  );
  const providers = await until(
    "the subscription's usage on the Providers page",
    async () => {
      const p = await page("/ui/settings");
      return /42% used/.test(p) ? p : undefined;
    },
    120_000,
    2000,
  );
  check(
    "the subscription's 5-hour and weekly windows reach the Providers page",
    /<b>5-hour window<\/b> · 42% used/.test(providers) &&
      /<b>Weekly window<\/b> · 17% used/.test(providers),
  );
  const everything = JSON.stringify([
    providers,
    await page("/ui/rigs/local-1"),
    await events(),
    (await api("/v1/rigs/local-1/view")).body,
  ]);
  check("the token shows in no page, event or rig record", !everything.includes(TOKEN));
} catch (err) {
  check("acceptance run", false, String(err?.stack ?? err));
} finally {
  if (process.env.KEEP !== "1") dc(composeEnv, ...files, "down", "-v");
}
const ok = results.every((r) => r.ok);
console.log(`claude acceptance: ${ok ? "OK" : "FAILED"}`);
process.exit(ok ? 0 : 1);
