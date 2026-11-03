import { join } from "node:path";
import { Fetcher, FetchRefused } from "../../agents/tools/index.ts";

/**
 * A guarded web fetch for advisors (no private addresses), archived in the supervisor's home,
 * limited to the listed domains unless the list is "*".
 */
export function advisorFetcher(home: string, domains: string[]): (url: string) => Promise<unknown> {
  const f = new Fetcher(
    {
      respectRobots: true,
      perDomainPerMinute: 6,
      maxBytes: 2_000_000,
      includeDomains: domains.includes("*") ? [] : domains,
      excludeDomains: [],
    },
    join(home, "advisor-fetches"),
  );
  return async (url) => {
    try {
      const r = await f.fetch(url);
      return {
        url: r.finalUrl,
        title: r.title,
        text: r.text.slice(0, 20_000),
        links: r.links.slice(0, 40),
      };
    } catch (err) {
      return {
        refused: err instanceof FetchRefused ? err.message : `fetch failed: ${String(err)}`,
      };
    }
  };
}
