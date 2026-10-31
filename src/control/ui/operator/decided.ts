import type { Decision } from "../../store/index.ts";
import { ago, esc } from "../components/index.ts";

/**
 * The owner's latest choice on one waiting item, made since it began waiting, and what the rig
 * answered. A choice sent and not refused takes the item out of the lists at once (the owner,
 * 2026-10-21: "once a decision has been made, lets clear it off the screen"); the change's own
 * page still says what was chosen and what the rig did. A refused choice brings the item back,
 * with the cause and the buttons.
 */
export function decidedState(
  ds: Decision[],
  item: { rig: string; run: string; attempt?: string; review?: number; proposal?: number },
  since: string | undefined,
  label: (d: Decision) => string,
  now: number,
): { sent: boolean; html: string } | undefined {
  const d = ds.find(
    (x) =>
      x.rig === item.rig &&
      x.run === item.run &&
      (item.attempt === undefined || x.attempt === item.attempt) &&
      (item.review === undefined || x.review === item.review) &&
      (item.proposal === undefined || x.proposal === item.proposal) &&
      (!since || x.issued_at >= since),
  );
  if (!d) return undefined;
  const chose = `You selected <b>${esc(label(d))}</b> ${esc(ago(d.issued_at, now))} ago.`;
  const result = d.outcome?.result ?? {};
  const refused =
    d.status === "failed" ||
    d.status === "rejected" ||
    d.status === "expired" ||
    d.outcome?.accepted === false;
  if (refused) {
    const why =
      typeof result.error === "string"
        ? result.error
        : d.status === "expired"
          ? "the command expired before the rig got it"
          : `the rig answered ${d.status}`;
    return {
      sent: false,
      html: `<span class="bad">${chose} The rig did not do it. The cause from the rig: ${esc(why)}.</span>`,
    };
  }
  if (d.status === "pending")
    return {
      sent: true,
      html: `${chose} Control sent it to the rig. The rig does it in less than 10 seconds.`,
    };
  const did =
    d.kind === "approve_promotion"
      ? result.promoted
        ? `The rig made the change ${typeof result.seq === "number" ? `champion #${result.seq}` : "the champion"}.`
        : result.rescreen
          ? `The champion changed, thus the rig tests the change again against champion #${esc(String(result.champion_seq ?? "?"))}.`
          : "The rig did it."
      : d.kind === "decline_promotion"
        ? "The rig rejected the change."
        : "The rig recorded your decision.";
  return {
    sent: true,
    html: `${chose} ${did}`,
  };
}
