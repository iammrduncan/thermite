import { z } from "zod";
import { logLevel, setLogLevel, startedLogLevel } from "../common/log.ts";
import { LOG_LEVELS, type LogLevel } from "../core/log-levels.ts";
import type { ControlStore } from "./store/index.ts";

/**
 * Control's own log level, a setting control keeps (the guide's question 16): the same over REST
 * (`GET` and `PUT /v1/control/log-level`), MCP (`control_log_level`, `set_control_log_level`) and
 * `thermite log-level control`. A change applies at once and stays across control's restarts;
 * none set, control writes at its THERMITE_LOG_LEVEL. Each change is audited. A rig's harness and
 * supervisor change theirs by the signed `log_level` command instead (core/commands.ts).
 */

/** The key the setting has among control's own (store/own-settings.ts). */
const LOG_LEVEL_KEY = "log_level";

/** What the setting is, for the tools' descriptions and the command line's words. */
export const CONTROL_LOG_LEVEL_WORDS = `The lowest level of the log lines control writes: ${LOG_LEVELS.join(", ")}. It applies at once and stays across control's restarts. null: back to THERMITE_LOG_LEVEL, control's environment setting (info unless set).`;

/** A change of it: a level, or null for THERMITE_LOG_LEVEL's. */
const ControlLogLevelBody = z.strictObject({
  level: z.enum(LOG_LEVELS).nullable().describe(CONTROL_LOG_LEVEL_WORDS),
});

/** Control's log level, where it comes from, and who last set it, when. */
interface ControlLogLevel {
  /** The level control writes at: the setting's, or THERMITE_LOG_LEVEL's. */
  level: LogLevel;
  /** "setting": the owner set it on control; "environment": THERMITE_LOG_LEVEL. */
  from: "setting" | "environment";
  /** THERMITE_LOG_LEVEL's level, which null goes back to. */
  environment: LogLevel;
  /** The level now: `level`, or debug while SIGUSR2's switch is on. */
  now: LogLevel;
  set_by: string | null;
  set_at: string | null;
}

/** The level the owner set, if one is set and is a level. */
async function setLevel(
  store: ControlStore,
): Promise<{ level: LogLevel; by: string; at: string } | undefined> {
  const row = await store.ownSettings.get(LOG_LEVEL_KEY);
  const level = LOG_LEVELS.find((l) => l === row?.value);
  return row && level ? { level, by: row.set_by, at: row.set_at } : undefined;
}

/** Control's log level now. */
export async function controlLogLevelOf(store: ControlStore): Promise<ControlLogLevel> {
  const set = await setLevel(store);
  return {
    level: set?.level ?? startedLogLevel(),
    from: set ? "setting" : "environment",
    environment: startedLogLevel(),
    now: logLevel(),
    set_by: set?.by ?? null,
    set_at: set?.at ?? null,
  };
}

/** The level in words, as each surface says what a change did. */
function controlLogLevelWords(l: ControlLogLevel): string {
  const from =
    l.from === "setting"
      ? "the setting on control"
      : "THERMITE_LOG_LEVEL, as no setting is on control";
  const now = l.now === l.level ? "" : ` It writes at ${l.now} now, as SIGUSR2 switched it.`;
  return `Control writes its log lines at ${l.level} and above, from ${from}.${now}`;
}

/** What a change did: the level now and its words, or why it was refused. */
type ControlLogLevelOutcome =
  | { ok: true; level: ControlLogLevel; said: string }
  | { ok: false; error: string };

/** A change of control's log level by `by`: checked, kept, applied at once and audited. */
export async function setControlLogLevel(
  store: ControlStore,
  raw: unknown,
  by: string,
): Promise<ControlLogLevelOutcome> {
  const r = ControlLogLevelBody.safeParse(raw);
  if (!r.success)
    return {
      ok: false,
      error: r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
    };
  const was = (await controlLogLevelOf(store)).level;
  await store.tx(async () => {
    await store.ownSettings.set(LOG_LEVEL_KEY, r.data.level, by);
    await store.auditLog.add(by, "control_log_level_set", { level: r.data.level, was });
  });
  setLogLevel("control", r.data.level, { by, from: r.data.level ? "setting" : "environment" });
  const level = await controlLogLevelOf(store);
  return { ok: true, level, said: controlLogLevelWords(level) };
}

/** At control's start, after its environment's level: the level the owner set, if any. */
export async function applyControlLogLevel(store: ControlStore): Promise<void> {
  const set = await setLevel(store);
  if (set) setLogLevel("control", set.level, { by: set.by, from: "setting", set_at: set.at });
}
