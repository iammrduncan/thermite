#!/usr/bin/env node
// Codex CLI acceptance under compose, with a stand-in for the Codex CLI mounted in the harness
// (containers/test-codex; no ChatGPT plan and no download needed) and a scripted provider on this
// machine that answers OpenAI's Responses API. Through the dashboard: an OpenAI-compatible
// provider added in Providers, its model given to the rig in Codex, then:
//   - the rig takes the route; its model check runs one shell call through Codex, as the model
//     check's own user;
//   - the planner plans through Codex, as the planner's own user, with a credential minted for it;
//   - a worker trial runs Codex in its own terminal (goal 169: the default, on a rig nobody set),
//     as the lane's user, with its own home and configuration, its workspace trusted (no screen
//     waits), its approvals and sandbox off and its rollout copied for the harness, edits the
//     code and submits with thermite-trial;
//   - its first turn meets a full usage window (goal 169): the provider answers the stand-in's
//     call with a 429 and a reset 30 s away, through the harness's proxy; Codex ends its turn with
//     its own usage-limit error and does not wait. The trial waits for the reset in its terminal,
//     the reset from the proxy's answer (the rollout gives it only in words), with the run's wait
//     recorded (`agents_wait_for_limit`, in the trial); the owner's input sent during the wait
//     (`terminal_input`) is queued for the reset; after the reset the harness types its
//     continuation, the queued input goes into that turn (`typed_after_reset`), and the same trial
//     submits;
//   - it compacts once: its compaction prompt (Thermite's) names where the run keeps the
//     conversation, and the harness keeps the conversation from Codex's rollout and records it;
//   - Thermite's hooks run in it (with --dangerously-bypass-hook-trust) as the lane's user and
//     reach the harness with the trial's token: of two owner's messages sent to the running
//     trial, the PostToolUse hook gives the first after a command and the Stop hook the second at
//     the end of the turn, each read once with how it went in;
//   - the rig set to headless over REST, a later trial runs `codex exec` headless, with the same
//     home, flags, hooks and two messages inside its turn, and submits: headless stays an
//     advanced choice, so both modes keep a trial here;
//   - the auditor, given the same model in Codex over REST (goal 073), audits a large gain in
//     the Codex CLI in the supervisor: in its own folder, with the read-only sandbox, no
//     approvals asked, no shell, through the supervisor's proxy for the call with a credential
//     made for it, keeping its session there for its compactions, with Thermite's compaction
//     prompt naming the supervisor's records;
//   - every model call goes through the harness's proxy or the supervisor's, which adds the
//     provider's key: the provider sees the key and never a trial's, a check's or a call's
//     credential;
//   - the key shows in no page, event or record.
// A ChatGPT sign-in takes the same route and the same proxy (the unit tests cover its route and
// its full plan); control's sign-in with OpenAI is not stood in for here.
// Usage: COMPOSE="podman compose" node scripts/acceptance/codex.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { acceptanceChecks } from "./lib/checks.mjs";
import { hostName as containersHost } from "./lib/scripted-model.mjs";
import {
  api,
  assign,
  candidatePatch,
  command,
  control,
  dc,
  events,
  prepare,
  secret,
  submit,
  until,
} from "./lib/smoke-env.mjs";

const KEY = "provider-key-codex-acceptance"; // public-check: allow (a made-up key for the stand-in)
const files = ["-f", "compose.yaml", "-f", "containers/test-codex/compose.yaml"];
const composeEnv = {
  THERMITE_POLL_SECONDS: "2",
  THERMITE_PROMOTION: "auto",
  THERMITE_CALIBRATION_BLOCKS: "0",
  THERMITE_MAX_TRIALS: "1",
  THERMITE_MODEL_ROUTE_POLL_SECONDS: "2",
};
const { check, results } = acceptanceChecks({ max: 400 });

/** Seconds from the usage window the provider answers to its reset. */
const WINDOW_S = 30;
/**
 * The provider: its model list for control, and a short Responses stream for each call, but for
 * the stand-in's first `usage-window` call, which meets a full usage window: a 429 with the reset in
 * its Retry-After, as Codex's own usage-limit error.
 */
