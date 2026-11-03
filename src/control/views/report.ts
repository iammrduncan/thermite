import type { Harness } from "../../core/agents.ts";
import {
  PROGRAM_MODE_DEFAULT,
  type ProgramMode,
  type RigSettings,
} from "../../core/rig-settings.ts";
import type { ControlStore } from "../store/index.ts";
import type { RigView } from "./types.ts";

/**
 * What a rig's report says of the rig itself, read loosely (the report is data): its own
 * settings, its GPU split and its model route; and whether it still reports, by when it last did.
 */

/** The rig's own settings as its harness reports them, read loosely. */
export function readSettings(v: unknown): RigSettings | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const b = (k: string) => o[k] !== false;
  return {
    judge: b("judge"),
    workers: b("workers"),
    lanes: typeof o.lanes === "number" ? o.lanes : 1,
    planner: b("planner"),
    auditor: b("auditor"),
    teachers: b("teachers"),
    review: b("review"),
    exports: b("exports"),
    trial_minutes: typeof o.trial_minutes === "number" ? o.trial_minutes : null,
    max_turns: typeof o.max_turns === "number" ? o.max_turns : null,
    quiet_minutes: typeof o.quiet_minutes === "number" ? o.quiet_minutes : null,
    // A harness that reports none is older than the terminal mode, and runs headless.
    program_mode: o.program_mode === "terminal" ? "terminal" : "headless",
    promotion: o.promotion === "auto" ? "auto" : "owner_approval",
    judge_gpus: typeof o.judge_gpus === "number" ? o.judge_gpus : null,
  };
}

/** A rig configured with its GPU set: how many cards, and how many are the judge's now. */
export function readGpuSplit(v: unknown): { set: number; judge: number } | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return typeof o.set === "number" && typeof o.judge === "number"
    ? { set: o.set, judge: o.judge }
    : null;
}

/**
 * A rig's own settings (Edit rig) and its GPU split, as its last signed report gives them, read
 * as rigView reads them; undefined for a rig control has no report of (or one retired).
 */
export function rigSettingsOf(
  store: ControlStore,
  rig: string,
): Pick<RigView, "settings" | "gpu_split"> | undefined {
  const u = store.reportedRigs.list().find((x) => x.id === rig);
  if (!u) return undefined;
  const summary = u.summary as { settings?: unknown; gpu_split?: unknown } | undefined;
  return { settings: readSettings(summary?.settings), gpu_split: readGpuSplit(summary?.gpu_split) };
}

/**
 * How a rig's agent programs run, as control knows it: the mode its last report gives (headless
 * from a harness too old to report one), or the default for a rig that has not reported yet.
 */
export function programModeOf(store: ControlStore, rig: string): ProgramMode {
  const now = rigSettingsOf(store, rig);
  return now ? (now.settings?.program_mode ?? "headless") : PROGRAM_MODE_DEFAULT;
}

/**
 * Whether a rig reports: "reporting" within the stale window, "stale" after it, "offline" after
 * the longer offline window. A rig that never sent a report is offline.
 */
export type ReportingState = "reporting" | "stale" | "offline";

/** How long without a report makes a rig offline when control is given no other time. */
export const OFFLINE_AFTER_MS = 900_000;

export function reportingState(
  lastSeen: string,
  opts: { staleAfterMs: number; offlineAfterMs?: number | undefined; now?: number | undefined },
): ReportingState {
  const age = (opts.now ?? Date.now()) - Date.parse(lastSeen);
  // Never before the stale window ends.
  const offline = Math.max(opts.staleAfterMs, opts.offlineAfterMs ?? OFFLINE_AFTER_MS);
  return !(age <= offline) ? "offline" : age > opts.staleAfterMs ? "stale" : "reporting";
}

export interface RigModelView {
  source: "control" | "environment" | "none";
  name: string | null;
  version: number | null;
  model: string | null;
  base_url: string | null;
  key_hint: string | null;
  /** The harness its agents run in. */
  harness: Harness;
}

/** Reads a report's model route loosely: anything malformed is dropped, never trusted. */
export function readModelInfo(x: unknown): RigModelView | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 300) : null);
  const source = o.source;
  if (source !== "control" && source !== "environment" && source !== "none") return null;
  return {
    source,
    name: str(o.name),
    version: typeof o.version === "number" && Number.isInteger(o.version) ? o.version : null,
    model: str(o.model),
    base_url: str(o.base_url),
    key_hint: str(o.key_hint),
    harness:
      o.harness === "opencode" || o.harness === "claude-code" || o.harness === "codex"
        ? o.harness
        : "pi",
  };
}
