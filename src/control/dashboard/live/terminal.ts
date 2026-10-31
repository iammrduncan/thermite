import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { errorText } from "../../../common/errors.ts";
import { log } from "../../../common/log.ts";
import { SCREENS_WATCHED_MAX, type ScreenFrame } from "../../../core/screens.ts";
import {
  confirmFirst,
  inputWords,
  isPlannerCall,
  TERMINAL_ID,
  TERMINAL_KEYS,
  type TerminalKey,
} from "../../../core/terminal-input.ts";
import {
  clockUtc,
  commandExpired,
  commandFollowUrl,
  commandProgress,
  notSent,
  refusalOf,
} from "../../command-progress.ts";
import { issueCommand } from "../../issue/index.ts";
import type { CommandRow } from "../../store/index.ts";
import { TERMINAL_JS, type TermInputRow, terminalHtml } from "../../ui/terminal.ts";
import { liveHref, rigHref } from "../../ui/urls.ts";
import { type Ctx, type Dashboard, wantsJson } from "../context.ts";
import { LIVE_PUSH_BEAT_MS, LIVE_PUSH_RETRY_MS } from "./push.ts";

/**
 * A trial's terminal on its Live page (goal 169), or a planner's call's on the planner's, the
 * owner's alone (the dashboard signs in no
 * other token): the agent's screen, pushed to the page as control gets it while the page watches
 * (control/live/screens.ts holds it in memory), and the console that sends terminal_input, a
 * signed command, with each input's outcome. xterm.js draws the screen in the browser; control
 * serves the copy kept in the repository (XTERM_DIR), checked against its pinned hash.
 */

/** xterm.js as Thermite serves it: @xterm/xterm 6.0.0 (MIT), its lib/xterm.js and css/xterm.css. */
export const XTERM_DIR = fileURLToPath(new URL("../../../../vendor/xterm/", import.meta.url));
export const XTERM_VERSION = "6.0.0";
/** The files' SHA-256, as npm's @xterm/xterm 6.0.0 has them: control serves no other. */
export const XTERM_SHA256 = {
  "xterm.js": "14903579ff54664cd72f8e8699e6961a6272c21863ec1c3b118cdc8af5d4a972",
  "xterm.css": "854a7c0fb70e8b1a083c16797ab827299fb18744f5ad34f227b48337e33293c6",
} as const;

/** How many of the owner's newest inputs to one trial its console lists. */
const INPUTS_LISTED = 30;

const loaded = new Map<keyof typeof XTERM_SHA256, string | null>();

/** One of xterm.js's files, read once; null (and logged once) when it is missing or not pinned. */
export function xtermFile(name: keyof typeof XTERM_SHA256): string | null {
  if (loaded.has(name)) return loaded.get(name) ?? null;
  let text: string | null = null;
  try {
    const bytes = readFileSync(`${XTERM_DIR}${name}`);
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (sha === XTERM_SHA256[name]) text = bytes.toString("utf8");
    else
      log(
        "control",
        `vendor/xterm/${name} is not xterm.js ${XTERM_VERSION}'s: not served`,
        { sha },
        "error",
      );
  } catch (err) {
    log("control", `vendor/xterm/${name} could not be read`, { error: errorText(err) }, "error");
  }
  loaded.set(name, text);
  return text;
}

/** What an input was, in words: its text, or its keys by name. */
const inputOf = (p: Record<string, unknown>): { words: string; keys: boolean } => {
  const text = typeof p.text === "string" ? p.text : undefined;
  const keys = Array.isArray(p.keys) ? p.keys.map(String) : undefined;
  return { words: inputWords({ text, keys }), keys: text === undefined };
};

/**
 * What became of one input, in words: from the command's answer, and, for one that waited for a
 * usage window's reset, from the run's `terminal_input` events after it.
 */
function outcomeOf(
  cmd: CommandRow,
  later: Map<string, Record<string, unknown>>,
  now: number,
): Pick<TermInputRow, "outcome" | "tone"> {
  if (commandExpired(cmd, now)) return { outcome: "expired before the rig took it", tone: "bad" };
  if (cmd.status === "pending") return { outcome: "sent, waiting for the rig", tone: "" };
  const why = refusalOf(cmd);
  if (why !== null) return { outcome: `not typed: ${why}`, tone: "bad" };
  const r = (cmd.outcome as { result?: { outcome?: unknown; until?: unknown } } | null)?.result;
  if (r?.outcome !== "queued")
    return { outcome: cmd.payload.follow_up ? "typed, as a follow-up" : "typed", tone: "ok" };
  const after = later.get(cmd.id);
  if (after?.outcome === "typed_after_reset")
    return { outcome: "typed after the usage window's reset", tone: "ok" };
  if (after?.outcome === "dropped")
    return { outcome: `dropped: ${String(after.why ?? "")}`, tone: "bad" };
  const until = typeof r.until === "string" ? ` (${clockUtc(r.until)})` : "";
  return { outcome: `waits for the usage window's reset${until}`, tone: "warn" };
}

/** The owner's inputs to a trial, newest first, with what became of each. */
function inputs(dash: Dashboard, rig: string, run: string, trial: string): TermInputRow[] {
  const now = Date.now();
  const timeline =
    dash
      .views()
      .find((u) => u.id === rig)
      ?.runs.find((r) => r.id === run)?.timeline ?? [];
  const later = new Map(
    timeline
      .filter((e) => e.kind === "terminal_input" && e.body.trial === trial)
      .filter((e) => e.body.outcome === "typed_after_reset" || e.body.outcome === "dropped")
      .map((e) => [String(e.body.command), e.body]),
  );
  return dash.store.commands
    .latest(rig, "terminal_input", 200)
    .filter((cmd) => cmd.payload.trial === trial)
    .slice(0, INPUTS_LISTED)
    .map((cmd) => ({ at: cmd.issued_at, ...inputOf(cmd.payload), ...outcomeOf(cmd, later, now) }));
}

