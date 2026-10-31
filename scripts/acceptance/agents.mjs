#!/usr/bin/env node
// M4 agents acceptance under compose, with a scripted OpenAI-compatible model on the host (a
// real model route is not needed to check the machinery). One epoch on the smoke campaign:
//   - the planner plans through the model and the plan is valid;
//   - each lane's worker runs in its own process, edits its workspace as the lane's user through
//     the broker, builds with the shell tool, uses dev_run, and submits once;
//   - the judge decides both submissions; control reports the agents' figures;
//   - a lane's background work runs on across its commands and a dev run, as in a shell;
//   - no lane process outlives its trial;
//   - control's model check reaches the model through the rig's route with a correct tool call;
//   - in Pi, the first epoch's planner plans in its Pi view, in a process of its own, takes an
//     owner's message before its next model call and /status typed into its console;
//   - under OpenCode, the planner plans in its own terminal and takes an owner's message in its turn;
//   - under OpenCode, a hill-climb trial runs in OpenCode's own terminal (goal 169: the default,
//     on a rig nobody set), its server first and its terminal attached, and submits with
//     thermite-trial; then, the rig set to headless over REST, a research run's trial runs
//     headless (headless stays an advanced choice, so both modes keep a trial here) and runs the
//     research tools as `thermite-trial research` commands;
//   - that trial reads and searches its run's research folder, is refused changing the harness's
//     part of it, and the file it writes in its working area is saved when it ends;
//   - the Pi view (goal 169): the workers of the first epoch, in Pi on a rig nobody set, run in
//     their own terminal, where each draws its Pi view; while lane-2's trial holds in a command,
//     the owner's console (terminal_input over REST) sends each of the view's calls in turn:
//     words that steer, /status, /mcp, /mcp reconnect (refused: the kit has no MCP server),
//     /skill:NAME (refused: the kit carries no skills), a command the view has not (refused),
//     /compact, words as a follow-up, and Esc. Each is recorded word for word with its outcome;
//     the model gets the steered words and the follow-up, the conversation is compacted once, the
//     interrupt does not end the trial, which submits; and Live shows the view's screen.
// Usage: COMPOSE="podman compose" node scripts/acceptance/agents.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acceptanceChecks } from "./lib/checks.mjs";
import {
  opencodePlanner,
  opencodePlannerScene,
  piPlannerScene,
  piPlannerTurn,
} from "./lib/planner-terminal.mjs";
import { hostName as containersHost, scriptedModel } from "./lib/scripted-model.mjs";
import {
  api,
  assign,
  command,
  control,
  dc,
  dcLogs,
  events,
  latestVerdicts,
  lifecycles,
  prepare,
  rigCheck,
  secret,
  sleep,
  until,
} from "./lib/smoke-env.mjs";
import { screenOnLive, typeInto } from "./lib/terminals.mjs";

