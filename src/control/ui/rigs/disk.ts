import { clockUtc } from "../../command-progress.ts";
import { diskOf, type RigDiskView, type RigView } from "../../views/index.ts";
import { esc, icon } from "../components/index.ts";
import { span } from "../words/index.ts";

/**
 * A rig's disk against its floor on its page (goal 173): its free space on each place it writes
 * to, from each report, and a card at the top while it is at its floor, saying what it holds and
 * how to make room. The same reading is a card under Needs you (operator/hold.ts).
 */

/** "state 40.2 of 100 GiB · outbox 3.1 of 100 GiB": each place's free space, in words. */
export const placesWords = (d: Pick<RigDiskView, "places">): string =>
  d.places.map((p) => `${p.name} ${p.free_gib} of ${p.total_gib} GiB`).join(" · ");

/** The places below the floor, or every place when none is (a disk that has not room enough yet). */
export const lowPlaces = (d: RigDiskView): RigDiskView["places"] => {
  const below = d.places.filter((p) => p.free_gib < d.floor_gib);
  return below.length ? below : d.places;
};

/** What a rig holds at its floor and how to make room, in words (escaped). */
export function diskWhat(d: RigDiskView): { held: string; room: string } {
  const where = lowPlaces(d)
    .map((p) => `its ${esc(p.name)} has ${p.free_gib} GiB free`)
    .join(", ");
  return {
    held: `The rig keeps ${d.floor_gib} GiB free on each place it writes to, and ${where}. No new trial, judge's job or export starts until there is room again. The work under way ends as it would: the judge's job in flight still writes its verdict.`,
    room: "Free space where the rig keeps that place: exports wait in the outbox until they leave the rig (see Results under The rig), and the scratch holds the lanes' build caches. The rig goes back to work by itself once each place has 1 GiB more than its floor. THERMITE_DISK_FLOOR_GIB sets the floor.",
  };
}

/** The rig page's "Disk free" fact: each report's reading, else the hardware's from its start. */
export function diskFree(u: Pick<RigView, "summary" | "hardware">): string {
  const d = diskOf(u.summary);
  if (d)
    return `${esc(placesWords(d))}${d.floor_gib ? ` <span class="muted">· floor ${d.floor_gib} GiB</span>` : ""}`;
  const h = u.hardware;
  return h
    ? esc(h.disks.map((x) => `${x.name} ${x.free_gib} of ${x.total_gib} GiB`).join(" · "))
    : "";
}

/** The card at the top of the rig's page while its disk is at its floor; "" otherwise. */
export function diskBanner(u: Pick<RigView, "summary">, now: number): string {
  const d = diskOf(u.summary);
  if (!d?.low) return "";
  const w = diskWhat(d);
  const since = d.since ? ` for ${esc(span(d.since, now))}, since ${esc(clockUtc(d.since))}` : "";
  return `<div class="card bad" style="margin-bottom:16px" id="disk" data-state="disk-low"><div class="card-head">${icon.warn}<span class="title">Its disk is at its floor${since}.</span></div>
<p class="small" style="margin:6px 0 6px;color:var(--foreground)">${w.held}</p>
<p class="small muted" style="margin:0">${w.room}</p></div>`;
}
