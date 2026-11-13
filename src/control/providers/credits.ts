import type { ControlStore } from "../store/index.ts";
import type { PlanCredits } from "./plan-usage.ts";

/**
 * A Claude subscription's usage credits on Settings › Providers (goal 169; the owner's decision of
 * 2026-11-01): while Claude Code reports them on, the subscription is marked, with a note on why
 * it matters, since Thermite's rule that a full window waits for its reset holds only with them
 * off. The owner may dismiss the note: the mark stays, and the note comes back once Claude Code
 * reports the credits on again after reporting them off. The dismissal is a step in the history
 * of the rig whose report showed them, which names the provider, with an entry in the audit log.
 */

/** The step a dismissal of the note adds to the history of the rig that reported the credits. */
export const CREDITS_NOTE_DISMISSED_STEP = "credits_note_dismissed";

/** When the owner last dismissed the note of a provider's usage credits; undefined: never. */
export async function creditsNoteDismissedAt(
  store: ControlStore,
  provider: string,
): Promise<string | undefined> {
  let at: string | undefined;
  for (const r of await store.reportedRigs.list({ withRetired: true }))
    for (const s of await store.rigHistory.latest(r.id, [CREDITS_NOTE_DISMISSED_STEP], 20))
      if (s.detail === provider && (!at || s.at > at)) at = s.at;
  return at;
}

/**
 * Whether the note shows: the credits are on, and the owner has not dismissed it since they last
 * came on after being off (`since`; null: on from the rig's first report of them).
 */
export function creditsNoteShows(
  c: PlanCredits | undefined,
  dismissedAt: string | undefined,
): boolean {
  if (!c?.on) return false;
  if (!dismissedAt) return true;
  return c.since !== null && c.since > dismissedAt;
}

/** The owner dismisses the note: a step in the reporting rig's history, and the audit log. */
export async function dismissCreditsNote(
  store: ControlStore,
  provider: string,
  c: PlanCredits,
  by: string,
): Promise<void> {
  await store.rigHistory.add(c.rig, CREDITS_NOTE_DISMISSED_STEP, true, provider);
  await store.auditLog.add(by, "credits_note_dismissed", {
    provider,
    rig: c.rig,
    reported_at: c.at,
  });
}