const seen = { keys: new Set(), paths: [], window: undefined };
const provider = createServer((req, res) => {
  // What each Responses call carried (control's own model list carries the key too).
  if (req.url === "/v1/responses") seen.keys.add(String(req.headers.authorization ?? ""));
  seen.paths.push(`${req.method} ${req.url}`);
  let raw = "";
  req.on("data", (d) => {
    raw += d;
  });
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/v1/responses" && !seen.window) {
      let input;
      try {
        input = JSON.parse(raw).input;
      } catch {
        input = undefined;
      }
      if (input === "usage-window") {
        seen.window = new Date(Date.now() + WINDOW_S * 1000).toISOString();
        res.writeHead(429, { "content-type": "application/json", "retry-after": String(WINDOW_S) });
        res.end(
          JSON.stringify({
            error: {
              type: "usage_limit_reached",
              message: "The usage limit has been reached",
              resets_in_seconds: WINDOW_S,
            },
          }),
        );
        return;
      }
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "scripted", context_length: 32768 }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/responses") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `event: response.created\ndata: ${JSON.stringify({ type: "response.created" })}\n\n`,
      );
      res.end(
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}\n\n`,
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "only the model list and Responses here" } }));
  });
});
await new Promise((r) => provider.listen(0, "0.0.0.0", r));
const base = `http://${containersHost()}:${provider.address().port}/v1`;

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
  await post("/ui/settings/providers", {
    name: "openai-test",
    type: "openai",
    base_url: base,
    api_key: KEY,
  });
  const given = await post("/ui/settings/rigs", {
    rig: "local-1",
    harness: "codex",
    choice: "openai-test|scripted",
  });
  check(
    "the rig is given the provider's model in Codex",
    /local-1 takes scripted from "openai-test" under Codex/.test(given),
    given,
  );
  const model = await until("the rig runs its agents in Codex", async () => {
    const m = (await api("/v1/rigs/local-1/view")).body.model;
    return m?.source === "control" && m.harness === "codex" ? m : undefined;
  });
  check("the rig took the route in Codex", model.model === "scripted", model);
  // The auditor on the same model in Codex, over REST (goal 073): it runs in the supervisor.
  const auditor = await api("/v1/rigs/local-1/model", {
    method: "POST",
    body: JSON.stringify({
      agent: "auditor",
      provider: "openai-test",
      model: "scripted",
      harness: "codex",
    }),
  });
  check(
    "the auditor is given the provider's model in Codex over REST",
    auditor.status === 200 && auditor.body.agents?.auditor?.harness === "codex",
    auditor.body,
  );
  const modelCheck = await until(
    "the model check through Codex",
    async () =>
      (await events()).find(
        (e) => e.kind === "rig_check_finished" && e.body.detail?.harness === "codex",
      ),
    300_000,
    2000,
  );
  check(
    "the model check ran one shell call through Codex",
    modelCheck.body.ok === true,
    modelCheck.body.summary,
  );
  await assign(env, "smoke-1");
  const epoch = await until(
    "the first epoch, planned",
    async () => (await events()).find((e) => e.kind === "epoch_started" && e.subject === "smoke-1"),
    300_000,
    2000,
  );
  const planned = String(epoch.body.notes ?? "");
  check(
    "the planner planned through Codex, as the planner's user, through the proxy with a minted credential",
    epoch.body.source === "planner" &&
      epoch.body.planner_valid === true &&
      epoch.body.assignments?.[0]?.family === "cx-tidy" &&
      /uid=10040 /.test(planned) &&
      /auth=proxy /.test(planned) &&
      /proxied=200 /.test(planned),
    { source: epoch.body.source, valid: epoch.body.planner_valid, notes: planned },
  );
  // Goal 169: two messages to the trial while it runs; the stand-in waits for both to wait.
  const started = await until(
    "the Codex trial started",
    async () => (await events()).find((e) => e.kind === "trial_started" && e.subject === "smoke-1"),
    300_000,
    2000,
  );
  const trialId = String(started.body.trial);
  const messaged = new Set([trialId]);
  for (const text of ["Look at the inner loop first.", "Keep the change small."])
    await command("message_agent", { run: "smoke-1", to: `trial:${trialId}`, text });
  // Its first turn meets a full usage window, which resets 30 s later: the trial waits in its
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
  const resetAt = Date.parse(String(wait.body.until));
  check(
    "Codex's full usage window is the run's wait, recorded in the trial, until the reset in the proxy's answer, and the owner's input sent during it waits for the reset",
    wait.body.in_trial === true &&
      seen.window !== undefined &&
      Math.abs(resetAt - Date.parse(seen.window)) < 5_000 &&
      queued.outcome?.result?.outcome === "queued",
    { wait: wait.body, window: seen.window, queued: queued.outcome },
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
    "a trial in Codex submitted",
    async () =>
      (await events()).find(
        (e) =>
          e.kind === "attempt_recorded" && /codex harness/.test(String(e.body.hypothesis ?? "")),
      ),
    600_000,
    3000,
  );
  const said = String(attempt.body.hypothesis);
  check(
    "Codex ran in its own terminal as the lane's user with its own home, its workspace trusted, approvals and sandbox off, reached the model through the proxy with the trial's token, and submitted with thermite-trial",
    /uid=10101 /.test(said) &&
      /home=own /.test(said) &&
      /proxy_url=harness /.test(said) &&
      /auth=trial /.test(said) &&
      /proxied=200 /.test(said) &&
      /bypass=true /.test(said) &&
      / mode=terminal tty=true trusted=yes no_daemon=true hook_trust=true /.test(said) &&
      /model=scripted\)/.test(said),
    said,
  );
  const trial = await until(
    "the Codex trial's end, with its turns",
    async () =>
      (await events()).find(
        (e) => e.kind === "trial_finished" && e.body.attempt === attempt.subject,
      ),
    120_000,
    2000,
  );
  check(
    "the controller followed Codex's rollout in its terminal (turns and tokens counted)",
    Number(trial.body.turns) >= 1 && Number(trial.body.tokens_in) > 0,
    trial.body,
  );
  const inputs = (await events()).filter(
    (e) => e.kind === "terminal_input" && e.body.trial === trialId,
  );
  const typedAt = Date.parse(
    String(inputs.find((e) => e.body.outcome === "typed_after_reset")?.at ?? ""),
  );
  check(
    "after the reset the harness typed its continuation into Codex, the queued input went into that turn, nothing was typed during the wait, and the same trial submitted",
    / window=went-on typed=OWNER-QUEUED-1 typed_in_wait=0 /.test(said) &&
      inputs.map((e) => e.body.outcome).join(",") === "queued,typed_after_reset" &&
      typedAt >= resetAt &&
      trial.body.trial === trialId &&
      trial.body.stopped === "submitted",
    { said, inputs: inputs.map((e) => ({ at: e.at, ...e.body })), trial: trial.body },
  );
  const reads = (await events()).filter(
    (e) => e.kind === "agent_message_read" && e.body.trial === trialId,
  );
  check(
    "Thermite's hooks ran in Codex and gave the owner's messages inside its turn: one after a command, one at the turn's end, each read once with how",
    /hooks=\d+ steered=after-tool:owner,turn-end:owner /.test(said) &&
      Number(/hooks=(\d+)/.exec(said)?.[1]) >= 5 &&
      reads.length === 2 &&
      reads.map((e) => e.body.how).join(",") === "after-tool,turn-end",
    { said, reads: reads.map((e) => e.body) },
  );
  // Goal 070: Codex's compaction prompt named where the run keeps the conversation; the harness
  // read Codex's rollout of the thread from the lane's area and kept it in the run's research
  // folder, with Codex's summary.
  const compacted = (await events()).find(
    (e) => e.kind === "context_compacted" && e.body.harness === "codex" && e.body.trial === trialId,
  );
  const kept = String(compacted?.body.snapshot ?? "");
  check(
    "Codex's compaction kept its own rollout in the run's research folder, with a summary naming the file",
    /compacted=rollout /.test(said) &&
      compacted?.body.number === 1 &&
      compacted?.body.how === "harness" &&
      /^compactions\/[A-Za-z0-9._-]+-1\.md$/.test(kept) &&
      String(compacted?.body.summary ?? "").endsWith(`/${kept}.`) &&
      /from the Codex CLI's own rollout of the thread/.test(String(compacted?.body.text ?? "")) &&
      Number(trial.body.compactions) === 1,
    { said, compacted: compacted?.body, compactions: trial.body.compactions },
  );
  const good = submit(
    composeEnv,
    "smoke-1",
    candidatePatch(env, "kits/smoke-cpu/candidates/good"),
    "good kernel",
  );
  const audited = await until(
    "the good kernel's audit, in Codex in the supervisor",
    async () =>
      (await api("/v1/rigs/local-1/view")).body.runs
        ?.find((r) => r.id === "smoke-1")
        ?.audits?.find((a) => a.attempt === good.attempt && a.decision),
    1_200_000,
    3000,
  );
  const why = String(audited.reasons ?? "");
  check(
    "the auditor ran in Codex in the supervisor, as an advisor user in its own folder, with the read-only sandbox, no approvals asked and no shell, through the supervisor's proxy with a credential made for the call",
    audited.decision === "clear" &&
      /Codex stand-in/.test(why) &&
      /sandbox=read-only /.test(why) &&
      /approvals=never /.test(why) &&
      /shell_off=true /.test(why) &&
      /advisor_proxy=supervisor /.test(why) &&
      /ephemeral=false /.test(why) &&
      /compact_prompt=supervisor /.test(why) &&
      /bypass=false /.test(why) &&
      /own_folder=true /.test(why) &&
      // As one of the advisor users (advisor-1..advisor-8), never the supervisor's own.
      /uid=100(8[1-8]) /.test(why) &&
      /auth=proxy /.test(why) &&
      /proxied=200 /.test(why) &&
      /model=scripted\)/.test(why),
    audited,
  );
  // The later trial, headless: the owner's two messages go to each trial that starts, until one
  // submits headless.
  const later = await until(
    "a trial in Codex submitted headless",
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
          /codex harness/.test(String(e.body.hypothesis ?? "")) &&
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
    "a trial after the change ran `codex exec` headless, with its own home, the proxy, its flags and hooks, gave the owner's two messages inside its turn, and submitted",
    /uid=10101 /.test(saidLater) &&
      /home=own /.test(saidLater) &&
      /auth=trial /.test(saidLater) &&
      /proxied=200 /.test(saidLater) &&
      /bypass=true /.test(saidLater) &&
      /ignore_rules=true /.test(saidLater) &&
      /steered=after-tool:owner,turn-end:owner /.test(saidLater) &&
      laterReads.map((e) => e.body.how).join(",") === "after-tool,turn-end" &&
      Number(laterTrial.body.turns) >= 1,
    { said: saidLater, reads: laterReads.map((e) => e.body), trial: laterTrial.body },
  );
  check(
    "every Responses call reached the provider with its own key, added by the proxy, never a run's credential",
    seen.keys.size === 1 &&
      seen.keys.has(`Bearer ${KEY}`) &&
      seen.paths.filter((p) => p === "POST /v1/responses").length >= 4,
    { keys: [...seen.keys].map((k) => k.slice(0, 16)), paths: [...new Set(seen.paths)] },
  );
  const everything = JSON.stringify([
    await page("/ui/settings"),
    await page("/ui/rigs/local-1"),
    await events(),
    (await api("/v1/rigs/local-1/view")).body,
  ]);
  check("the key shows in no page, event or rig record", !everything.includes(KEY));
} catch (err) {
  check("acceptance run", false, String(err?.stack ?? err));
} finally {
  provider.close();
  if (process.env.KEEP !== "1") dc(composeEnv, ...files, "down", "-v");
}
const ok = results.every((r) => r.ok);
console.log(`codex acceptance: ${ok ? "OK" : "FAILED"}`);
process.exit(ok ? 0 : 1);
