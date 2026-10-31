import { HELD_OUT_EVENT_CELLS } from "../../../core/held-out.ts";
import { clip } from "../../../core/kb-index.ts";
import { metricValuesOf } from "../metric-values.ts";
import { frozen } from "../sharing.ts";
import type { AttemptView, HeldOutView } from "../types.ts";
import type { Handlers } from "./index.ts";

/** Attempts: recorded, their lifecycle, the judge's verdicts and their held-out checks. */

/** A held-out check from its event's body, each field checked: the rig's report is data. */
function heldOutView(at: string, b: Record<string, unknown>): HeldOutView {
  const txt = (v: unknown, n = 200) => (typeof v === "string" ? clip(v, n) : null);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const listed = Array.isArray(b.cells) ? b.cells.slice(0, HELD_OUT_EVENT_CELLS) : [];
  const cells = listed.flatMap((x) => {
    const c = (x ?? {}) as Record<string, unknown>;
    if (typeof c.cell !== "string") return [];
    return [
      {
        cell: clip(c.cell, 200),
        goal: txt(c.goal),
        verifier: txt(c.verifier),
        ok: c.ok === true,
        kind: txt(c.kind, 40),
        value: num(c.value),
        low: num(c.low),
        high: num(c.high),
        threshold: num(c.threshold),
        op: c.op === ">=" || c.op === ">" || c.op === "<=" || c.op === "<" ? c.op : null,
        measure: txt(c.measure),
        unit: txt(c.unit, 40),
      },
    ];
  });
  return {
    at,
    pass: b.pass === true,
    cells,
    cells_total: typeof b.cells_total === "number" ? b.cells_total : cells.length,
  };
}

export const ATTEMPTS: Handlers = {
  attempt_recorded(f, e, b) {
    const a: AttemptView = {
      id: String(e.subject),
      run: String(b.run),
      lane: (b.lane as string | null) ?? null,
      lifecycle: String(b.lifecycle),
      verdict: null,
      delta: null,
      values: null,
      hypothesis: (b.hypothesis as string | null) ?? null,
      recorded_at: e.at,
      updated_at: e.at,
      commit: typeof b.commit === "string" ? b.commit : null,
      parent: typeof b.parent === "string" ? b.parent : null,
      known_flaws: frozen(Array.isArray(b.known_flaws) ? b.known_flaws.map((x) => String(x)) : []),
      family: null,
      trial: null,
      gained: null,
      lost: [],
      unsure: [],
      history: [],
      waiting: null,
      ci: null,
      reasons: null,
      files: frozen(
        Array.isArray(b.files)
          ? (b.files as { path: string; added: number | null; removed: number | null }[]).map(
              (x) => ({
                path: String(x.path),
                added: typeof x.added === "number" ? x.added : null,
                removed: typeof x.removed === "number" ? x.removed : null,
              }),
            )
          : [],
      ),
      files_total: typeof b.files_total === "number" ? b.files_total : 0,
      violations: frozen(
        Array.isArray(b.violations)
          ? b.violations.slice(0, 20).map((v) => clip(String(v), 300))
          : [],
      ),
      violations_total:
        typeof b.violations_total === "number"
          ? b.violations_total
          : Array.isArray(b.violations)
            ? b.violations.length
            : 0,
      held_out: null,
    };
    f.attempts.set(a.id, a);
    f.run(a.run).attempts.push(a);
  },
  attempt_lifecycle(f, e, b) {
    const a = f.attempts.get(String(e.subject));
    if (!a) return;
    a.lifecycle = String(b.lifecycle);
    a.updated_at = e.at;
    // An attempt that left awaiting_approval (screened again, invalidated) waits no more.
    if (a.lifecycle !== "awaiting_approval") {
      const v = f.run(a.run);
      v.pending_promotions = v.pending_promotions.filter((p) => p !== a.id);
    }
  },
  verdict(f, e, b) {
    const a = f.attempts.get(String(e.subject));
    if (!a) return;
    a.verdict = String(b.verdict);
    a.delta = typeof b.delta === "number" ? b.delta : null;
    a.values = metricValuesOf(b.values);
    a.ci =
      typeof b.ci_low === "number" && typeof b.ci_high === "number" ? [b.ci_low, b.ci_high] : null;
    a.reasons = typeof b.reasons === "string" ? b.reasons : null;
    a.updated_at = e.at;
    a.history.push(frozen({ at: e.at, verdict: a.verdict, delta: a.delta }));
    if (b.verdict === "win_confirmed" && typeof b.delta === "number") {
      f.confirmDelta.set(a.id, b.delta);
    }
  },
  held_out_checked(f, e, b) {
    // A goal run's champion's check names its champion (goal 086); else it is an attempt's.
    if (typeof b.champion_seq === "number") {
      f.run(typeof b.run === "string" ? b.run : String(e.subject)).champion_held_out = {
        ...heldOutView(e.at, b),
        champion_seq: b.champion_seq,
      };
      return;
    }
    const a = f.attempts.get(String(e.subject));
    if (a) a.held_out = heldOutView(e.at, b);
  },
};
