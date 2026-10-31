import type { AttemptView, RunView } from "../../views/index.ts";
import { ago, esc, gainChip, measuredWords } from "../components/index.ts";
import { attemptHref } from "../urls.ts";
import { clip, listText, runStatusText, signed, verdictText } from "../words/index.ts";

/**
 * A change in words, for the owner's decision on it and for its page: what the judge found, what
 * the agent says that it did, and the facts that decide it.
 */

/** A commit's first 8 characters, or "?" when there is none. */
export const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 8) : "?");

/** What the judge found about an attempt, in a sentence. */
export function evidence(r: RunView, a: AttemptView): string {
  const goal = r.mode === "goal";
  const last = a.history.at(-1);
  // Simplified Technical English: short sentences, approved words, one meaning each.
  if (!last) return "The judge has not made a decision about it.";
  if (goal) {
    const n = a.gained?.length ?? 0;
    const gained = listText(a.gained ?? []);
    const these = n === 1 ? "this goal" : "these goals";
    const kept = a.lost.length
      ? `It loses ${listText(a.lost)}, which the champion gets.`
      : "It keeps all the goals that the champion gets.";
    const unsure = a.unsure.length
      ? ` The judge could not do the check for ${listText(a.unsure)}.`
      : "";
    if (last.verdict === "goal_progress")
      return `The judge did the goal checks again on new runs. With this change, the project gets ${these} that the champion does not get: ${gained}. ${kept}${unsure}`;
    if (last.verdict === "goal_screened")
      return `In the first test, the project got ${these} with this change: ${gained}. At this time, the judge does the goal checks again on new runs. ${kept}${unsure}`;
    return `${cap(verdictText(last.verdict))}${a.lost.length ? `: it loses ${listText(a.lost)}` : ""}.${unsure}`;
  }
  const screened = a.history.find((h) => h.verdict === "win_screened" && h.delta !== null);
  const interval = a.ci
    ? ` The correct value is between ${signed(a.ci[0])} and ${signed(a.ci[1])}.`
    : "";
  if (last.verdict === "win_confirmed" && typeof last.delta === "number")
    return `The judge measured the change again on new runs: ${signed(last.delta)} compared with the champion.${interval}${typeof screened?.delta === "number" ? ` The first test measured ${signed(screened.delta)}.` : ""}`;
  return `${cap(verdictText(last.verdict, last.delta))}.`;
}

export const cap = (s: string) => s.replace(/^./, (c) => c.toUpperCase());

/** "The change" for a decision: hypothesis, who made it, on what. */
export function changeFacts(r: RunView, a: AttemptView | undefined, id: string): string {
  if (!a)
    return `<dt>The change</dt><dd><code>${esc(id)}</code> <span class="muted">(no details reported)</span></dd>`;
  const who = [
    a.lane ? `made by ${esc(a.lane)}` : "",
    a.family ? `direction <b>${esc(a.family)}</b>` : "",
    a.commit
      ? `commit <code>${esc(short(a.commit))}</code>${a.parent ? ` on <code>${esc(short(a.parent))}</code>` : ""}`
      : "",
    `submitted ${esc(ago(a.recorded_at, Date.now()))} ago`,
  ]
    .filter(Boolean)
    .join(" · ");
  const flaws = a.known_flaws.length
    ? `<dt>Problems that the agent wrote</dt><dd><ul class="flaws">${a.known_flaws.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></dd>`
    : `<dt>Problems that the agent wrote</dt><dd class="muted">None.</dd>`;
  const files = a.files.length
    ? `<dt>Files</dt><dd class="small">${a.files_total} file${a.files_total === 1 ? "" : "s"}: ${a.files
        .slice(0, 8)
        .map(
          (f) =>
            `<code>${esc(f.path)}</code> <span class="muted">${f.added === null ? "binary" : `+${f.added} −${f.removed ?? 0}`}</span>`,
        )
        .join(", ")}${a.files_total > 8 ? `, and ${a.files_total - 8} more` : ""}</dd>`
    : "";
  const reasons = a.reasons
    ? `<div class="muted small">The judge: ${esc(clip(a.reasons, 400))}</div>`
    : "";
  // The row says what the change does in plain words; the agent's own account is quoted here.
  const own = a.hypothesis ? `<div class="quote">${esc(a.hypothesis)}</div>` : "";
  return `<dt>What the agent says that it did</dt><dd>${own}<div class="small">${who} · <a href="${attemptHref(r, a.id)}">${esc(a.id)}</a></div></dd>${files}
<dt>What the judge found</dt><dd>${esc(evidence(r, a))}${reasons}</dd>${flaws}${
    r.status === "running"
      ? ""
      : `<dt>The run</dt><dd>This run is <b>${esc(runStatusText(r))}</b>. A new champion changes this run only. The other runs of the campaign do not change.</dd>`
  }`;
}

/**
 * What a change does, in plain words, for a decision's row: who made it, how many files, and
 * what the judge found. The agent's own account is in the row's details.
 */
export const changeHeadline = (r: RunView, a: AttemptView | undefined, id: string) => {
  if (!a) return `The change <code>${esc(id)}</code>`;
  const who = a.files_total
    ? `${esc(a.lane ?? "An agent")} changed ${a.files_total} file${a.files_total === 1 ? "" : "s"}.`
    : `${esc(a.lane ?? "An agent")} made a change.`;
  if (r.mode === "goal" && a.gained?.length)
    return `${who} With this change, the project gets ${a.gained.length} more goal${a.gained.length === 1 ? "" : "s"}: ${esc(listText(a.gained))}.`;
  if (r.mode !== "goal" && typeof a.delta === "number")
    return `${who} The judge measured it: ${esc(measuredWords(r, { ...a, delta: a.delta }))} compared with the champion.`;
  return `${who} ${esc(clip(a.hypothesis ?? "", 140))}`;
};

/** The facts that decide a change, as chips: its gain and interval, goals, flaws and files. */
export function changeChips(r: RunView, a: AttemptView | undefined): string {
  if (!a) return "";
  const out: string[] = [];
  if (r.mode !== "goal" && typeof a.delta === "number") {
    out.push(gainChip(r, a, a.delta > 0 ? "ok" : "bad"));
    if (a.ci)
      out.push(`<span class="chip">${esc(signed(a.ci[0]))} to ${esc(signed(a.ci[1]))}</span>`);
  }
  if (r.mode === "goal") {
    if (a.gained?.length)
      out.push(
        `<span class="chip ok"><b>+${a.gained.length} goal${a.gained.length === 1 ? "" : "s"}</b></span>`,
      );
    if (a.lost.length)
      out.push(
        `<span class="chip bad">−${a.lost.length} goal${a.lost.length === 1 ? "" : "s"}</span>`,
      );
  }
  const flaws = a.known_flaws.length;
  if (flaws)
    out.push(
      `<span class="chip warn">${flaws} problem${flaws === 1 ? "" : "s"} from the agent</span>`,
    );
  if (a.files_total)
    out.push(`<span class="chip">${a.files_total} file${a.files_total === 1 ? "" : "s"}</span>`);
  return out.join("");
}
