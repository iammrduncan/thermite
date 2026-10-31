import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Thermite's plugin for OpenCode v2, loaded from the agent's own OpenCode settings
 * (`~/.config/opencode/plugins/`), where Thermite links it before OpenCode starts. OpenCode loads a
 * plugin as a module whose default export has an `id` and a `setup(ctx)`. It has two parts, each
 * on when Thermite's environment for OpenCode names its file or folder.
 *
 * Compaction (goal 070; THERMITE_COMPACTION_DROPS and THERMITE_COMPACTION_LINE, with `{n}` for
 * the number):
 * - the session's `compaction` hook, which runs before each compaction's model request: it keeps
 *   the session's messages since its last compaction (`ctx.session.context`, the earlier
 *   compaction's summary first) as `<n>.json` in its folder, and adds a line to the request's
 *   system parts that tells the summary where Thermite keeps the conversation;
 * - the `session.compaction.ended` event: it writes `<n>.done.json` with the summary, which is
 *   how Thermite's own code learns that the compaction was made (OpenCode's `run --format json`
 *   output does not report it).
 * A compaction of a subagent's session (one with a parent) is OpenCode's own business and is
 * left alone.
 *
 * A trial's signals and the owner's messages (goal 169; THERMITE_SIGNALS, THERMITE_HARNESS_URL and
 * THERMITE_TRIAL_AUTH, the trial's credential that the agent's own `thermite-trial` uses, or a
 * planner's call's in its own terminal):
 * - each event OpenCode gives the plugin (`ctx.event.subscribe()`) goes as one JSON line into the
 *   trial's signals file, which the harness follows and reads with its OpenCode adapter
 *   (session-events.ts): the event without its `location`, each string cut to STRING_MAX. The
 *   text and the tool input as they stream (the `.delta` events) are left out: their ends carry
 *   them whole;
 * - when a tool of the session starts (`session.tool.called`; not a subagent's), it asks the
 *   harness for the owner's next message (the TURN_OFFER route) and steers it into the session
 *   (`ctx.session.prompt` with `delivery: "steer"`): OpenCode takes it in at its next step, after
 *   the tool. Once OpenCode says it took it in (`session.inbox.delivered`), the plugin sends the
 *   receipt (TURN_TAKEN). One message at a time; an OpenCode with no `ctx.session.prompt` takes
 *   none here, and the harness gives them in the next continuation.
 *
 * It runs in OpenCode's own process, as the agent's own user, and can do only what the agent's own
 * commands can: it writes only in its folder and the signals file, and reaches only the harness.
 * Whatever fails, OpenCode goes on.
 *
 * This module imports nothing of Thermite's: OpenCode loads it alone. Its copies of the routes'
 * paths are held to core/api/harness/turn.ts by a test.
 */

/** The placeholder for the compaction's number in the line. */
const NUMBER = "{n}";

/** The routes the plugin asks (core/api/harness/turn.ts: TURN_OFFER and TURN_TAKEN). */
export const OFFER_PATH = "/v1/trial/turn/offer";
export const TAKEN_PATH = "/v1/trial/turn/taken";

/** How long one call to the harness may take; past it, the plugin goes on without it. */
const CALL_MS = 5_000;
/** The most characters of one string of a signal. */
const STRING_MAX = 1_000;
/** The most bytes of one signal's line: past it, only its type, time and session are kept. */
const LINE_MAX = 16 * 1024;

/** The parts of OpenCode's Promise plugin context this plugin uses. */
export interface OpencodePluginContext {
  session: {
    hook(
      name: "compaction",
      callback: (event: OpencodeCompaction) => Promise<void> | void,
    ): Promise<unknown>;
    context(input: { sessionID: string }): Promise<unknown>;
    get(input: { sessionID: string }): Promise<unknown>;
    /** A user's message into the session (OpenCode's server plugins' documentation). */
    prompt?(input: { sessionID: string; text: string; delivery: "steer" }): Promise<unknown>;
  };
  event: { subscribe(options?: { signal?: AbortSignal }): AsyncIterable<unknown> };
}

/** The `compaction` hook's event: the request before the summary prompt is added. */
export interface OpencodeCompaction {
  readonly sessionID: string;
  system: { type: string; text: string }[];
  messages: unknown[];
}

type Json = Record<string, unknown>;
type OnEvent = (e: Json) => void;

const obj = (v: unknown): Json =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Writes a file whole or not at all, readable by Thermite's own user. */
function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { mode: 0o644 });
  chmodSync(tmp, 0o644);
  renameSync(tmp, path);
}

/** The next compaction's number: one after the last one seen to end. */
function nextNumber(dir: string): number {
  let last = 0;
  try {
    for (const f of readdirSync(dir)) {
      const m = /^(\d+)\.done\.json$/.exec(f);
      if (m) last = Math.max(last, Number(m[1]));
    }
  } catch {
    last = 0;
  }
  return last + 1;
}

/** Whether a session is the agent's own, not a subagent's (one with a parent). */
async function topLevel(ctx: OpencodePluginContext, sessionID: string): Promise<boolean> {
  const info = obj(await ctx.session.get({ sessionID }).catch(() => undefined));
  return !(typeof info.parentID === "string" && info.parentID);
}

