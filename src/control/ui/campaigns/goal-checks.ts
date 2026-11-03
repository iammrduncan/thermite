import type { GoalCheck, GoalCheckCell, GoalChecks } from "../../../core/goal/index.ts";
import { esc } from "../components/index.ts";

/**
 * "How it is checked" for each goal of a goal campaign (goal 082): under a goal on the campaign's
 * page and in a run's Goals block, a details element that opens to the goal's real check. It
 * shows the kit's verifier or the metric threshold, the cases (a kit's cells) it runs on with
 * the parameters the kit runs each measured one with, each case's time limit, and the held-out
 * cases by name only. Where the checks come from is said under them.
 */

/** Where a page's goal checks come from, in words for its last line. */
export type ChecksSource =
  | { from: "rig"; rig: string }
  | { from: "control" }
  | { from: "contract"; why: string };

/** A number as a person writes it: a large one with an exponent. */
const n = (x: number) =>
  Math.abs(x) >= 1e6 ? x.toExponential(3).replace("e+", "e") : String(Number(x.toPrecision(6)));

/** A cell's parameters as the kit hands them to its run: key=value, one after another. */
const paramsText = (p: Record<string, string | number | boolean>) =>
  Object.entries(p)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");

function cellRow(c: GoalCheckCell, kitTimeout: number | null): string {
  const limit =
    c.timeout_s === undefined
      ? `<span class="muted">·</span>`
      : `${esc(c.timeout_s)} s${kitTimeout !== null && c.timeout_s !== kitTimeout ? ` <span class="muted small">(its own)</span>` : ""}`;
  const runs = c.missing
    ? `<span class="chip bad">not in the kit</span>`
    : c.held_out
      ? `<span class="chip">held out</span> <span class="muted small">runs only to confirm a change that already looks better; its inputs stay hidden</span>`
      : c.args !== undefined || c.params
        ? `<code>${esc(c.args !== undefined ? c.args.split("\n").join(" ") : paramsText(c.params ?? {})) || "no parameters"}</code>`
        : `<span class="muted">·</span>`;
  return `<tr><td><code>${esc(c.name)}</code></td><td>${runs}</td><td>${limit}</td></tr>`;
}

/** The goal's rule in one sentence. */
function rule(g: GoalCheck): string {
  if (g.how === "review")
    return `The review panel reviews each new champion against ${g.criteria?.length ? g.criteria.map((c) => `“${esc(c)}”`).join(", ") : "its criteria"}. The goal counts as met only when you accept its review.`;
  if (g.how === "verifier")
    return `The kit's verifier <b>${esc(g.verifier ?? "?")}</b>: the goal is met when the kit's check passes on one run of each case below.${g.requires?.length ? ` It runs only after ${g.requires.map((r) => `<b>${esc(r)}</b>`).join(", ")} ${g.requires.length === 1 ? "passes" : "pass"}.` : ""}`;
  const unit = g.unit ? ` ${esc(g.unit)}` : "";
  return `<code>${esc(g.metric ?? "?")} ${esc(g.op ?? "?")} ${esc(g.value === undefined ? "?" : n(g.value))}</code>${unit} on each case below: the judge runs each case ${esc(g.reps ?? "?")} times, and the goal is met when each case's 95% interval of the mean is on the passing side.`;
}

/** The inside of one goal's "how it is checked": its rule, its cases, and where this comes from. */
export function howChecked(g: GoalCheck, all: GoalChecks, source: ChecksSource): string {
  const problems = g.problems.length
    ? `<div class="note warn small">${g.problems.map((p) => esc(p)).join("; ")}</div>`
    : "";
  const cases =
    g.how === "review"
      ? ""
      : g.cells === null
        ? `<div class="muted small">Its cases are in the kit, which control can't read here.</div>`
        : g.cells.length
          ? `<table class="howc-cells"><thead><tr><th>Case</th><th>How the kit runs it</th><th>Time limit</th></tr></thead><tbody>${g.cells
              .map((c) => cellRow(c, all.timeout_s))
              .join(
                "",
              )}</tbody></table>${g.cells_total && g.cells_total > g.cells.length ? `<div class="muted small">and ${esc(g.cells_total - g.cells.length)} more cases</div>` : ""}`
          : `<div class="muted small">It names no case.</div>`;
  const run =
    g.how !== "review" && all.run_command
      ? `<div class="small">Each run: <code>${esc(all.run_command.join(" "))}</code>, with the case's parameters in <code>{params}</code> and <code>{params_json}</code>${all.timeout_s !== null ? `, stopped after ${esc(all.timeout_s)} s unless the case sets its own limit` : ""}.</div>`
      : "";
  const from =
    source.from === "rig"
      ? `As ${esc(source.rig)}'s kit runs it${all.kit ? `: ${esc(all.kit.name)} at <code>${esc(all.kit.commit.slice(0, 12))}</code>` : ""}, reported when the run started.`
      : source.from === "control"
        ? `From the kit control keeps${all.kit ? `: ${esc(all.kit.name)} at <code>${esc(all.kit.commit.slice(0, 12))}</code>` : ""}.`
        : `What the contract says. ${esc(source.why)}`;
  return `<div class="howc"><div class="small">${rule(g)}</div>${problems}${cases}${run}<div class="muted small">${from}</div></div>`;
}

/** One goal's "how it is checked", folded under it. */
export function howCheckedDetails(
  g: GoalCheck | undefined,
  all: GoalChecks | undefined,
  source: ChecksSource | undefined,
): string {
  if (!g || !all || !source) return "";
  return `<details class="howcheck" data-k="how-${esc(g.goal)}"><summary>How it is checked</summary>${howChecked(g, all, source)}</details>`;
}
