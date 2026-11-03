import type { GoalContract } from "../contract.ts";
import { type CellParams, cellParams, cellTimeoutS, type Kit, paramsText } from "../kit.ts";

/**
 * How each goal of a goal campaign is really checked (goal 082): its kit verifier or its metric
 * threshold, the cells it runs on as the kit runs them, each cell's time limit, and which cells
 * are held out. One reading, shared: a rig's harness reports it when a goal run starts (the
 * `goal_checks` event), and control works it out itself from a kit it keeps.
 *
 * A held-out cell is named, never shown: its parameters stay in the kit.
 */

/** One cell a goal runs on. */
export interface GoalCheckCell {
  name: string;
  held_out: boolean;
  /** The parameters the kit runs it with: a measured cell's only, each value cut to 200. */
  params?: CellParams | undefined;
  /**
   * The same parameters as the run gets them in `{params}`, in the kit's own order: one
   * `key=value` line each (a report's JSON sorts an object's keys).
   */
  args?: string | undefined;
  /** Its runs' time limit, in seconds: its own `timeout_s`, else the kit's `run.timeout_s`. */
  timeout_s?: number | undefined;
  /** The kit has no cell of this name. */
  missing?: boolean | undefined;
}

export interface GoalCheck {
  goal: string;
  description: string;
  required: boolean;
  how: "verifier" | "threshold" | "review";
  /** A kit verifier: its name, the verifiers it waits for, and its place in the order. */
  verifier?: string | undefined;
  requires?: string[] | undefined;
  priority?: number | undefined;
  /** A metric threshold: the metric, the comparison, the value, its unit and the runs per cell. */
  metric?: string | undefined;
  op?: string | undefined;
  value?: number | undefined;
  unit?: string | undefined;
  reps?: number | undefined;
  /** A review: what the review panel looks for. */
  criteria?: string[] | undefined;
  /** The cells it runs on, measured first; null when only the kit could say. */
  cells: GoalCheckCell[] | null;
  /** How many cells it has, when more than the list shows. */
  cells_total?: number | undefined;
  /** What the kit lacks that the goal names. */
  problems: string[];
}

export interface GoalChecks {
  /** The kit read, when there was one: its name, repository and commit. */
  kit: { name: string; repo: string; commit: string } | null;
  /** How the kit runs one cell: its run command, as kit.json gives it. */
  run_command: string[] | null;
  /** The kit's own time limit for a run, which a cell's `timeout_s` overrides. */
  timeout_s: number | null;
  goals: GoalCheck[];
}

/** The most cells one goal lists, and parameters one cell shows. */
const MAX_CELLS = 100;
const MAX_PARAMS = 40;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function shownParams(p: CellParams): CellParams {
  return Object.fromEntries(
    Object.entries(p)
      .slice(0, MAX_PARAMS)
      .map(([k, v]) => [clip(k, 80), typeof v === "string" ? clip(v, 200) : v]),
  );
}

/**
 * Goal checks read back from a rig's `goal_checks` event, each field checked: the report is data.
 * Null when it is not one.
 */
export function parseGoalChecks(body: unknown): GoalChecks | null {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(b.goals)) return null;
  const str = (v: unknown, n = 300) => (typeof v === "string" ? clip(v, n) : undefined);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const strs = (v: unknown) =>
    Array.isArray(v) ? v.filter((x) => typeof x === "string").map((x) => clip(x, 300)) : undefined;
  const params = (v: unknown): CellParams | undefined => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    const out: CellParams = {};
    for (const [k, x] of Object.entries(v).slice(0, MAX_PARAMS))
      if (typeof x === "string" || typeof x === "boolean" || num(x) !== undefined)
        out[clip(k, 80)] = typeof x === "string" ? clip(x, 200) : (x as number | boolean);
    return out;
  };
  const kit = (b.kit ?? null) as Record<string, unknown> | null;
  return {
    kit:
      kit && typeof kit.name === "string"
        ? {
            name: clip(kit.name, 80),
            repo: str(kit.repo, 200) ?? "",
            commit: str(kit.commit, 64) ?? "",
          }
        : null,
    run_command: strs(b.run_command) ?? null,
    timeout_s: num(b.timeout_s) ?? null,
    goals: b.goals.slice(0, 200).flatMap((x): GoalCheck[] => {
      const g = (x ?? {}) as Record<string, unknown>;
      if (typeof g.goal !== "string") return [];
      const how =
        g.how === "verifier" || g.how === "threshold" || g.how === "review" ? g.how : null;
      if (!how) return [];
      const cells = Array.isArray(g.cells)
        ? g.cells.slice(0, MAX_CELLS).flatMap((y): GoalCheckCell[] => {
            const c = (y ?? {}) as Record<string, unknown>;
            if (typeof c.name !== "string") return [];
            const held = c.held_out === true;
            return [
              {
                name: clip(c.name, 200),
                held_out: held,
                // A held-out cell's parameters are never shown, whatever the report says.
                ...(held ? {} : { params: params(c.params), args: str(c.args, 4000) }),
                timeout_s: num(c.timeout_s),
                ...(c.missing === true ? { missing: true } : {}),
              },
            ];
          })
        : null;
      return [
        {
          goal: clip(g.goal, 200),
          description: str(g.description, 2000) ?? "",
          required: g.required !== false,
          how,
          verifier: str(g.verifier, 200),
          requires: strs(g.requires),
          priority: num(g.priority),
          metric: str(g.metric, 200),
          op: g.op === ">=" || g.op === ">" || g.op === "<=" || g.op === "<" ? g.op : undefined,
          value: num(g.value),
          unit: str(g.unit, 40),
          reps: num(g.reps),
          criteria: strs(g.criteria),
          cells,
          cells_total: num(g.cells_total),
          problems: strs(g.problems) ?? [],
        },
      ];
    }),
  };
}

