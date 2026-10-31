import type { RigView, StoredEvent } from "../../views/index.ts";
import { ago, esc } from "../components/index.ts";
import { attemptHref } from "../urls.ts";
import { clip, runOfAttempt, type Sentence, sentence } from "../words/index.ts";

/** What happened: one sentence a row, newest first, each linking the attempt it is about. */

/** A sentence, escaped, with its attempt named by what it does and linked. */
export function sentenceHtml(u: RigView, s: Sentence): string {
  let html = esc(s.text);
  if (s.attempt) {
    const id = esc(s.attempt);
    const r = runOfAttempt(u, s.attempt);
    const hyp = r?.attempts.find((x) => x.id === s.attempt)?.hypothesis;
    if (r)
      html = html.replace(
        id,
        `<a href="${attemptHref(r, s.attempt)}" title="${id}">${hyp ? `“${esc(clip(hyp, 70))}”` : id}</a>`,
      );
  }
  return html;
}

/** A line of a rig's history that is not one of its events: a step control took, its state. */
export interface TimelineRow {
  at: string;
  /** The dot's tone: ok, warn, bad or "". */
  tone: string;
  /** The line, as escaped HTML. */
  html: string;
  /** Its kind, for a page's history filters (data-k). */
  k?: string | undefined;
}

/** Whether a rig event is the judge's (its jobs, measurements and checks) or the runs'. */
const JUDGE_EVENT =
  /^(job_|verdict|calibrat|screen|confirm|measure|baseline|rig_check|smoke|held_out)/;

/** Events as a readable list, newest first; bookkeeping events are left out. */
export function timeline(
  items: { u: RigView; e: StoredEvent }[],
  now: number,
  opts: {
    limit?: number;
    showRig?: boolean;
    /** More lines, placed by their time among the events. */
    extra?: TimelineRow[] | undefined;
    /** Each event's line gets data-k: "judge" or "runs". */
    kinds?: boolean | undefined;
    /** The card's id, for a page's filters. */
    id?: string | undefined;
  } = {},
): string {
  const lines: { at: string; html: () => string | null }[] = [
    ...items.map(({ u, e }) => ({
      at: e.at,
      html: () => {
        const s = sentence(u, e);
        if (!s) return null;
        const k = opts.kinds ? ` data-k="${JUDGE_EVENT.test(e.kind) ? "judge" : "runs"}"` : "";
        return `<div class="tl-row"${k}><span class="tl-t" title="${esc(e.at)}">${esc(ago(e.at, now))}</span><span class="dot ${s.tone}"></span><span class="tl-s">${sentenceHtml(u, s)}</span>${opts.showRig ? `<span class="tl-rig">${esc(u.id)}</span>` : ""}</div>`;
      },
    })),
    ...(opts.extra ?? []).map((x) => ({
      at: x.at,
      html: () =>
        `<div class="tl-row"${x.k ? ` data-k="${esc(x.k)}"` : ""}><span class="tl-t" title="${esc(x.at)}">${esc(ago(x.at, now))}</span><span class="dot ${esc(x.tone)}"></span><span class="tl-s">${x.html}</span></div>`,
    })),
  ];
  const rows: string[] = [];
  for (const line of lines.sort((a, b) => b.at.localeCompare(a.at))) {
    const html = line.html();
    if (!html) continue;
    rows.push(html);
    if (rows.length >= (opts.limit ?? 30)) break;
  }
  const id = opts.id ? ` id="${esc(opts.id)}"` : "";
  return rows.length
    ? `<div class="card flat tl"${id}>${rows.join("")}</div>`
    : `<div class="card"${id}><div class="empty">Nothing yet.</div></div>`;
}
