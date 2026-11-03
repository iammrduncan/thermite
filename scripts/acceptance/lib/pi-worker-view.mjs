// @ts-check
// The agents acceptance's worker in its Pi view (goal 169): lane-2's trial holds in a command
// while the owner's inputs reach its Pi view from the owner's console, each in turn; once the
// follow-up has reached it, it restates the kernel and submits. The scene's part of the scripted
// model (piSteps), and the owner's console (piConsoleScene).
import { readFileSync } from "node:fs";
import { events, until } from "./smoke-env.mjs";
import { screenOnLive, typeInto } from "./terminals.mjs";

/** @typedef {import("./scripted-model.mjs").ScriptedTurn} ScriptedTurn */
/** @typedef {import("./scripted-model.mjs").ToolCall} ToolCall */

/** lane-2's trial in its Pi view (goal 169): when it held, and what its model was sent. */
/** @type {{ holdAt?: number, steered?: boolean, followed?: boolean }} */
export const piScene = {};
/** The owner's inputs to lane-2's Pi view, in order, and what each must become. */
export const PI_INPUTS = [
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
/** @typedef {(typeof PI_INPUTS)[number]} PiInput */
const NOOP = readFileSync("kits/smoke-cpu/candidates/noop/src/kernel/matmul.c", "utf8");

/**
 * lane-2's trial, in its Pi view (goal 169): it holds in a command while the owner's inputs
 * arrive; then, once the follow-up has reached it (a reply without a tool call gives it its
 * chance), it restates the kernel and submits.
 * @param {any[]} messages
 * @param {number} done
 * @returns {ScriptedTurn}
 */
export function piSteps(messages, done) {
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
  return steps[done - 1]
    ? { toolCalls: [/** @type {ToolCall} */ (steps[done - 1])] }
    : { text: "done" };
}

/**
 * The owner's console into lane-2's Pi view (goal 169), while its trial holds in a command: each
 * input in turn, then the screen as Live shows it.
 */
export async function piConsoleScene() {
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
