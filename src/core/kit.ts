import { z } from "zod";
import { type Contract, ID_PATTERN } from "./contract.ts";
import { McpUses } from "./mcp.ts";
import { normalizePath } from "./paths.ts";

/**
 * A project kit: the judge-side recipe for building and measuring one project on one target
 * type. It is pinned by commit in the contract, imported through a signed command, and never
 * readable by agents. Kit scripts may be in whatever language the project's tooling needs.
 *
 * Commands are argv arrays with placeholders:
 *   {kit}    the kit checkout in the check; in a run, the run's read-only copy of `run.copy`
 *   {build}  the verified build directory of the arm being run (read-only)
 *   {params} a file with the cell's parameters as key=value lines ({params_json}: as JSON)
 *   {out}    the run's output directory (with run.driver, the driver's alone)
 *   {models} the imported models, one read-only file per sha256: `{models:<sha256>}` (run and
 *            check only; the contract's `models` list names them)
 *
 * This is the kit's schema and its checks, which control and the harness share. The judge reads a
 * kit from its folder and fills these placeholders in harness/judge/kits.ts.
 */

/**
 * The longest time limit a run may have, a day: the broker starts no run with a longer one, and a
 * kit's time limits are held to it too.
 */
export const MAX_RUN_MS = 24 * 3_600_000;

const Argv = z.array(z.string().min(1)).min(1);
const Mib = z.number().int().positive();
/** A time limit in seconds, at most a day: the broker runs nothing for longer. */
const MAX_LIMIT_S = MAX_RUN_MS / 1000;
const Seconds = z
  .number()
  .int()
  .positive()
  .max(MAX_LIMIT_S, `a time limit is at most ${MAX_LIMIT_S} s (24 hours)`);
/** A cell's parameters: what a run receives through {params} and {params_json}. */
const CellParams = z.record(z.string(), z.union([z.number(), z.string(), z.boolean()]));
export type CellParams = z.infer<typeof CellParams>;
/**
 * A cell: its parameters alone, or `{params, timeout_s}` to give it its own time limit, which
 * overrides `run.timeout_s` for its runs (a slow diagnostic cell need not set every cell's limit).
 * A parameter's value is never an object, so the two forms cannot be confused.
 */
const Cell = z.union([
  z.strictObject({ params: CellParams, timeout_s: Seconds.optional() }),
  CellParams,
]);
/** A path inside the kit, never the whole kit. */
const KitPath = z
  .string()
  .min(1)
  .refine(
    (p) =>
      p !== "." &&
      !p.startsWith("/") &&
      !p.endsWith("/") &&
      !p.split("/").includes("..") &&
      normalizePath(p) === p,
    "a kit path is relative, normalized and inside the kit",
  );

