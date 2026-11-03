import { type CheckRow, checkWaits, clockUtc, elapsedWords } from "../../command-progress.ts";
import { ago, esc } from "../components/index.ts";

/**
 * A rig check's row, and its sentence on Providers, in each state (goal 080): not run yet, sent,
 * running (its time counts on), passed or failed, and refused or expired with the reason. A row
 * that waits for the rig names its follow route (data-follow): the page script asks it every few
 * seconds and draws the row again when its state changes. Without the script, the row shows the
 * state as it was when the page was made.
 */

/** Where the page script follows a check's row. */
export const checkFollowUrl = (rig: string, check: string): string =>
  `/ui/rigs/${encodeURIComponent(rig)}/checks/${encodeURIComponent(check)}.json`;

/** A time so far that the page script counts on each second (data-since). */
export const ticking = (since: string, now: number): string =>
  `<span data-since="${esc(since)}">${esc(elapsedWords(now - Date.parse(since)))}</span>`;

/** What a running check pauses, in words: the line under its title while it runs. */
export function checkPauses(check: string): string {
  return check === "smoke"
    ? "Its running runs are paused for it, and resumed after."
    : "Nothing is paused for it.";
}

/** The line under a check's title, for the states that have one. */
function checkLine(check: string, row: CheckRow): { text: string; bad: boolean } | null {
  switch (row.state) {
    case "sent":
      return {
        text: `Sent to the rig at ${clockUtc(row.at ?? "")}. It starts when the rig takes it.`,
        bad: false,
      };
    case "running":
      return { text: checkPauses(check), bad: false };
    case "refused":
      return {
        text: `Not run: the rig refused it at ${clockUtc(row.at ?? "")}. ${row.why ?? ""}`.trim(),
        bad: true,
      };
    case "expired":
      return {
        text: `Not run: the rig did not take it before ${clockUtc(row.at ?? "")}.`,
        bad: true,
      };
    default:
      return null;
  }
}

/** The chip of a check's row: its state, or its last result beside a command that did not run. */
function checkChip(row: CheckRow, now: number): string {
  if (row.state === "sent") return `<span class="chip info">sent</span>`;
  if (row.state === "running")
    return `<span class="chip info">running · ${ticking(row.since ?? new Date(now).toISOString(), now)}</span>`;
  const r = row.last;
  if (!r?.finished_at) return `<span class="chip">not run yet</span>`;
  return r.ok ? `<span class="chip ok">passed</span>` : `<span class="chip bad">failed</span>`;
}

/**
 * One check's row on the rig's page: the chip, the check's name and when its result came, its
 * result's sentence, the line for its state, what the check does, and its button. The button is
 * off while the check waits for the rig ("Sent", "Running…").
 */
export function checkRowHtml(o: {
  rig: string;
  check: string;
  name: string;
  what: string;
  row: CheckRow;
  now: number;
  button: (label: string, disabled: boolean) => string;
}): string {
  const { row, now } = o;
  const waits = checkWaits(row);
  const r = row.last;
  const result = !waits && r?.finished_at ? r : undefined;
  const when = result?.finished_at
    ? ` <span class="muted small">${esc(ago(result.finished_at, now))} ago</span>`
    : "";
  const sum = result?.summary
    ? `<span class="ck-sum ${result.ok ? "" : "bad"}">${esc(result.summary)}</span>`
    : "";
  const l = checkLine(o.check, row);
  const line = l
    ? `<span class="ck-sum${l.bad ? " bad" : ""}" data-state="${row.state}">${esc(l.text)}</span>`
    : "";
  const label = row.state === "sent" ? "Sent" : row.state === "running" ? "Running…" : "Run it";
  return `<div class="ck" data-check="${esc(o.check)}"${waits ? ` data-follow="${esc(checkFollowUrl(o.rig, o.check))}" data-follow-state="${row.state}"` : ""}><span class="ck-res">${checkChip(row, now)}</span><span class="ck-main"><span><b>${esc(o.name)}</b>${when}</span>${sum}${line}<span class="ck-what">${esc(o.what)}</span></span>${o.button(label, waits)}</div>`;
}

/**
 * The model check's sentence in a rig's row on Providers › Harness and model for each rig, in
 * each state. HTML: a running check's time counts on.
 */
export function modelCheckHtml(row: CheckRow, now: number): string {
  const r = row.last;
  switch (row.state) {
    case "sent":
      return `Its model check was sent to the rig at ${esc(clockUtc(row.at ?? ""))}. It starts when the rig takes it.`;
    case "running":
      return `Its model check is running · ${ticking(row.since ?? new Date(now).toISOString(), now)}.`;
    case "refused":
      return `Its model check did not run: the rig refused it at ${esc(clockUtc(row.at ?? ""))}. ${esc(row.why ?? "")}`.trim();
    case "expired":
      return `Its model check did not run: the rig did not take it before ${esc(clockUtc(row.at ?? ""))}.`;
    default:
      return !r?.finished_at
        ? "Its model check has not run."
        : esc(
            `Its model check ${r.ok ? "passed" : "FAILED"} ${ago(r.finished_at, now)} ago: ${r.summary ?? ""}`,
          );
  }
}
