import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Fetcher, htmlToText, moreText, READ_MAX } from "../../../agents/tools/index.ts";
import { KB_BODY_MAX } from "../../../core/kb-index.ts";
import { LedgerError, type SourceRow } from "../../ledger/index.ts";
import { clip, type ResearchContext, sourceText } from "./context.ts";

/** A run's archived sources: fetched and archived, read, searched, and the links to follow. */

/** The start of a fetched page's text that fetch answers with (read_source reads the rest). */
const VIEW_CHARS = 6000;
/** The links a fetch answers with, in characters, beside the text, within OUTPUT_MAX. */
const VIEW_LINKS_CHARS = 5000;
/** One page of search_corpus: at most this many matches, and this many characters of them. */
const SEARCH_PAGE = 30;
const SEARCH_CHARS = 11_000;

/** A URL as the archive stores it (parsed, without its fragment); undefined when it is not one. */
export function archiveUrl(s: string): string | undefined {
  try {
    const u = new URL(s);
    u.hash = "";
    return u.toString();
  } catch {
    return undefined;
  }
}

/** The run's fetcher, with its contract's fetch policy and scope, made at its first fetch. */
function fetcher(ctx: ResearchContext, run: string): Fetcher {
  let f = ctx.fetchers.get(run);
  if (!f) {
    // A research contract's fetch policy and scope; another run's are the policy's defaults
    // (robots.txt respected, a polite rate per domain, a size bound per page), no scope.
    const inst = ctx.ledger.runs.get(run);
    const c = inst ? ctx.ledger.contracts.get(inst.campaign, inst.version) : undefined;
    const policy =
      c?.mode === "research"
        ? c.fetch_policy
        : { respect_robots: true, per_domain_per_minute: 6, max_bytes: 5_000_000 };
    const scope = c?.mode === "research" ? c.scope : { include_domains: [], exclude_domains: [] };
    f = new Fetcher(
      {
        respectRobots: policy.respect_robots,
        perDomainPerMinute: policy.per_domain_per_minute,
        maxBytes: policy.max_bytes,
        includeDomains: scope.include_domains,
        excludeDomains: scope.exclude_domains,
        allowPrivate: ctx.allowPrivate,
      },
      join(ctx.stateDir, "research", run),
    );
    ctx.fetchers.set(run, f);
  }
  return f;
}

/**
 * A URL fetched and archived for the run, answered as its worker sees it (view). A URL archived
 * before, or a page whose text is archived already, is not archived again; a lasting refusal is
 * said again at once.
 */
export async function fetchSource(
  ctx: ResearchContext,
  run: string,
  lane: string | null,
  url: string,
) {
  // Look up the URL in the form it is stored in (no fragment, normalized by URL); not a URL:
  // the fetcher refuses it below.
  const key = archiveUrl(url) ?? url;
  const existing = ctx.ledger.sources.atUrl(run, key);
  if (existing) return view(existing, "already archived");
  const again = ctx.refusals.again(run, lane, url, key);
  if (again) return again;
  const used = ctx.ledger.sources.bytes(run);
  if (used >= ctx.maxCorpusBytes) {
    return { refused: `the corpus is full (${Math.round(used / 1024 ** 2)} MiB archived)` };
  }
  let f: Awaited<ReturnType<Fetcher["fetch"]>>;
  try {
    f = await fetcher(ctx, run).fetch(url);
  } catch (err) {
    return ctx.refusals.refuse(run, lane, url, key, err);
  }
  const same = ctx.ledger.sources.withContent(run, f.sha256);
  if (same) return view(same, "the same content is already archived under this id", f.links);
  const id = `s-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  ctx.ledger.tx(() => {
    ctx.ledger.sources.add({
      id,
      run,
      url: f.url,
      finalUrl: f.finalUrl,
      domain: f.domain,
      status: f.status,
      contentType: f.contentType,
      bytes: f.bytes,
      sha256: f.sha256,
      title: f.title,
      rawPath: f.rawPath,
      textPath: f.textPath,
      by: lane ?? "research",
    });
    // Its address, its title and the text that was read (cut to an item's length), so the
    // campaign's collection in the knowledge base holds the source itself, from events alone.
    ctx.ledger.appendEvent(lane ?? "research", "source_fetched", run, {
      source: id,
      domain: f.domain,
      status: f.status,
      bytes: f.bytes,
      url: clip(f.url, 2000),
      title: f.title ? clip(f.title, 500) : null,
      text: clip(f.text, KB_BODY_MAX),
    });
  });
  const row = ctx.ledger.sources.get(run, id) as SourceRow;
  ctx.changed(run);
  return view(row, undefined, f.links);
}

/**
 * A fetched page as its worker sees it: the start of its text, with where to read on when there
 * is more, and the links found on it, as many as fit beside the text (goal 117: nothing is cut
 * without a word; the links left out are said, and the frontier keeps them).
 */
function view(source: SourceRow, note?: string, links: string[] = []) {
  const text = sourceText(source);
  const id = source.id;
  const shown: string[] = [];
  let size = 0;
  for (const l of links.slice(0, 60)) {
    if (size + l.length + 3 > VIEW_LINKS_CHARS) break;
    shown.push(l);
    size += l.length + 3;
  }
  const part = text.slice(0, VIEW_CHARS);
  return {
    source: id,
    url: source.url,
    title: source.title,
    status: source.http_status,
    ...(note ? { note } : {}),
    chars: text.length,
    offset: 0,
    text: part,
    ...moreText({ source: id }, part.length, text.length),
    links: shown,
    ...(links.length > shown.length
      ? {
          links_not_shown: links.length - shown.length,
          links_note: `${links.length - shown.length} more of the page's links are not shown, to fit this answer`,
        }
      : {}),
  };
}

