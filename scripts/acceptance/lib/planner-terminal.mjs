// The agents acceptance's planner in its own terminal (goal 169): in Pi, the first epoch's plan in
// its Pi view, in a process of its own, which takes one owner's message and one input typed into
// its console while it plans; in OpenCode's own terminal, the scripted model's answers to the
// planner's call there, and the scene that gives the planner the model in OpenCode over REST and
// sends it one owner's message while it plans.
import { api, command, events, plannerInTerminal, until } from "./smoke-env.mjs";
import { screenOnLive, typeInto } from "./terminals.mjs";

/** The planner in Pi in its Pi view: how often it waited, and whether the owner's message came. */
const piPlanner = { waited: 0, came: false, plans: 0 };
/** The most short tool calls its first plan makes while it waits for the owner's message. */
const PI_PLANNER_WAITS = 90;

/**
 * The scripted model's turn for the planner in Pi (`tools`: the request's tools, submit_plan among
 * them), or undefined when it should plan now. Its first plan searches the knowledge base, a call
 * every 2 s, so that its process can take the owner's message in before its next model call,
 * until the message comes (at most PI_PLANNER_WAITS); then it plans, as every later plan does.
 */
export function piPlannerTurn(messages, tools) {
  if (!tools.some((t) => t.function.name === "submit_plan")) return undefined;
  const came = JSON.stringify(messages).includes("OWNER-PI-PLANNER");
  if (came) piPlanner.came = true;
  const search = tools.some((t) => t.function.name === "kb_search");
  if (piPlanner.plans || came || !search || piPlanner.waited >= PI_PLANNER_WAITS) {
    piPlanner.plans++;
    return undefined;
  }
  piPlanner.waited++;
  return new Promise((r) =>
    setTimeout(() => r({ toolCalls: [{ name: "kb_search", args: { query: "kernel" } }] }), 2000),
  );
}

/**
 * The first epoch's planner, in Pi on a rig nobody set: its call runs in its Pi view as
 * planner-<run>-<round>, in a process of its own. One owner's message goes in before its next
 * model call, `/status` typed into its console is typed, and Live shows its Pi view.
 */
export async function piPlannerScene(check) {
  const call = await plannerInTerminal("smoke-1", { ms: 300_000 });
  const since = (await events()).length;
  // Typed first: the call stays open until the owner's message comes, then it plans and ends.
  const typed = await typeInto(call.id, { text: "/status" });
  await command("message_agent", {
    run: "smoke-1",
    to: "planner",
    text: "OWNER-PI-PLANNER Spread the lanes wider.",
  });
  const frame = await screenOnLive(call.id);
  const read = await until(
    "the planner in Pi read the owner's message during its call",
    async () =>
      (await events())
        .slice(since)
        .find((e) => e.kind === "agent_message_read" && e.body.by === "planner"),
    240_000,
    2000,
  );
  await until(
    "the planner in Pi's model got the owner's message",
    async () => piPlanner.came,
    60_000,
  );
  check(
    "the planner in Pi planned in its Pi view, took the owner's message before its next model call, and its console typed /status",
    /^planner-smoke-1-\d+$/.test(call.id) &&
      read.body.how === "next-call" &&
      piPlanner.came &&
      typed.outcome?.outcome === "typed",
    { call, read: read.body, came: piPlanner.came, typed: typed.outcome },
  );
  check("Live shows the planner's Pi view", frame?.pi_view === true || frame?.state === "ended", {
    state: frame?.state,
    pi_view: frame?.pi_view,
    chars: frame?.data?.length,
  });
}

/** Whether one of the owner's messages came inside the planner's turn, and its plans answered. */
const plannerSeen = { came: false, plans: 0 };
/** The most short commands its first plan runs while it waits for the owner's message. */
const PLANNER_WAITS = 60;

/**
 * The scripted model's turn for the planner in OpenCode (`asked`: the request's messages as JSON),
 * or undefined for another request. Its first plan runs a short command at a time, so that
 * Thermite's plugin can steer the owner's message in as each starts, until it comes (at most
 * PLANNER_WAITS); then it answers the plan as JSON, as every later plan does at once.
 */
export function opencodePlanner(messages, asked) {
  if (!asked.includes("The campaign, as JSON:")) return undefined;
  const came = asked.includes("as one more of owner_messages");
  if (came) plannerSeen.came = true;
  const waited = messages.filter((m) => m.role === "tool").length;
  if (!plannerSeen.plans && !came && waited < PLANNER_WAITS)
    return { toolCalls: [{ name: "shell", args: { command: "sleep 2", timeout: 0 } }] };
  plannerSeen.plans++;
  const lanes = [...new Set([...asked.matchAll(/lane-\d+/g)].map((m) => m[0]))].sort();
  return {
    text: JSON.stringify({
      new_families: [{ id: "oc-plan", description: "planned by the model in OpenCode" }],
      assignments: lanes.slice(0, 2).map((lane) => ({
        lane,
        family: "oc-plan",
        focus: "tidy the kernel",
        parent: "champion",
      })),
      notes: `planned in OpenCode's own terminal${came ? "; the owner's message came inside its turn" : ""}`,
    }),
  };
}

/**
 * The planner on the scripted model in OpenCode, over REST, so its next plan runs in OpenCode's
 * own terminal as planner-<run>-<round>; one owner's message to it goes in inside its turn,
 * steered in by Thermite's plugin as a command starts. Then the planner follows the workers again.
 */
export async function opencodePlannerScene(check) {
  const given = await api("/v1/rigs/local-1/model", {
    method: "POST",
    body: JSON.stringify({
      agent: "planner",
      provider: "scripted-provider",
      model: "scripted",
      harness: "opencode",
    }),
  });
  check("the planner is given the model in OpenCode over REST", given.status === 200, given.body);
  // Its next round may wait for the trial planned before it took the model.
  const call = await plannerInTerminal("smoke-1", { ms: 900_000 });
  const since = (await events()).length;
  await command("message_agent", {
    run: "smoke-1",
    to: "planner",
    text: "OWNER-PLANNER Plan the tidy-up first.",
  });
  const read = await until(
    "the planner read the owner's message inside its turn",
    async () =>
      (await events())
        .slice(since)
        .find((e) => e.kind === "agent_message_read" && e.body.by === "planner" && e.body.how),
    300_000,
    2000,
  );
  check(
    "the planner's call ran in OpenCode's own terminal, and took the owner's message inside its turn, after a command",
    /^planner-smoke-1-\d+$/.test(call.id) && read.body.how === "after-tool" && plannerSeen.came,
    { call, read: read.body, came: plannerSeen.came },
  );
  await api("/v1/rigs/local-1/model", {
    method: "POST",
    body: JSON.stringify({ agent: "planner", clear: true }),
  });
}
