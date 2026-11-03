import { ago, esc } from "../components/index.ts";

/**
 * A full reset under way, on its rig's page (goal 181: the Reports page no longer holds the
 * resets): its state, where it is, and Cancel while it can be, or Confirm the wipe once it waits
 * for the owner, which Needs you also asks.
 */

/** The steps a reset can still be cancelled in. */
const CANCELLABLE = ["start", "quiescing", "exporting", "verifying", "awaiting_owner"];

const STATE_WORDS: Record<string, string> = {
  start: "starting: the runs are being paused",
  quiescing: "waiting for the runs to pause and the judge to finish",
  exporting: "the rig is making its full export",
  verifying: "waiting for the export to reach the results repository or control",
  awaiting_owner: "waiting for you to confirm the wipe",
};

export function resetCard(rs: Record<string, unknown>, csrf: string, now: number): string {
  const state = String(rs.state);
  const act = (what: string, label: string, cls = "") =>
    `<form class="inline" method="post" action="/ui/resets/${esc(rs.id)}/${what}"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="sm${cls ? ` ${cls}` : ""}">${label}</button></form>`;
  const exp =
    typeof rs.export_name === "string" && rs.export_name
      ? ` Its export: <code>${esc(rs.export_name)}</code>.`
      : "";
  return `<div class="card ${state === "awaiting_owner" ? "bad" : "warn"}" style="margin-bottom:16px" data-reset="${esc(rs.id)}"><div class="card-head"><span class="title">A full reset is under way</span><span class="right muted small">${esc(ago(String(rs.updated_at), now))} ago</span></div><div class="small" style="margin:6px 0 4px"><span class="chip">${esc(state)}</span> ${esc(STATE_WORDS[state] ?? "")}.${exp}</div>${rs.detail ? `<div class="small muted" style="margin-bottom:10px"><b>Detail:</b> ${esc(rs.detail)}</div>` : ""}<div class="row" style="gap:6px">${state === "awaiting_owner" ? act("confirm", "Confirm the wipe", "danger") : ""}${CANCELLABLE.includes(state) ? act("cancel", "Cancel the reset") : ""}</div></div>`;
}
