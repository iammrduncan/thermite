import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Thermite's hook program for Claude Code and Codex in a trial (goal 169). Thermite's settings
 * for the trial name it for each of the program's hooks (Claude Code's `--settings`, Codex's
 * `hooks.json`) and for Codex's `notify`:
 *
 * - `main.js claude-code` or `main.js codex`: one hook, its input as JSON on stdin;
 * - `main.js codex-notify <json>`: Codex's notify, its input as the last argument.
 *
 * Each signal goes as one JSON line, `{t, src, event, payload}`, into the trial's signals file
 * (THERMITE_SIGNALS), which the harness follows; each string of the payload is cut to STRING_MAX.
 * After a tool (PostToolUse) and at the end of the agent's turn (Stop), it asks the harness for
 * the owner's next message (the TURN_OFFER route), with the trial's credential that the program's
 * environment already holds for the agent's own `thermite-trial` (THERMITE_TRIAL_AUTH), or a
 * planner's call's in its own terminal, which the same variable holds there. It prints
 * the message as the program takes it, PostToolUse's added context or a Stop that blocks with the
 * message as its reason, so the program goes on with it; then it sends the receipt (TURN_TAKEN)
 * and writes a `thermite.given` signal.
 *
 * It runs as the agent's own user, under the trial's limits, and can do only what the agent's
 * own commands can. It imports nothing of Thermite's, only Node's own modules: it runs at every
 * hook, before and after each tool, so it must start fast. Its copies of the routes' paths are
 * held to core/api/harness/turn.ts by a test. Whatever fails, it prints nothing and exits 0: it
 * is never in the program's way.
 */

/** The routes it asks (core/api/harness/turn.ts: TURN_OFFER and TURN_TAKEN). */
export const OFFER_PATH = "/v1/trial/turn/offer";
export const TAKEN_PATH = "/v1/trial/turn/taken";

/** How long one call to the harness may take; past it, the hook goes on without it. */
const CALL_MS = 5_000;
/** The most characters of one string of a signal's payload. */
const STRING_MAX = 1_000;
/** The most bytes of one signal's line: past it, only its payload's plain fields are kept. */
const LINE_MAX = 16 * 1024;

type Json = Record<string, unknown>;

const obj = (v: unknown): Json =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};

/** A payload with each string cut to STRING_MAX and each list to its first 50 items. */
function cut(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > STRING_MAX ? `${v.slice(0, STRING_MAX)}…` : v;
  if (depth > 6 || !v || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => cut(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cut(x, depth + 1)]));
}

/** A signal's line: when, which program, its event, and its payload cut to size. */
export function signalLine(src: string, event: string, payload: unknown, t = Date.now()): string {
  const line = JSON.stringify({ t, src, event, payload: cut(payload) });
  if (Buffer.byteLength(line) <= LINE_MAX) return line;
  const plain = Object.fromEntries(
    Object.entries(obj(payload))
      .filter(([, x]) => typeof x !== "object")
      .map(([k, x]) => [k, cut(x)]),
  );
  return JSON.stringify({ t, src, event, payload: { ...plain, cut: true } });
}

/** What the program takes from the hook at `event` to have the owner's message: its output. */
export function hookOutput(event: string, text: string): string | undefined {
  if (event === "PostToolUse")
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text },
    });
  if (event === "Stop") return JSON.stringify({ decision: "block", reason: text });
  return undefined;
}

/** Where a hook's event is, as the harness's offer names it. */
const PLACE: Record<string, string> = { PostToolUse: "after-tool", Stop: "turn-end" };

/** One call to the turn routes with the trial's or the call's credential; undefined if it fails. */
async function ask(env: NodeJS.ProcessEnv, path: string, body: Json): Promise<Json | undefined> {
  const base = env.THERMITE_HARNESS_URL;
  const auth = env.THERMITE_TRIAL_AUTH ?? "";
  if (!base || !/^(trial|call)\./.test(auth)) return undefined;
  try {
    const r = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_MS),
    });
    return r.ok ? obj(await r.json()) : undefined;
  } catch {
    return undefined;
  }
}

/** Appends a line to the trial's signals file, when there is one. */
function write(env: NodeJS.ProcessEnv, line: string): void {
  const file = env.THERMITE_SIGNALS;
  if (!file) return;
  try {
    appendFileSync(file, `${line}\n`, { mode: 0o644 });
  } catch {
    // The signal is a hint: the program goes on without it.
  }
}

/**
 * One hook or notify call: `argv` after the program's path, `stdin` the hook's input. Writes the
 * signal, and at PostToolUse and Stop gives the owner's next message, through `print`, before
 * its receipt.
 */
export async function runHook(
  argv: string[],
  stdin: string,
  env: NodeJS.ProcessEnv,
  print: (s: string) => void,
): Promise<void> {
  const src = argv[0] ?? "unknown";
  const raw = src === "codex-notify" ? (argv.at(-1) ?? "") : stdin;
  let payload: Json;
  try {
    payload = obj(JSON.parse(raw));
  } catch {
    payload = { raw: raw.slice(0, STRING_MAX) };
  }
  const event = String(payload.hook_event_name ?? payload.type ?? "unknown");
  write(env, signalLine(src, event, payload));
  const at = PLACE[event];
  // A subagent's tool, where the program names one, is not where the owner's message goes.
  if (!at || src === "codex-notify" || payload.agent_id) return;
  const offered = await ask(env, OFFER_PATH, { at });
  const offer = typeof offered?.offer === "string" ? offered.offer : undefined;
  const output = offer ? hookOutput(event, String(offered?.text ?? "")) : undefined;
  if (!offer || !output) return;
  print(output);
  await ask(env, TAKEN_PATH, { offer });
  write(env, signalLine(src, "thermite.given", { at, offer }));
}

const invoked = (() => {
  try {
    return (
      Boolean(process.argv[1]) &&
      import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href
    );
  } catch {
    return false;
  }
})();
if (invoked) {
  const argv = process.argv.slice(2);
  let stdin = "";
  try {
    stdin = argv[0] === "codex-notify" ? "" : readFileSync(0, "utf8");
  } catch {
    stdin = "";
  }
  void runHook(argv, stdin, process.env, (s) => process.stdout.write(s))
    .catch(() => {
      // Never in the program's way.
    })
    .finally(() => {
      process.exitCode = 0;
    });
}