const KitFields = z.strictObject({
  schema_version: z.literal(1),
  name: z.string().regex(ID_PATTERN),
  /** The target driver type this kit measures on (cpu, cuda-gpu, ...). */
  target: z.string().min(1),
  build: z.strictObject({
    /** Kit paths copied into the build tree under .kit/ (build-time inputs, not secrets). */
    copy: z.array(KitPath).default([]),
    /** Run in the source tree as the builder user. */
    command: Argv,
    /** Paths, relative to the source tree, that make up the build. */
    outputs: z.array(z.string().min(1)).min(1),
    timeout_s: Seconds.default(600),
    rss_mib: Mib.default(4096),
    disk_mib: Mib.default(4096),
  }),
  /**
   * Every measurable cell and its parameters, and its own time limit where it has one. The
   * contract chooses which cells count.
   */
  cells: z.record(z.string().min(1), Cell),
  /** One timed run of one arm on one cell, as the run user. */
  run: z.strictObject({
    /**
     * Kit paths copied fresh into every run, read-only and owned by the judge, and reached as
     * `{kit:<path>}`: run drivers and their inputs, which the candidate's build cannot rewrite.
     * The run can read them, so never references or held-out inputs.
     */
    copy: z.array(KitPath).default([]),
    command: Argv,
    /**
     * The kit's driver, where a run needs one beside the candidate: started with `command`, as a
     * user of its own, its standard output the command's standard input and the command's output
     * its input. It writes {out}, and the run ends when it does; the judge times it. It gets no
     * {build}: it never runs the candidate's code. Without it, `command` runs alone.
     */
    driver: Argv.optional(),
    timeout_s: Seconds.default(300),
    rss_mib: Mib.default(1024),
    disk_mib: Mib.default(256),
  }),
  /**
   * The scores the judge measures, never anything the candidate prints:
   *   {unit, work}                 a rate from the judge's own clock: cell[work] / seconds;
   *   {unit, from: "time"}         the run's wall time in seconds, from the judge's clock;
   *   {unit, from: "check", field} a number the kit's check (the judge's own program) works out
   *                                from the run's outputs, such as accuracy or size.
   * Each must come out above zero: the judge compares runs by their ratio.
   */
  metrics: z.record(
    z.string().min(1),
    z.union([
      z.strictObject({ unit: z.string().min(1), work: z.string().min(1) }),
      z.strictObject({ unit: z.string().min(1).default("s"), from: z.literal("time") }),
      z.strictObject({
        // Unitless is common here: an accuracy, a ratio.
        unit: z.string().default(""),
        from: z.literal("check"),
        field: z.string().min(1),
      }),
    ]),
  ),
  /**
   * The correctness and dispatch check for one run's outputs, run by the judge (not the run
   * user). It prints one JSON object: {"pass": boolean, "reasons": [...], ...details}.
   */
  check: z.strictObject({
    command: Argv,
    timeout_s: Seconds.default(120),
  }),
  /**
   * Named verifiers for goal-mode contracts (`verify: {type: "code", verifier: name}`): a goal
   * is met when every listed cell's run passes the check.
   *
   * Priority gates: verifiers run in `priority` order (lower first), and one whose `requires`
   * (other verifiers) did not pass is not run at all: its goal is unmet, "not run". A goal that
   * cannot pass until another does (a model's perplexity, before it loads) then costs nothing.
   */
  verifiers: z
    .record(
      z.string().min(1),
      z.strictObject({
        cells: z.array(z.string().min(1)).min(1),
        priority: z.number().int().default(100),
        requires: z.array(z.string().min(1)).default([]),
      }),
    )
    .default({}),
  /**
   * The MCP servers this kit's campaigns give their agents (goal 068), by their names in
   * control's Settings: for each, the kinds of agent that get it (workers, planner, advisors)
   * and, only when narrowed, the tools each kind may call. The judge never uses them. A campaign
   * whose kit names a server Settings lacks can't start.
   */
  mcp_servers: McpUses.optional(),
});

export const KitSchema = KitFields.superRefine((kit, ctx) => {
  // Gates name other verifiers, and never form a cycle.
  const names = Object.keys(kit.verifiers);
  for (const [name, v] of Object.entries(kit.verifiers)) {
    for (const r of v.requires) {
      if (!names.includes(r) || r === name) {
        ctx.addIssue({
          code: "custom",
          path: ["verifiers", name, "requires"],
          message: `${r} is not another verifier of this kit`,
        });
      }
    }
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const cyclic = (n: string): boolean => {
    if (done.has(n)) return false;
    if (visiting.has(n)) return true;
    visiting.add(n);
    const found = (kit.verifiers[n]?.requires ?? []).some((r) => names.includes(r) && cyclic(r));
    visiting.delete(n);
    done.add(n);
    return found;
  };
  for (const n of names) {
    if (cyclic(n)) {
      ctx.addIssue({
        code: "custom",
        path: ["verifiers", n],
        message: "verifier gates form a cycle",
      });
      break;
    }
  }
  // A run reaches only the kit paths it copies.
  for (const field of ["command", "driver"] as const) {
    for (const arg of kit.run[field] ?? []) {
      for (const m of arg.matchAll(/\{kit(?::([^}]+))?\}/g)) {
        const sub = m[1] === undefined ? undefined : normalizePath(m[1]);
        const covered =
          sub === undefined
            ? kit.run.copy.length > 0
            : kit.run.copy.some((c) => sub === c || sub.startsWith(`${c}/`));
        if (!covered) {
          ctx.addIssue({
            code: "custom",
            path: ["run", field],
            message: `${m[0]} is not in run.copy (a run cannot read the kit)`,
          });
        }
      }
    }
  }
  // A driver writes the outputs and never reaches the candidate's build.
  const uses = (argv: readonly string[], name: string) =>
    argv.some((a) => new RegExp(`\\{${name}(?::[^}]+)?\\}`).test(a));
  if (kit.run.driver && uses(kit.run.driver, "build"))
    ctx.addIssue({
      code: "custom",
      path: ["run", "driver"],
      message: "{build} is not for the driver: the candidate's build runs as run.command alone",
    });
  if (kit.run.driver && uses(kit.run.command, "out"))
    ctx.addIssue({
      code: "custom",
      path: ["run", "command"],
      message: "with run.driver, the driver writes {out}: the candidate's command gets none",
    });
});
export type Kit = z.infer<typeof KitSchema>;

/** A cell as the kit gives it, in either form. */
type KitCell = Kit["cells"][string];

const wrapped = (c: KitCell): c is { params: CellParams; timeout_s?: number | undefined } =>
  typeof (c as { params?: unknown }).params === "object" &&
  (c as { params?: unknown }).params !== null;