/**
 * Part of an archived source's text, from an offset: at most READ_MAX characters, so that the
 * answer fits a tool's answer whole, with `next_offset` and where to read on when more is left.
 */
export function readSource(
  ctx: ResearchContext,
  run: string,
  source: string,
  offset = 0,
  length = VIEW_CHARS,
) {
  const s = ctx.ledger.sources.get(run, source);
  if (!s) throw new LedgerError("not_found", `no source ${source} in this run`);
  const text = sourceText(s);
  const from = Math.max(0, Math.min(text.length, Math.trunc(Number(offset) || 0)));
  const asked = Math.trunc(Number(length) || VIEW_CHARS);
  const part = text.slice(from, from + Math.max(1, Math.min(asked, READ_MAX)));
  return {
    source,
    url: s.url,
    chars: text.length,
    offset: from,
    text: part,
    ...moreText({ source }, from + part.length, text.length),
    ...(asked > READ_MAX ? { note: `a read gives at most ${READ_MAX} characters` } : {}),
    ...(from >= text.length && text.length > 0
      ? { note: `offset ${from} is at the end: the text has ${text.length} characters` }
      : {}),
  };
}

/**
 * Case-insensitive plain-text search over the archived texts (no regular expressions), a page
 * at a time: up to 30 matches, and fewer when their excerpts would not fit a tool's answer;
 * `next_skip` gives the next page (goal 117: a page that stops says so).
 */
export function searchCorpus(ctx: ResearchContext, run: string, text: string, skip = 0) {
  const needle = text.trim().toLowerCase().slice(0, 200);
  if (needle.length < 2) return { matches: [] };
  const from = Math.max(0, Math.trunc(Number(skip) || 0));
  const out: { source: string; url: string; excerpt: string }[] = [];
  let seen = 0;
  let size = 0;
  let more = false;
  for (const s of ctx.ledger.sources.list(run)) {
    const body = sourceText(s);
    const at = body.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    if (seen++ < from) continue;
    const m = {
      source: s.id,
      url: s.url,
      excerpt: body.slice(Math.max(0, at - 200), at + 300),
    };
    const len = JSON.stringify(m).length;
    if (out.length >= SEARCH_PAGE || (out.length > 0 && size + len > SEARCH_CHARS)) {
      more = true;
      break;
    }
    out.push(m);
    size += len;
  }
  return {
    matches: out,
    ...(from ? { skip: from } : {}),
    ...(more
      ? {
          next_skip: from + out.length,
          more: `more sources match: search_corpus again with skip ${from + out.length} for the next page`,
        }
      : {}),
  };
}

/**
 * Links from archived sources that are not archived yet: where to go next without search.
 * Site boilerplate (a link found on two or more archived pages of the same site, such as
 * navigation) is left out, links are taken in turn from each source rather than all from one,
 * and links with query strings come last (they are usually actions, not documents).
 */
export function frontier(ctx: ResearchContext, run: string, limit = 40): string[] {
  const have = new Set(ctx.ledger.sources.ofRun(run).map((r) => r.url));
  const perSource: { domain: string; links: string[] }[] = [];
  for (const s of ctx.ledger.sources.newest(run, 30)) {
    let hrefs: string[] = [];
    try {
      // Links were saved at fetch time; older archives are parsed once more (linear time).
      const saved = join(s.raw_path, "..", `${s.sha256}.links.json`);
      hrefs = existsSync(saved)
        ? (JSON.parse(readFileSync(saved, "utf8")) as string[])
        : htmlToText(readFileSync(s.raw_path, "utf8")).links;
    } catch {
      continue;
    }
    const links: string[] = [];
    for (const href of hrefs) {
      try {
        const x = new URL(href, s.final_url);
        x.hash = "";
        if (x.protocol.startsWith("http") && !links.includes(x.toString()))
          links.push(x.toString());
      } catch {
        // not a URL
      }
    }
    perSource.push({ domain: s.domain, links });
  }
  // Boilerplate: links that more than one archived page of the same site carries.
  const seen = new Map<string, number>();
  for (const p of perSource)
    for (const l of p.links) seen.set(`${p.domain} ${l}`, (seen.get(`${p.domain} ${l}`) ?? 0) + 1);
  const candidates = perSource.map((p) =>
    p.links.filter((l) => !have.has(l) && (seen.get(`${p.domain} ${l}`) ?? 0) < 2),
  );
  const plain: string[] = [];
  const query: string[] = [];
  for (let i = 0; plain.length + query.length < limit * 4; i++) {
    let any = false;
    for (const list of candidates) {
      const l = list[i];
      if (l === undefined) continue;
      any = true;
      const bucket = new URL(l).search ? query : plain;
      if (!plain.includes(l) && !query.includes(l)) bucket.push(l);
    }
    if (!any) break;
  }
  return [...plain, ...query].slice(0, limit);
}