/**
 * Each goal's check, from the contract and, when there is one, the kit. Without the kit, what
 * the contract says: the verifier's name, a threshold and its cells, the held-out cells.
 */
export function goalChecks(
  contract: GoalContract,
  kit?: { kit: Kit; repo: string; commit: string } | undefined,
): GoalChecks {
  const held = new Set(contract.held_out_cells);
  const k = kit?.kit;
  const cellsOf = (names: string[]): { cells: GoalCheckCell[]; total: number } => {
    const ordered = [...names.filter((n) => !held.has(n)), ...names.filter((n) => held.has(n))];
    const cells = ordered.slice(0, MAX_CELLS).map((name): GoalCheckCell => {
      if (!k) return { name, held_out: held.has(name) };
      const params = cellParams(k, name);
      if (!params) return { name, held_out: held.has(name), missing: true };
      const shown = shownParams(params);
      return {
        name,
        held_out: held.has(name),
        // A held-out cell's parameters are its hidden inputs: never shown.
        ...(held.has(name) ? {} : { params: shown, args: paramsText(shown).trimEnd() }),
        timeout_s: cellTimeoutS(k, name),
      };
    });
    return { cells, total: ordered.length };
  };
  const goals = contract.goals.map((g): GoalCheck => {
    const base = {
      goal: g.id,
      description: g.description,
      required: g.required,
      problems: [] as string[],
    };
    const v = g.verify;
    if (v.type === "review")
      return { ...base, how: "review", criteria: [...v.criteria], cells: [] };
    if (v.type === "code") {
      const ver = k?.verifiers[v.verifier];
      if (k && !ver) base.problems.push(`the kit has no verifier ${v.verifier}`);
      const listed = ver ? cellsOf(ver.cells) : undefined;
      return {
        ...base,
        how: "verifier",
        verifier: v.verifier,
        ...(ver ? { requires: [...ver.requires], priority: ver.priority } : {}),
        cells: listed ? listed.cells : null,
        ...(listed && listed.total > listed.cells.length ? { cells_total: listed.total } : {}),
      };
    }
    // A metric threshold: on its cells, or every cell of the kit that is not held out.
    if (k && !(v.metric in k.metrics)) base.problems.push(`the kit has no metric ${v.metric}`);
    const names = v.cells ?? (k ? Object.keys(k.cells).filter((c) => !held.has(c)) : undefined);
    const listed = names ? cellsOf(names) : undefined;
    return {
      ...base,
      how: "threshold",
      metric: v.metric,
      op: v.op,
      value: v.value,
      ...(k ? { unit: k.metrics[v.metric]?.unit ?? "" } : {}),
      reps: contract.threshold_reps,
      cells: listed ? listed.cells : null,
      ...(listed && listed.total > listed.cells.length ? { cells_total: listed.total } : {}),
    };
  });
  return {
    kit: kit ? { name: kit.kit.name, repo: kit.repo, commit: kit.commit } : null,
    run_command: k ? [...k.run.command] : null,
    timeout_s: k ? k.run.timeout_s : null,
    goals,
  };
}