/** A cell's parameters, in either of its forms; undefined when the kit has no such cell. */
export function cellParams(kit: Kit, cell: string): CellParams | undefined {
  const c = Object.hasOwn(kit.cells, cell) ? kit.cells[cell] : undefined;
  if (!c) return undefined;
  return wrapped(c) ? c.params : (c as CellParams);
}

/** A cell's run time limit in seconds: its own `timeout_s`, else the kit's `run.timeout_s`. */
export function cellTimeoutS(kit: Kit, cell: string): number {
  const c = Object.hasOwn(kit.cells, cell) ? kit.cells[cell] : undefined;
  return (c && wrapped(c) ? c.timeout_s : undefined) ?? kit.run.timeout_s;
}

/** Cell parameters as key=value lines (easy to read from any language). */
export function paramsText(params: Record<string, number | string | boolean>): string {
  return `${Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")}\n`;
}

/**
 * What a contract asks of its kit that the kit does not have, found when the campaign is
 * assigned rather than when the judge first runs: the target, cells, metrics and verifiers the
 * contract names. Empty when they all fit.
 */
export function kitProblems(contract: Contract, kit: Kit, targetType?: string): string[] {
  const out: string[] = [];
  if (targetType && kit.target !== targetType)
    out.push(`the kit measures on ${kit.target}, and this rig's target is ${targetType}`);
  const cell = (c: string, where: string) => {
    if (!(c in kit.cells)) out.push(`${where} names cell ${c}, which the kit does not have`);
  };
  const metric = (m: string, where: string) => {
    if (!(m in kit.metrics)) out.push(`${where} names metric ${m}, which the kit does not have`);
  };
  if (contract.mode === "hill_climb") {
    for (const c of contract.cells) cell(c, "cells");
    for (const c of contract.held_out_cells) cell(c, "held_out_cells");
    metric(contract.objective.primary.metric, "the objective");
    for (const s of contract.objective.secondary) metric(s.metric, "a secondary objective");
    for (const g of contract.guards) metric(g.metric, "a guard");
    for (const h of contract.hard_constraints)
      if (h.kind !== "check") metric(h.metric, "a hard constraint");
  }
  if (contract.mode === "goal") {
    for (const c of contract.held_out_cells) cell(c, "held_out_cells");
    for (const g of contract.goals) {
      const v = g.verify;
      if (v.type === "code" && !(v.verifier in kit.verifiers))
        out.push(`goal ${g.id} names verifier ${v.verifier}, which the kit does not have`);
      if (v.type === "metric_threshold") {
        metric(v.metric, `goal ${g.id}`);
        for (const c of v.cells ?? []) cell(c, `goal ${g.id}`);
      }
    }
  }
  // Every run works out every metric of the kit, and a rate divides its cell's `work` parameter
  // by the run's time. A cell the contract runs without that parameter, as a number above zero,
  // would fail every run as an infrastructure error (whose words would carry the cell's
  // parameters and time), so it is refused here.
  const rates = Object.entries(kit.metrics).flatMap(([name, m]) =>
    "work" in m ? [{ name, work: m.work }] : [],
  );
  for (const c of rates.length ? cellsRun(contract, kit) : []) {
    const params = cellParams(kit, c);
    if (!params) continue;
    for (const r of rates) {
      const amount = Number(params[r.work]);
      if (!Number.isFinite(amount) || amount <= 0)
        out.push(
          `cell ${c} has no parameter ${r.work} above zero, which rate metric ${r.name} divides by the run's time`,
        );
    }
  }
  return out;
}

/** The cells a contract's runs may measure: screened, held out, or checked for a goal. */
function cellsRun(contract: Contract, kit: Kit): string[] {
  const cells = new Set<string>();
  if (contract.mode === "hill_climb") {
    for (const c of [...contract.cells, ...contract.held_out_cells]) cells.add(c);
  }
  if (contract.mode === "goal") {
    for (const c of contract.held_out_cells) cells.add(c);
    // A code goal's verifier, and the gates it requires, each run their cells.
    const seen = new Set<string>();
    const verifier = (name: string) => {
      const v = Object.hasOwn(kit.verifiers, name) ? kit.verifiers[name] : undefined;
      if (!v || seen.has(name)) return;
      seen.add(name);
      for (const c of v.cells) cells.add(c);
      for (const r of v.requires) verifier(r);
    };
    for (const g of contract.goals) {
      const v = g.verify;
      if (v.type === "code") verifier(v.verifier);
      if (v.type === "metric_threshold")
        for (const c of v.cells ?? Object.keys(kit.cells)) cells.add(c);
    }
  }
  return [...cells];
}