/**
 * The terminal on a trial's Live page: its screen and its console, for the owner (the page's only
 * reader). `ended`: the trial has ended, and its console takes no more input.
 */
export function terminalPanel(
  dash: Dashboard,
  c: Ctx,
  o: { rig: string; run: string; trial: string; ended: boolean },
): string {
  return terminalHtml({
    stream: `${rigHref(o.rig)}/live/screen?trial=${encodeURIComponent(o.trial)}`,
    action: `${rigHref(o.rig)}/live/terminal`,
    csrf: dash.csrf(c),
    run: o.run,
    trial: o.trial,
    ended: o.ended,
    inputs: inputs(dash, o.rig, o.run, o.trial),
    xtermCss: xtermFile("xterm.css") ?? "",
    error: dash.said(c, "termerror"),
  });
}

export function terminalRoutes(app: Hono, dash: Dashboard): void {
  const { opts, parts, noted, store, views } = dash;

  // xterm.js, from the repository's copy, and the terminal's own script (ui/terminal.ts).
  app.get("/ui/assets/xterm.js", (c) => {
    const js = xtermFile("xterm.js");
    if (js === null) return c.text("xterm.js is not available on this control", 404);
    return c.body(js, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "max-age=86400",
    });
  });
  app.get("/ui/assets/terminal.js", (c) =>
    c.body(TERMINAL_JS, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );

  // A trial's screen, pushed to its page while the page watches: control asks the rig's
  // supervisor for it only then (live/screens.ts), and keeps the newest in memory meanwhile.
  app.get("/ui/rigs/:rig/live/screen", (c) => {
    const rig = c.req.param("rig");
    const trial = c.req.query("trial") ?? "";
    if (!views().some((u) => u.id === rig)) return c.json({ error: "no such rig" }, 404);
    if (!TERMINAL_ID.test(trial)) return c.json({ error: "no such trial" }, 404);
    return streamSSE(c, async (stream) => {
      const stop = parts.screens.watch(rig, trial);
      if (!stop) {
        await stream.writeSSE({
          event: "busy",
          data: JSON.stringify({
            said: `${SCREENS_WATCHED_MAX} of ${rig}'s terminals are watched already: close one of their pages, then load this one again.`,
          }),
        });
        return;
      }
      let wake: (() => void) | undefined;
      const off = parts.screens.onFrame((r, t) => {
        if (r === rig && t === trial) wake?.();
      });
      stream.onAbort(() => wake?.());
      let sent: ScreenFrame | undefined;
      try {
        await stream.write(`retry: ${LIVE_PUSH_RETRY_MS}\n\n`);
        await stream.writeSSE({ event: "waiting", data: "" });
        while (!stream.aborted && !stream.closed) {
          const f = parts.screens.frame(rig, trial);
          if (f && f !== sent) {
            sent = f;
            const { got: _, ...frame } = f;
            await stream.writeSSE({ event: "frame", data: JSON.stringify(frame) });
          }
          // The page may have gone while a frame was on its way to it.
          if (stream.aborted) break;
          const beat = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(true), LIVE_PUSH_BEAT_MS);
            wake = () => {
              clearTimeout(timer);
              resolve(false);
            };
          });
          wake = undefined;
          if (beat && !stream.aborted) await stream.writeSSE({ event: "beat", data: "" });
        }
      } finally {
        off();
        stop();
      }
    });
  });

  // The console: one input into a trial's or a planner's call's terminal, as the owner's signed
  // command.
  app.post("/ui/rigs/:rig/live/terminal", async (c) => {
    const f = await c.req.parseBody();
    const rig = c.req.param("rig");
    const run = String(f.run ?? "");
    const trial = String(f.trial ?? "");
    const key = String(f.key ?? "");
    const text = String(f.text ?? "");
    // A planner's call's terminal is on the planner's page (goal 169).
    const back = liveHref(rig, isPlannerCall(trial) ? "planner" : `trial:${trial}`);
    const json = wantsJson(c);
    const refuse = (why: string) =>
      json
        ? c.json(notSent(why), 400)
        : c.redirect(`${back}&termerror=${encodeURIComponent(noted(why))}`, 303);
    const keys = key ? [key] : [];
    if (keys.some((k) => !(TERMINAL_KEYS as readonly string[]).includes(k)))
      return refuse(`${key} is not a key the console sends.`);
    const confirmed = f.confirm === "1";
    const risky = !key && confirmFirst(text);
    if (risky && !confirmed) return refuse(`Confirm it first: ${risky}.`);
    let id: string;
    try {
      ({ id } = issueCommand(store, opts.privateKeyPem, {
        rig,
        kind: "terminal_input",
        payload: {
          run,
          trial,
          ...(key ? { keys: keys as TerminalKey[] } : { text }),
          wait: f.wait === "now" ? "now" : "queue",
          ...(risky ? { confirm: true } : {}),
          // A worker in Pi's Pi view: the words wait until the agent would stop.
          ...(!key && f.follow_up === "1" ? { follow_up: true } : {}),
        },
        issuedBy: "owner:ui",
      }));
    } catch (err) {
      return refuse(errorText(err));
    }
    const cmd = json ? store.commands.row(id) : undefined;
    if (cmd) return c.json({ ...commandProgress(cmd, Date.now()), follow: commandFollowUrl(id) });
    return c.redirect(back, 303);
  });
}