/** The compaction part: its hook, and what it does with each event. */
async function compactionPart(
  ctx: OpencodePluginContext,
  env: NodeJS.ProcessEnv,
): Promise<OnEvent | undefined> {
  const dir = env.THERMITE_COMPACTION_DROPS;
  if (!dir) return undefined;
  const line = env.THERMITE_COMPACTION_LINE ?? "";
  try {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chmodSync(dir, 0o755);
  } catch {
    return undefined;
  }
  // The compaction under way in each session, by number.
  const pending = new Map<string, number>();
  await ctx.session.hook("compaction", async (event) => {
    try {
      const id = event.sessionID;
      if (!(await topLevel(ctx, id))) return;
      const n = nextNumber(dir);
      pending.set(id, n);
      let messages: unknown;
      try {
        const got = await ctx.session.context({ sessionID: id });
        messages = Array.isArray(got) ? got : obj(got).data;
      } catch {
        messages = undefined;
      }
      writeAtomic(
        join(dir, `${n}.json`),
        JSON.stringify({
          session: id,
          at: new Date().toISOString(),
          messages: Array.isArray(messages) ? messages : [],
        }),
      );
      if (line && Array.isArray(event.system))
        event.system.push({ type: "text", text: line.split(NUMBER).join(String(n)) });
    } catch {
      // The compaction goes on; Thermite keeps what it saw of the trial instead.
    }
  });
  return (e) => {
    const data = obj(e.data);
    const id = str(data.sessionID);
    const n = pending.get(id);
    if (n === undefined) return;
    if (e.type === "session.compaction.ended") {
      pending.delete(id);
      writeAtomic(
        join(dir, `${n}.done.json`),
        JSON.stringify({ session: id, at: new Date().toISOString(), summary: str(data.text) }),
      );
    } else if (e.type === "session.compaction.failed") pending.delete(id);
  };
}

/** A value with each string cut to STRING_MAX and each list to its first 50 items. */
function cut(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > STRING_MAX ? `${v.slice(0, STRING_MAX)}…` : v;
  if (depth > 6 || !v || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => cut(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cut(x, depth + 1)]));
}

/** An event as a signal's line: without its `location`, cut to size. */
export function eventLine(e: Json): string {
  const { location: _where, ...rest } = e;
  const line = JSON.stringify(cut(rest));
  if (Buffer.byteLength(line) <= LINE_MAX) return line;
  return JSON.stringify({
    id: e.id,
    created: e.created,
    type: e.type,
    data: { sessionID: obj(e.data).sessionID, cut: true },
  });
}

/** One call to the harness's trial routes with the trial's credential; undefined if it fails. */
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

/** The signals part: each event to the signals file, and the owner's messages steered in. */
function signalsPart(ctx: OpencodePluginContext, env: NodeJS.ProcessEnv): OnEvent | undefined {
  const file = env.THERMITE_SIGNALS;
  if (!file) return undefined;
  const top = new Map<string, boolean>();
  // The message offered and steered in, until OpenCode takes it in: one at a time.
  let pending: { offer: string; text: string; session: string; inbox?: string } | undefined;
  let asking = false;
  const steer = async (session: string) => {
    if (asking || pending || typeof ctx.session.prompt !== "function") return;
    asking = true;
    try {
      if (!top.has(session)) top.set(session, await topLevel(ctx, session));
      if (!top.get(session)) return;
      const o = await ask(env, OFFER_PATH, { at: "after-tool" });
      if (typeof o?.offer !== "string") return;
      pending = { offer: o.offer, text: str(o.text), session };
      await ctx.session.prompt({ sessionID: session, text: pending.text, delivery: "steer" });
    } catch {
      // Not taken in: the harness gives it in the next continuation.
      pending = undefined;
    } finally {
      asking = false;
    }
  };
  return (e) => {
    const type = str(e.type);
    const data = obj(e.data);
    if (!type.endsWith(".delta")) {
      try {
        appendFileSync(file, `${eventLine(e)}\n`, { mode: 0o644 });
      } catch {
        // The signal is a hint: OpenCode goes on without it.
      }
    }
    if (type === "session.tool.called" && str(data.sessionID)) void steer(str(data.sessionID));
    const p = pending;
    if (!p || str(data.sessionID) !== p.session) return;
    // Its place in OpenCode's inbox: the enqueued item with its text.
    if (
      type === "session.inbox.enqueued" &&
      !p.inbox &&
      str(obj(obj(data.item).payload).text) === p.text
    )
      p.inbox = str(data.inboxID);
    else if (type === "session.inbox.delivered" && p.inbox && str(data.inboxID) === p.inbox) {
      pending = undefined;
      void ask(env, TAKEN_PATH, { offer: p.offer });
    }
  };
}

/** The plugin, with the environment it reads when OpenCode sets it up. */
export function thermitePlugin(env: NodeJS.ProcessEnv = process.env) {
  return {
    id: "thermite",
    setup: async (ctx: OpencodePluginContext): Promise<(() => void) | undefined> => {
      const parts = [await compactionPart(ctx, env), signalsPart(ctx, env)].filter(
        (p): p is OnEvent => p !== undefined,
      );
      if (!parts.length) return undefined;
      const stop = new AbortController();
      void (async () => {
        try {
          for await (const raw of ctx.event.subscribe({ signal: stop.signal }))
            for (const part of parts) part(obj(raw));
        } catch {
          // The stream ends with OpenCode.
        }
      })();
      return () => stop.abort();
    },
  };
}

export default thermitePlugin();