const GOOD = readFileSync("kits/smoke-cpu/candidates/good/src/kernel/matmul.c", "utf8");
/** lane-2's trial in its Pi view (goal 169): when it held, and what its model was sent. */
const piScene = {};
/** The owner's inputs to lane-2's Pi view, in order, and what each must become. */
const PI_INPUTS = [
  { input: { text: "PI-STEER keep the kernel as it is" }, want: "typed" },
  { input: { text: "/status" }, want: "typed" },
  { input: { text: "/mcp" }, want: "typed" },
  { input: { text: "/mcp reconnect" }, want: /gives its workers no MCP servers/ },
  { input: { text: "/skill:profile" }, want: /this run's kit carries no skills/ },
  { input: { text: "/model another" }, want: /is not a command of the Pi view/ },
  { input: { text: "/compact" }, want: "typed" },
  { input: { text: "PI-FOLLOW then restate it", follow_up: true }, want: "typed" },
  { input: { keys: ["esc"] }, want: "typed" },
];
const NOOP = readFileSync("kits/smoke-cpu/candidates/noop/src/kernel/matmul.c", "utf8");
const setid = {};
const background = {};
/** What the OpenCode research trial's commands answered, as its tool results show. */
const researchSeen = {};
/** A tool result's text: OpenCode sends it as a string or as text parts. */
const textOf = (c) =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.map((p) => (typeof p?.text === "string" ? p.text : "")).join("\n")
      : String(c ?? "");

/**
 * The OpenCode research trial: each research tool as a shell command, in turn. Its fetch names
 * this machine's scripted model, a private address, which the harness's fetcher must refuse.
 * From its working area, where the shell starts, it reads and searches the run's research
 * folder, tries to change the harness's part of it, and writes a file of its own.
 */
function researchSteps() {
  const shell = (command) => ({ name: "shell", args: { command, timeout: 0 } });
  return [
    shell(`thermite-trial research fetch http://${hostName}:${port}/paper`),
    shell("thermite-trial research add_note 'opencode research note: the fetch was refused'"),
    shell(
      `thermite-trial research update_section - <<'EOF'\n{"name": "opencode", "body": "Written with thermite-trial in OpenCode."}\nEOF`,
    ),
    // The folder's index, and the note just recorded, found by searching all of the folder.
    shell("head -n 1 ../../INDEX.md; grep -rl 'opencode research note' ../.. 2>/dev/null"),
    // Two of the harness's files and two new ones in its folders: each must be refused. The
    // words of each answer are put together in the shell, so the command itself holds neither.
    shell(
      'a=ALLOWED; r=REFUSED; for f in INDEX.md REPORT.md claims/c-forged.md lanes/forged.md; do if (echo forged >> "../../$f") 2>/dev/null; then echo "FOLDER-WRITE-$a $f"; else echo "FOLDER-WRITE-$r $f"; fi; done',
    ),
    shell("printf 'Read next: the sources on quotes.\\n' > synthesis.md && ls synthesis.md"),
    shell("thermite-trial research progress"),
  ];
}

/** A dashboard session: sign in with the admin token, keep the cookie, post forms. */
async function dashboard() {
  const login = await fetch(`${control}/ui/login`, {
    method: "POST",
    body: new URLSearchParams({ token: secret("control-admin-token") }),
    redirect: "manual",
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const page = async (path) => (await fetch(`${control}${path}`, { headers: { cookie } })).text();
  const post = async (path, form) =>
    (
      await fetch(`${control}${path}`, {
        method: "POST",
        body: new URLSearchParams(form),
        headers: { cookie },
        redirect: "manual",
      })
    ).status;
  return { page, post };
}

/** The scripted model: plans with submit_plan; lane-1 improves the kernel, lane-2 restates it. */
function script(messages, tools) {
  const names = tools.map((t) => t.function.name);
  // OpenCode (its own tools, shell among them): its model check, then a trial that edits the
  // kernel and submits with thermite-trial. A request without tools names the session.
  if (names.includes("shell") && names.includes("execute")) {
    const asked = JSON.stringify(messages);
    // The planner in OpenCode's own terminal (lib/planner-terminal.mjs).
    const planned = opencodePlanner(messages, asked);
    if (planned) return planned;
    const word = /run exactly this command: echo (thermite-[a-z0-9]+)/.exec(asked)?.[1];
    const tools = messages.filter((m) => m.role === "tool").length;
    if (word) {
      if (tools) return { text: "done" };
      return { toolCalls: [{ name: "shell", args: { command: `echo ${word}` } }] };
    }
    // A research run's trial: the research prompt, OpenCode's own tools.
    if (asked.includes("research worker in an automated research campaign")) {
      researchSeen.prompt = true;
      const step = researchSteps()[tools];
      return step ? { toolCalls: [step] } : { text: "done for this trial" };
    }
    // A trial: first a command that takes the lane over its memory limit (the broker kills it
    // and spares OpenCode), then the change and its submission, then done.
    if (tools === 0)
      return {
        toolCalls: [
          {
            name: "shell",
            args: {
              command:
                "python3 -c 'import time; b = bytearray(int(2.5 * 1024**3)); time.sleep(20)'",
              timeout: 0,
            },
          },
        ],
      };
    if (tools > 1) return { text: "done" };
    return {
      toolCalls: [
        {
          name: "shell",
          args: {
            command:
              "printf '\\n/* tidied */\\n' >> src/kernel/matmul.c && thermite-trial submit --hypothesis 'opencode harness: a tidied kernel'",
            timeout: 0,
          },
        },
      ],
    };
  }
  if (!tools.length) return { text: "A Thermite trial" };
  // The rig's model check: echo back the word it was given.
  if (tools.some((t) => t.function.name === "echo")) {
    if (messages.some((m) => m.role === "tool")) return { text: "done" };
    const word = /the word (\S+)\./.exec(JSON.stringify(messages))?.[1] ?? "";
    return { toolCalls: [{ name: "echo", args: { word } }] };
  }
  if (tools.some((t) => t.function.name === "submit_plan")) {
    const held = piPlannerTurn(messages, tools);
    if (held) return held;
    return {
      toolCalls: [
        {
          name: "submit_plan",
          args: {
            new_families: [{ id: "loop-order", description: "change the loop order for locality" }],
            assignments: [
              {
                lane: "lane-1",
                family: "loop-order",
                focus: "make the inner loop contiguous",
                parent: "champion",
              },
              {
                lane: "lane-2",
                family: "loop-order",
                focus: "tidy the kernel",
                parent: "champion",
              },
            ],
          },
        },
      ],
    };
  }
  const brief = JSON.stringify(messages.find((m) => m.role === "user") ?? "");
  const lane1 = brief.includes("lane-1");
  const done = messages.filter((m) => m.role === "tool").length;
  const steps = lane1
    ? [
        { name: "list_files", args: {} },
        { name: "read_file", args: { path: "src/kernel/matmul.c" } },
        { name: "write_file", args: { path: "src/kernel/matmul.c", content: GOOD } },
        // Background work outlives the command that started it (and the dev run below); the
        // trial's end takes it.
        {
          name: "run",
          args: { command: 'sleep 900 > /dev/null 2>&1 & echo $! > bg.pid; echo "BG-STARTED yes"' },
        },
        {
          name: "run",
          args: {
            command:
              "cc -O2 -std=c11 -Iinclude -c src/kernel/matmul.c -o /tmp/k.o || cc -O2 -std=c11 -Iinclude -c src/kernel/matmul.c -o k.o",
          },
        },
        // A setgid file left in the workspace must lose its bit once the run ends (the broker
        // clears set-id bits after every lane run).
        {
          name: "run",
          args: {
            command: 'cp /bin/true sg && chmod g+s sg && echo "SETID-BEFORE $(stat -c %A sg)"',
          },
        },
        { name: "run", args: { command: 'echo "SETID-AFTER $(stat -c %A sg)"; rm -f sg' } },
        { name: "dev_run", args: { command: "cc --version | head -1" } },
        {
          name: "run",
          args: {
            command:
              'if kill -0 "$(cat bg.pid)" 2>/dev/null; then echo "BG-ALIVE yes"; else echo "BG-ALIVE no"; fi',
          },
        },
        {
          name: "submit",
          args: { hypothesis: "i-k-j loop order makes the inner loop contiguous" },
        },
      ]
    : undefined;
  if (!steps) return piSteps(messages, done);
  return steps[done] ? { toolCalls: [steps[done]] } : { text: "done" };
}

/**
 * lane-2's trial, in its Pi view (goal 169): it holds in a command while the owner's inputs
 * arrive; then, once the follow-up has reached it (a reply without a tool call gives it its
 * chance), it restates the kernel and submits.
 */
function piSteps(messages, done) {
  const sent = JSON.stringify(messages);
  if (done === 0) {
    piScene.holdAt ??= Date.now();
    return { toolCalls: [{ name: "run", args: { command: "sleep 90; echo PI-HOLD-DONE" } }] };
  }
  if (sent.includes("PI-STEER")) piScene.steered = true;
  if (!sent.includes("PI-FOLLOW")) return { text: "I stop here for now." };
  piScene.followed = true;
  const steps = [
    { name: "write_file", args: { path: "src/kernel/matmul.c", content: NOOP } },
    { name: "submit", args: { hypothesis: "restate the kernel" } },
  ];
  return steps[done - 1] ? { toolCalls: [steps[done - 1]] } : { text: "done" };
}

/**
 * The owner's console into lane-2's Pi view (goal 169), while its trial holds in a command: each
 * input in turn, then the screen as Live shows it.
 */
async function piConsoleScene() {
  await until("lane-2's trial holds in its Pi view", async () => piScene.holdAt, 900_000, 1000);
  const started = await until("lane-2's trial", async () =>
    (await events()).find(
      (e) => e.kind === "trial_started" && e.subject === "smoke-1" && e.body.lane === "lane-2",
    ),
  );
  const trial = String(started.body.trial);
  const sent = [];
  for (const { input, want } of PI_INPUTS)
    sent.push({ input, want, command: await typeInto(trial, input) });
  return { trial, sent, frame: await screenOnLive(trial) };
}

/** Whether the OpenCode trial's memory hog came back killed (the lane's memory limit). */
const hogSeen = {};
const model = await scriptedModel(script, {
  // Anything else but a model call: the research fetch reached this machine, which the
  // harness's fetcher must refuse before it connects.
  other: (req) => {
    researchSeen.reachedPrivate = `${req.method} ${req.url}`;
  },
  observe: (messages) => {
    for (const m of messages) {
      // The broker kills the whole command, shell and all; OpenCode's shell tool says so.
      if (m.role === "tool" && /Killed by SIGKILL/.test(JSON.stringify(m.content ?? "")))
        hogSeen.killed = true;
      if (m.role === "tool") {
        const out = textOf(m.content);
        if (/refusing a private or local address/.test(out)) researchSeen.refused = true;
        if (/"note":\s*\d+/.test(out)) researchSeen.note = true;
        if (/"section":\s*"opencode"/.test(out)) researchSeen.section = true;
        if (/"questions":\s*\[/.test(out)) researchSeen.progress = true;
        // The research folder, as the trial's shell saw it.
        if (/# Research through OpenCode/.test(out)) researchSeen.index = true;
        if (/notes\/note-\d{5}\.md/.test(out)) researchSeen.searched = true;
        for (const hit of out.matchAll(/FOLDER-WRITE-(ALLOWED|REFUSED) (\S+)/g)) {
          researchSeen.writes ??= {};
          researchSeen.writes[hit[2]] = hit[1];
        }
      }
      for (const hit of JSON.stringify(m.content ?? "").matchAll(/SETID-(BEFORE|AFTER) (\S+)/g))
        setid[hit[1]] = hit[2];
      for (const hit of JSON.stringify(m.content ?? "").matchAll(/BG-(STARTED|ALIVE) (yes|no)/g))
        background[hit[1]] = hit[2];
    }
  },
});
/** The keys the model was asked with (a route set on control's settings page brings its own). */
const keysSeen = model.keys;
const port = model.port;
const hostName = containersHost();

const composeEnv = {
  THERMITE_POLL_SECONDS: "2",
  THERMITE_PROMOTION: "auto",
  THERMITE_CALIBRATION_BLOCKS: "0",
  THERMITE_MODEL_BASE_URL: `http://${hostName}:${port}/v1`,
  THERMITE_MODEL: "scripted",
  THERMITE_MAX_TRIALS: "2",
  THERMITE_MODEL_ROUTE_POLL_SECONDS: "2",
};
const report = {
  started_at: new Date().toISOString(),
  compose: process.env.COMPOSE ?? "podman compose",
  checks: [],
};
const { check } = acceptanceChecks({ max: 300, into: report.checks });

const env = prepare();
// One epoch of one trial per lane, two lanes.
const contract = JSON.parse(readFileSync(env.contractFile, "utf8"));
contract.lanes = { count: 2, trials_per_epoch: 1 };
writeFileSync(env.contractFile, JSON.stringify(contract));
dc(composeEnv, "up", "-d", "--build");
let failed = false;
try {
  await until("control health", async () => (await fetch("http://127.0.0.1:8800/v1/health")).ok);
  await assign(env, "smoke-1");
  // lane-2's Pi view, while the epoch runs (goal 169).
  const piRun = piConsoleScene().catch((err) => ({ error: String(err?.stack ?? err) }));
  // The first epoch's planner in its Pi view (lib/planner-terminal.mjs).
  await piPlannerScene(check);
  const evs = await until(
    "both lanes judged",
    async () => {
      const all = await events();
      const trials = all.filter(
        (e) => e.kind === "trial_finished" && e.body.attempt && e.body.epoch === 1,
      );
      // Settled: judged to the end (a screened win also has to finish its confirmation).
      const life = lifecycles(all);
      const settled = [
        "judged",
        "promoted",
        "rejected_v0",
        "duplicate",
        "errored",
        "awaiting_approval",
      ];
      return trials.length >= 2 && trials.every((t) => settled.includes(life[t.body.attempt]))
        ? all
        : undefined;
    },
    1_200_000,
    3000,
  );
  const epoch = evs.find((e) => e.kind === "epoch_started");
  check(
    "the planner planned the epoch through the model, validly",
    epoch?.body.source === "planner" && epoch?.body.planner_valid === true,
    epoch?.body,
  );
  const trials = evs.filter((e) => e.kind === "trial_finished" && e.body.epoch === 1);
  check(
    "each lane's worker submitted once",
    trials.filter((t) => t.body.stopped === "submitted").length === 2,
    trials.map((t) => [t.body.lane, t.body.stopped]),
  );
  const verdicts = latestVerdicts(evs);
  const byLane = Object.fromEntries(trials.map((t) => [t.body.lane, verdicts[t.body.attempt]]));
  check("lane-1's better kernel was confirmed", byLane["lane-1"] === "win_confirmed", byLane);
  check(
    "lane-2's restated kernel was not a win",
    ["neutral", "inconclusive", "regress"].includes(byLane["lane-2"]),
    byLane,
  );
  check(
    "dev_run ran on the device",
    evs.some((e) => e.kind === "dev_run"),
    evs.filter((e) => e.kind === "dev_run").map((e) => e.body),
  );
  // The Pi view (goal 169): each input's outcome, its record, what the model was sent, the
  // compaction, and the screen on Live.
  const pi = await piRun;
  const outcomeOf = (c) =>
    c?.status !== "delivered" || c?.outcome?.accepted === false
      ? `refused: ${JSON.stringify(c?.outcome ?? c)}`
      : String(c?.outcome?.result?.outcome);
  const outcomes = (pi.sent ?? []).map((x) => ({
    input: x.input.text ?? x.input.keys,
    want: String(x.want),
    got: outcomeOf(x.command),
  }));
  check(
    "the owner's console reaches lane-2's Pi view: each call typed, or refused in words",
    outcomes.length === PI_INPUTS.length &&
      (pi.sent ?? []).every((x, i) =>
        typeof PI_INPUTS[i].want === "string"
          ? outcomeOf(x.command) === PI_INPUTS[i].want
          : PI_INPUTS[i].want.test(outcomeOf(x.command)),
      ),
    { error: pi.error, outcomes },
  );
  const piRecords = evs.filter((e) => e.kind === "terminal_input" && e.body.trial === pi.trial);
  const piTrial = trials.find((t) => t.body.trial === pi.trial);
  check(
    "each input is recorded word for word with its outcome; the model got the steered words and the follow-up; the conversation was compacted; the interrupt did not end the trial, which submitted",
    piRecords.length === PI_INPUTS.length &&
      piRecords.some((e) => e.body.text === "PI-FOLLOW then restate it" && e.body.follow_up) &&
      piRecords.some(
        (e) => JSON.stringify(e.body.keys) === '["esc"]' && e.body.outcome === "typed",
      ) &&
      piScene.steered === true &&
      piScene.followed === true &&
      evs.some((e) => e.kind === "context_compacted" && e.body.trial === pi.trial) &&
      piTrial?.body.stopped === "submitted",
    {
      records: piRecords.map((e) => [e.body.text ?? e.body.keys, e.body.outcome]),
      steered: piScene.steered,
      followed: piScene.followed,
      stopped: piTrial?.body.stopped,
    },
  );
  const frame = pi.frame;
  check(
    "Live shows lane-2's Pi view: Thermite's drawing of its Pi session, with the owner's words",
    typeof frame?.data === "string" &&
      frame.data.includes("Thermite's view of a worker in Pi") &&
      frame.data.includes("PI-STEER") &&
      (frame.pi_view === true || frame.state === "ended"),
    { state: frame?.state, pi_view: frame?.pi_view, chars: frame?.data?.length },
  );
  const view = (await api("/v1/rigs/local-1/view")).body;
  const agents = view.runs[0].agents;
  const modelCheck = await rigCheck("model");
  check(
    "control's model check: a correct tool call through the rig's route",
    modelCheck.ok === true,
    {
      summary: modelCheck.summary,
      detail: modelCheck.detail,
    },
  );
  // A provider entered on control's settings page: control lists its models, the rig takes one,
  // and its model check goes through it with the provider's own key. The key shows nowhere.
  const providerKey = "provider-key-acceptance-0001";
  const ui = await dashboard();
  const settings = await ui.page("/ui/settings");
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(settings)?.[1] ?? "";
  await ui.post("/ui/settings/providers", {
    csrf,
    name: "scripted-provider",
    type: "openai",
    base_url: `http://${hostName}:${port}/v1`,
    api_key: providerKey,
  });
  const listed = await ui.page("/ui/settings");
  await ui.post("/ui/settings/rigs", {
    csrf,
    rig: "local-1",
    choice: "scripted-provider|scripted",
  });
  const taken = await until("the rig takes the provider's model", async () => {
    const m = (await api("/v1/rigs/local-1/view")).body.model;
    return m?.source === "control" && m.name === "scripted-provider" ? m : undefined;
  });
  keysSeen.clear();
  const routeCheck = await rigCheck("model");
  const pages = [await ui.page("/ui/settings"), await ui.page("/ui/rigs/local-1")].join("");
  check(
    "a provider from the settings page lists its models, reaches the rig and its model, and its key shows nowhere",
    /1 model/.test(listed) &&
      routeCheck.ok === true &&
      keysSeen.has(`Bearer ${providerKey}`) &&
      !pages.includes(providerKey) &&
      !JSON.stringify(await events()).includes(providerKey),
    { taken, summary: routeCheck.summary, keys: keysSeen.size },
  );
  // The OpenCode harness with the same provider: OpenCode runs as the lane, in its own terminal
  // on a rig nobody set, submits with thermite-trial, and reaches the provider only through the
  // harness's proxy, which adds the key.
  check(
    "a rig nobody set runs its agent programs in their own terminal (the default)",
    view.settings?.program_mode === "terminal",
    view.settings,
  );
  await ui.post("/ui/settings/rigs", {
    csrf,
    rig: "local-1",
    choice: "scripted-provider|scripted",
    harness: "opencode",
  });
  await until("the rig runs the model under OpenCode", async () => {
    const m = (await api("/v1/rigs/local-1/view")).body.model;
    return m?.source === "control" && m.harness === "opencode" ? m : undefined;
  });
  // Cleared before the planner's scene: OpenCode's trial may run, and ask with its key, while the
  // scene waits for the planner's next round.
  keysSeen.clear();
  await opencodePlannerScene(check);
  const ocCheck = await until(
    "OpenCode's model check (run when the rig took the route)",
    async () =>
      (await events()).find(
        (e) => e.kind === "rig_check_finished" && e.body.detail?.harness === "opencode",
      ),
    300_000,
    2000,
  );
  const ocAttempt = await until(
    "a trial under OpenCode submitted",
    async () =>
      (await events()).find(
        (e) =>
          e.kind === "attempt_recorded" && /opencode harness/.test(String(e.body.hypothesis ?? "")),
      ),
    600_000,
    3000,
  );
  // The controller follows OpenCode's output in the lane's area: the trial's turns are counted.
  const ocTrial = await until(
    "the OpenCode trial's end, with its turns",
    async () =>
      (await events()).find(
        (e) => e.kind === "trial_finished" && e.body.attempt === ocAttempt.subject,
      ),
    120_000,
    2000,
  );
  // The harness says where it started each program in its terminal (cli/terminal.ts).
  const terminalStarts = () =>
    dcLogs(composeEnv, "harness")
      .split("\n")
      .filter((l) => l.includes('"msg":"OpenCode started in its terminal"'));
  const ocInTerminal = terminalStarts().some((l) =>
    l.includes(`"trial":"${String(ocTrial.body.trial)}"`),
  );
  check(
    "OpenCode runs the check and a trial as the lane, the trial in its own terminal, submits with thermite-trial, and reaches the provider only through the proxy",
    ocInTerminal &&
      ocCheck.body.ok === true &&
      ocAttempt !== undefined &&
      Number(ocTrial.body.turns) >= 1 &&
      // Its first command passed the lane's memory limit: the broker killed it, not OpenCode.
      hogSeen.killed === true &&
      keysSeen.has(`Bearer ${providerKey}`) &&
      ![...keysSeen].some((k) => /Bearer (trial|proxy)\./.test(k)),
    {
      in_terminal: ocInTerminal,
      check: ocCheck.body.summary,
      attempt: ocAttempt?.subject,
      lane: ocAttempt?.body.lane,
      turns: ocTrial?.body.turns,
      memory_hog_killed: hogSeen.killed ?? false,
      keys: [...keysSeen].map((k) => k.slice(0, 16)),
    },
  );
  // A research run under OpenCode: a research trial follows the agents' harness. Its worker keeps
  // OpenCode's own tools and runs the research tools as `thermite-trial research` commands,
  // which reach the harness's research service with the trial's token. Assigning it pauses
  // smoke-1 (one running run per rig).
  const { parseContract } = await import("../../dist/core/contract.js");
  const researchContract = parseContract({
    schema_version: 1,
    campaign: "opencode-research",
    version: 1,
    title: "Research through OpenCode",
    mode: "research",
    project: { repo: "research-notes" },
    topic: "How a harness checks quotes against archived sources",
    questions: ["What makes a quote verifiable?"],
    lanes: { count: 1, trials_per_epoch: 1 },
    min_duration: "30m",
  });
  if (!researchContract.ok) throw new Error(researchContract.errors.join("; "));
  // Headless from now on: the research trial runs OpenCode one command for each turn.
  const headless = await api("/v1/rigs/local-1/settings", {
    method: "POST",
    body: JSON.stringify({ program_mode: "headless" }),
  });
  await until(
    "the rig runs its agent programs headless",
    async () => (await api("/v1/rigs/local-1/view")).body.settings?.program_mode === "headless",
  );
  check(
    "the rig is set to run its agent programs headless over REST",
    headless.status === 200 && headless.body.sent?.program_mode === "headless",
    headless.body,
  );
  keysSeen.clear();
  await command("assign_campaign", {
    run: "research-oc",
    contract: researchContract.contract,
    contract_sha: researchContract.sha,
    imports: [],
  });
  const researchTrial = await until(
    "the OpenCode research trial's end",
    async () =>
      (await events()).find((e) => e.kind === "trial_finished" && e.subject === "research-oc"),
    600_000,
    3000,
  );
  // A research run goes on until its time is up: stop it here, before its next trial.
  await command("pause_run", { run: "research-oc", reason: "acceptance: drain" });
  const researchEvents = (await events()).filter((e) => e.subject === "research-oc");
  const refusal = researchEvents.find((e) => e.kind === "fetch_refused");
  const note = researchEvents.find((e) => e.kind === "research_note");
  const researchInTerminal = terminalStarts().some((l) =>
    l.includes(`"trial":"${String(researchTrial.body.trial)}"`),
  );
  check(
    "a research trial under OpenCode, headless, runs the research tools as thermite-trial commands, through the harness",
    !researchInTerminal &&
      researchSeen.prompt === true &&
      researchTrial.body.stopped === "finished" &&
      Number(researchTrial.body.turns) >= 1 &&
      // The fetch went through the harness's fetcher, which refused this machine's address.
      researchSeen.refused === true &&
      researchSeen.reachedPrivate === undefined &&
      /private or local address/.test(String(refusal?.body.reason)) &&
      // The note is the trial's, in the run's record; the section and progress answered.
      note?.body.trial === researchTrial.body.trial &&
      /opencode research note/.test(String(note?.body.text)) &&
      researchSeen.note === true &&
      researchSeen.section === true &&
      researchSeen.progress === true &&
      ![...keysSeen].some((k) => /Bearer (trial|proxy)\./.test(k)),
    {
      in_terminal: researchInTerminal,
      trial: researchTrial.body,
      seen: researchSeen,
      refusal: refusal?.body.reason,
      note: note?.body,
    },
  );
  // The run's research folder, as the lane's own user saw it from OpenCode's shell: the harness's
  // index and records to read and search, none of them to change, and a working area whose
  // files the harness saved and recorded when the trial ended.
  const saved = researchEvents.find(
    (e) => e.kind === "research_files_saved" && e.body.trial === researchTrial.body.trial,
  );
  const doc = researchEvents.find(
    (e) => e.kind === "research_doc" && e.body.path === "synthesis.md",
  );
  const writes = researchSeen.writes ?? {};
  check(
    "a research trial under OpenCode reads and searches its run's research folder, cannot change the harness's part, and its own files are saved when it ends",
    researchSeen.index === true &&
      researchSeen.searched === true &&
      Object.keys(writes).length === 4 &&
      Object.values(writes).every((w) => w === "REFUSED") &&
      Number(saved?.body.written) >= 1 &&
      doc?.body.trial === researchTrial.body.trial &&
      doc?.body.change === "written" &&
      /Read next: the sources on quotes\./.test(String(doc?.body.text)),
    {
      index: researchSeen.index ?? false,
      searched: researchSeen.searched ?? false,
      writes,
      saved: saved?.body,
      doc: doc && { trial: doc.body.trial, path: doc.body.path, bytes: doc.body.bytes },
    },
  );
  check(
    "control reports the agents' figures",
    agents.epochs >= 1 && agents.planner_valid >= 1 && agents.trials >= 2 && agents.tokens_in > 0,
    agents,
  );
  // Later epochs keep starting trials: pause, then every lane and agent process must end with
  // its trial.
  await command("pause_run", { run: "smoke-1", reason: "acceptance: drain" });
  const roleProcesses = () =>
    JSON.parse(
      dc(
        composeEnv,
        "exec",
        "-T",
        "harness",
        "node",
        "-e",
        `const fs=require("fs");const n=[];for(const p of fs.readdirSync("/proc")){if(!/^\\d+$/.test(p))continue;try{const u=Number(/^Uid:\\s+(\\d+)/m.exec(fs.readFileSync("/proc/"+p+"/status","utf8"))[1]);if(u>10100&&u<10317)n.push(p)}catch{}}process.stdout.write(JSON.stringify(n))`,
      ),
    );
  const lanes = await until(
    "lane and agent processes ended",
    async () => {
      const n = roleProcesses();
      return n.length === 0 ? n : undefined;
    },
    300_000,
    3000,
  ).catch(() => roleProcesses());
  check("no lane or agent process outlives its trial", lanes.length === 0, lanes);
  check(
    "a lane's background process ran on across its commands and a dev run",
    background.STARTED === "yes" && background.ALIVE === "yes",
    background,
  );
  check(
    "a setgid file a lane made lost its bit after the run",
    /^-.....s/.test(setid.BEFORE ?? "") && /^-.....x/.test(setid.AFTER ?? ""),
    setid,
  );
  check("the model was asked (planner and workers)", model.requests >= 11, model.requests);
} catch (err) {
  failed = true;
  check("acceptance run", false, String(err?.stack ?? err));
} finally {
  report.finished_at = new Date().toISOString();
  report.ok = !failed && report.checks.every((c) => c.ok);
  mkdirSync(join(".dev", "acceptance"), { recursive: true });
  const file = join(".dev", "acceptance", `m4-${report.started_at.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report: ${file}`);
  if (process.env.KEEP !== "1") dc(composeEnv, "down", "-v");
  model.close();
  console.log(report.ok ? "agents acceptance: OK" : "agents acceptance: FAILED");
  if (!report.ok) process.exitCode = 1;
}
await sleep(0);
