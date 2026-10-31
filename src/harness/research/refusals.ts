import { FetchRefused } from "../../agents/tools/index.ts";
import { errorText } from "../../common/errors.ts";
import type { Ledger } from "../ledger/index.ts";

/**
 * Fetches refused for a reason that lasts (goal 136): too large, outside the campaign's sites,
 * disallowed by robots.txt, a private address. Asked for again in the same run, such a URL is
 * answered at once, with no new download, and the answer says that it was refused before and
 * will be again. A worker that got only "larger than 5000000 bytes" asked for the same PDF every
 * two minutes for hours. A failure that can pass, such as a timeout or a reset connection, is
 * not kept: the next ask fetches again.
 */

const ELSEWHERE =
  "Look for the same text elsewhere: an HTML page of the document, a part of it, or another source.";

export class Refusals {
  private readonly ledger: Ledger;
  /** By run, then by URL as archived: the reason, and how many times it was asked for. */
  private readonly seen = new Map<string, Map<string, { reason: string; asked: number }>>();

  constructor(ledger: Ledger) {
    this.ledger = ledger;
  }

  /** The answer to a URL refused before for a lasting reason, if it was; the ask is counted. */
  again(run: string, lane: string | null, url: string, key: string): { refused: string } | null {
    const before = this.seen.get(run)?.get(key);
    if (!before) return null;
    before.asked++;
    this.event(run, lane, url, before.reason, before.asked);
    return {
      refused: `${before.reason}. Refused before: this run has asked for this URL ${before.asked} times, and the answer will not change. ${ELSEWHERE}`,
    };
  }

  /** The answer to a fetch that failed: kept when its reason lasts. */
  refuse(run: string, lane: string | null, url: string, key: string, err: unknown) {
    if (!(err instanceof FetchRefused)) {
      const reason = `fetch failed: ${errorText(err)}`;
      this.event(run, lane, url, reason, 1);
      return { refused: reason };
    }
    const runs = this.seen.get(run) ?? new Map<string, { reason: string; asked: number }>();
    this.seen.set(run, runs.set(key, { reason: err.message, asked: 1 }));
    this.event(run, lane, url, err.message, 1);
    return { refused: `${err.message}. Asking again gives the same answer. ${ELSEWHERE}` };
  }

  private event(run: string, lane: string | null, url: string, reason: string, asked: number) {
    this.ledger.appendEvent(lane ?? "research", "fetch_refused", run, {
      url: url.slice(0, 500),
      reason,
      ...(asked > 1 ? { asked } : {}),
    });
  }
}
