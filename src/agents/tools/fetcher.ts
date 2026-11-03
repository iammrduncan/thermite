import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import { mkdirSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { join } from "node:path";

/**
 * The harness's own fetcher for research campaigns. Agents never fetch anything themselves: they
 * ask, and this code checks the URL, the robots.txt rules, the per-domain rate and the size cap,
 * archives the raw response and its extracted text under their hash, and returns the text.
 * Fetched pages are untrusted data; they can produce bad notes, never actions.
 *
 * Addresses are checked when the connection is made, on the address actually used, so a name
 * that resolves differently the second time (DNS rebinding) cannot reach a private address.
 */

export interface FetchPolicy {
  respectRobots: boolean;
  perDomainPerMinute: number;
  maxBytes: number;
  includeDomains: string[];
  excludeDomains: string[];
  /** Tests only: allow loopback and private addresses. */
  allowPrivate?: boolean | undefined;
}

export interface Fetched {
  url: string;
  finalUrl: string;
  domain: string;
  status: number;
  contentType: string | null;
  bytes: number;
  sha256: string;
  title: string | null;
  text: string;
  links: string[];
  rawPath: string;
  textPath: string;
}

export class FetchRefused extends Error {}

/** The answers that can pass: a timeout, too many requests, a server's own failure. */
const PASSING = (status: number) => status === 408 || status === 429 || status >= 500;

/**
 * An answer that is not a 2xx is never archived (goal 162): an error page is not a source, and a
 * claim that quotes one must not pass. A 404, a 410 or another 4xx is refused for good (the run
 * gets the same answer at once if it asks again); a 408, a 429 or a 5xx is a failure that can
 * pass, so the next ask fetches again.
 */
export function statusRefusal(status: number): void {
  if (status >= 200 && status < 300) return;
  const words = `the site answered HTTP ${status}: an error page is not a source`;
  if (PASSING(status)) throw new Error(`${words}; it may pass, so a later ask fetches it again`);
  throw new FetchRefused(words);
}

const USER_AGENT = "thermite-research/1.0";

function v4Bytes(ip: string): number[] {
  return ip.split(".").map(Number);
}

/** An IPv6 address as 16 bytes (handles `::` and a trailing dotted IPv4 part). */
function v6Bytes(ip: string): number[] {
  let s = ip.toLowerCase();
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  if (s.slice(lastColon + 1).includes(".")) {
    tail = v4Bytes(s.slice(lastColon + 1));
    s = `${s.slice(0, lastColon + 1)}0:0`;
  }
  const [head, rest] = s.split("::") as [string, string | undefined];
  const parse = (x: string) => (x ? x.split(":").map((h) => Number.parseInt(h || "0", 16)) : []);
  const a = parse(head);
  const b = rest === undefined ? [] : parse(rest);
  const groups = rest === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill(0), ...b];
  const bytes = groups.flatMap((g) => [(g >> 8) & 0xff, g & 0xff]);
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes;
}

function inV4(b: number[], net: [number, number, number, number], bits: number): boolean {
  for (let i = 0; i < 4; i++) {
    const take = Math.max(0, Math.min(8, bits - i * 8));
    if (take === 0) return true;
    const mask = (0xff << (8 - take)) & 0xff;
    if (((b[i] as number) & mask) !== ((net[i] as number) & mask)) return false;
  }
  return true;
}

const V4_BLOCKED: [[number, number, number, number], number][] = [
  [[0, 0, 0, 0], 8], // "this" network
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10], // carrier-grade NAT
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16], // link-local (cloud metadata)
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2, 0], 24], // documentation
  [[192, 88, 99, 0], 24], // 6to4 relay anycast
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15], // benchmarking
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved and broadcast
];

/** True for any address the fetcher must not reach: loopback, private, link-local, special. */
export function blockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const b = v4Bytes(ip);
    return V4_BLOCKED.some(([net, bits]) => inV4(b, net, bits));
  }
  if (kind !== 6) return true;
  const b = v6Bytes(ip);
  if (b.length !== 16) return true;
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  // ::/128, ::1, IPv4-compatible and IPv4-mapped: refuse (embedded IPv4 is never needed here).
  if (zero(0, 10) && ((b[10] === 0 && b[11] === 0) || (b[10] === 0xff && b[11] === 0xff)))
    return true;
  const w0 = ((b[0] as number) << 8) | (b[1] as number);
  const w1 = ((b[2] as number) << 8) | (b[3] as number);
  if (w0 === 0x64 && w1 === 0xff9b) return true; // NAT64 64:ff9b::/96 and 64:ff9b:1::/48
  if (w0 === 0x100 && zero(2, 8)) return true; // discard-only 100::/64
  if (w0 === 0x2001 && w1 < 0x200) return true; // Teredo, benchmarking, ORCHID and others
  if (w0 === 0x2001 && w1 === 0xdb8) return true; // documentation
  if (w0 === 0x2002) return true; // 6to4
  if ((w0 & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((w0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((w0 & 0xffc0) === 0xfec0) return true; // site-local fec0::/10
  if ((w0 & 0xff00) === 0xff00) return true; // multicast
  return (w0 & 0xe000) !== 0x2000; // only global unicast 2000::/3 remains
}

function domainMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Public suffixes of more than one label: under each, a registrable domain has one label more
 * (example.co.uk, someone.github.io). A small table kept in code, from the Public Suffix List
 * (publicsuffix.org), with no dependency: the country second-level domains research cites most,
 * and hosting services where each name under the suffix is another owner. A suffix of one label
 * (com, org, de) needs no entry: the registrable domain is then the last two labels. A host under
 * a suffix missing here counts as its last two labels, so two owners under it count as one: a
 * miss can only make corroboration stricter, never looser.
 */
const MULTI_LABEL_SUFFIXES = new Set(
  [
    // United Kingdom
    "co.uk ac.uk gov.uk org.uk me.uk ltd.uk plc.uk net.uk sch.uk nhs.uk police.uk",
    // Australia and New Zealand
    "com.au net.au org.au edu.au gov.au asn.au id.au",
    "co.nz ac.nz govt.nz org.nz net.nz",
    // Japan, Korea, China, Taiwan, Hong Kong, Singapore, India
    "co.jp ac.jp go.jp or.jp ne.jp gr.jp ed.jp lg.jp",
    "co.kr ac.kr go.kr or.kr re.kr",
    "com.cn edu.cn gov.cn org.cn net.cn ac.cn",
    "com.tw edu.tw gov.tw org.tw",
    "com.hk edu.hk gov.hk org.hk",
    "com.sg edu.sg gov.sg org.sg",
    "co.in ac.in gov.in org.in net.in edu.in res.in",
    // The Americas, Africa, the Middle East and Europe
    "com.br gov.br org.br edu.br net.br",
    "com.mx gob.mx edu.mx org.mx com.ar gob.ar",
    "co.za ac.za gov.za org.za",
    "co.il ac.il gov.il org.il",
    "com.tr edu.tr gov.tr",
    "co.at ac.at gv.at or.at com.pl edu.pl gov.pl com.es org.es gob.es",
    // Hosting services: each name under one is its own site
    "github.io gitlab.io readthedocs.io pages.dev workers.dev netlify.app",
    "vercel.app web.app firebaseapp.com herokuapp.com appspot.com blogspot.com",
    "wordpress.com substack.com azurewebsites.net cloudfront.net s3.amazonaws.com",
  ].flatMap((line) => line.split(" ")),
);

/**
 * A host's registrable domain: the part one owner registers, which corroboration counts (goal
 * 117). docs.example.com and blog.example.com are one, example.com; www.example.co.uk is
 * example.co.uk; alice.github.io and bob.github.io are two. An address (IPv4 or IPv6) or a host of
 * one label stays as it is.
 */
export function registrableDomain(host: string): string {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "")
    .replace(/^\[|\]$/g, "");
  if (!h || h.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return h;
  const labels = h.split(".");
  if (labels.length < 2) return h;
  // The longest suffix in the table that ends the host, then one label more.
  for (let k = Math.min(labels.length, 3); k >= 2; k--) {
    const suffix = labels.slice(-k).join(".");
    if (MULTI_LABEL_SUFFIXES.has(suffix))
      return labels.length > k ? labels.slice(-(k + 1)).join(".") : suffix;
  }
  return labels.slice(-2).join(".");
}

const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,8}|#\d{1,9}|[a-z]{2,6});/gi, (all, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isInteger(n) && n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff)
        ? String.fromCodePoint(n)
        : "�";
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

/** Folds spaces and tabs, trims lines and keeps at most one empty line between paragraphs. */
function foldWhitespace(s: string): string {
  const out: string[] = [];
  let blank = 0;
  for (const raw of s.split("\n")) {
    const line = raw.replace(/[ \t\f\v\r ]+/g, " ").trim();
    if (!line) {
      blank++;
      continue;
    }
    if (out.length && blank) out.push("");
    blank = 0;
    out.push(line);
  }
  return out.join("\n");
}

// Never page text: code, and a site's navigation and footer (a quote from them is boilerplate).
const SKIP = new Set(["script", "style", "noscript", "svg", "template", "nav", "footer"]);
const BLOCK = new Set([
  "br",
  "p",
  "div",
  "li",
  "tr",
  "section",
  "article",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "pre",
  "blockquote",
  "table",
  "ul",
  "ol",
]);

/**
 * Text from HTML in one linear pass (no backtracking regular expressions over the page):
 * scripts, styles, navigation and footers dropped, tags removed, entities decoded, whitespace
 * folded.
 */
export function htmlToText(html: string): { title: string | null; text: string; links: string[] } {
  const lower = html.toLowerCase();
  const n = html.length;
  const out: string[] = [];
  const links: string[] = [];
  let title: string | null = null;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0) break; // an unterminated tag: the rest is not text
    const closing = html[lt + 1] === "/";
    let j = lt + (closing ? 2 : 1);
    while (j < gt && /[a-zA-Z0-9]/.test(html[j] as string)) j++;
    const name = lower.slice(lt + (closing ? 2 : 1), j);
    i = gt + 1;
    if (!closing && SKIP.has(name)) {
      const end = lower.indexOf(`</${name}`, i);
      const close = end < 0 ? -1 : html.indexOf(">", end);
      i = close < 0 ? n : close + 1;
      continue;
    }
    if (!closing && name === "title" && title === null) {
      const end = lower.indexOf("</title", i);
      title = foldWhitespace(decodeEntities(html.slice(i, end < 0 ? n : end))) || null;
      i = end < 0 ? n : end;
      continue;
    }
    if (!closing && name === "a" && links.length < 1000) {
      const attrs = html.slice(j, gt);
      const m = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
      const href = m?.[1] ?? m?.[2] ?? m?.[3];
      if (href) links.push(decodeEntities(href));
    }
    out.push(BLOCK.has(name) ? "\n" : " ");
  }
  return { title, text: foldWhitespace(decodeEntities(out.join(""))), links };
}

/** Resolves a name, refusing it if any of its addresses is private (checked at connect time). */
function safeLookup(allowPrivate: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { all: true, family: options.family ?? 0 }, (err, addresses) => {
      if (err) return callback(err, "", 0);
      const list = addresses as { address: string; family: number }[];
      if (!list.length || (!allowPrivate && list.some((a) => blockedAddress(a.address)))) {
        const e = new FetchRefused(`refusing a private or local address for ${hostname}`);
        return callback(e as NodeJS.ErrnoException, "", 0);
      }
      if ((options as { all?: boolean }).all) {
        return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
      }
      const first = list[0] as { address: string; family: number };
      callback(null, first.address, first.family);
    });
  };
}

export class Fetcher {
  private readonly policy: FetchPolicy;
  private readonly archiveDir: string;
  private readonly robots = new Map<string, { disallow: string[]; allow: string[] }>();
  private readonly recent = new Map<string, number[]>();

  constructor(policy: FetchPolicy, archiveDir: string) {
    this.policy = policy;
    this.archiveDir = archiveDir;
    mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  }

  private checkScope(u: URL): void {
    if (u.protocol !== "http:" && u.protocol !== "https:")
      throw new FetchRefused(`only http and https: ${u.protocol}`);
    if (u.username || u.password) throw new FetchRefused("no credentials in URLs");
    const host = u.hostname.toLowerCase();
    if (this.policy.excludeDomains.some((d) => domainMatches(host, d)))
      throw new FetchRefused(`excluded domain ${host}`);
    if (
      this.policy.includeDomains.length &&
      !this.policy.includeDomains.some((d) => domainMatches(host, d))
    ) {
      throw new FetchRefused(`outside the campaign's domains: ${host}`);
    }
    const literal = host.replace(/^\[|\]$/g, "");
    if (isIP(literal) && !this.policy.allowPrivate && blockedAddress(literal))
      throw new FetchRefused(`refusing a private or local address for ${u.hostname}`);
  }

  private async rate(domain: string): Promise<void> {
    const windowMs = 60_000;
    for (;;) {
      const now = Date.now();
      const times = (this.recent.get(domain) ?? []).filter((t) => now - t < windowMs);
      if (times.length < this.policy.perDomainPerMinute) {
        times.push(now);
        this.recent.set(domain, times);
        return;
      }
      await new Promise((r) =>
        setTimeout(r, Math.max(50, windowMs - (now - (times[0] as number)))),
      );
    }
  }

  private async allowedByRobots(u: URL): Promise<boolean> {
    if (!this.policy.respectRobots) return true;
    const key = `${u.protocol}//${u.host}`;
    let rules = this.robots.get(key);
    if (!rules) {
      rules = { disallow: [], allow: [] };
      try {
        const r = await this.get(new URL("/robots.txt", key), 200_000, 0, false);
        if (r.status === 200) {
          let applies = false;
          for (const raw of r.body.toString("utf8").split("\n").slice(0, 5000)) {
            const line = raw.replace(/#.*/, "").trim();
            const [k, ...rest] = line.split(":");
            const v = rest.join(":").trim();
            if (/^user-agent$/i.test(k ?? "")) applies = v === "*" || /thermite/i.test(v);
            else if (applies && /^disallow$/i.test(k ?? "") && v) rules.disallow.push(v);
            else if (applies && /^allow$/i.test(k ?? "") && v) rules.allow.push(v);
          }
        }
      } catch {
        // unreachable robots.txt: no rules
      }
      this.robots.set(key, rules);
    }
    const path = u.pathname + u.search;
    const longest = (xs: string[]) =>
      Math.max(-1, ...xs.filter((p) => path.startsWith(p)).map((p) => p.length));
    return longest(rules.allow) >= longest(rules.disallow);
  }

  /** One HTTP request, with the address checked at connect time, a size cap and a timeout. */
  private request(
    u: URL,
    maxBytes: number,
  ): Promise<{ status: number; type: string | null; location: string | null; body: Buffer }> {
    const send = u.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const req = send(
        u,
        {
          method: "GET",
          headers: {
            "user-agent": USER_AGENT,
            accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5",
          },
          lookup: safeLookup(this.policy.allowPrivate === true),
          timeout: 30_000,
        },
        (res: IncomingMessage) => {
          const status = res.statusCode ?? 0;
          const location = typeof res.headers.location === "string" ? res.headers.location : null;
          const type = res.headers["content-type"] ?? null;
          if (status >= 300 && status < 400 && location) {
            res.resume();
            return resolve({ status, type, location, body: Buffer.alloc(0) });
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.byteLength;
            // Refused first, then closed: destroying with the error after the last chunk throws it
            // where nothing catches it, and lets "end" resolve a body cut short (goal 136).
            if (size > maxBytes) {
              reject(new FetchRefused(`larger than ${maxBytes} bytes`));
              req.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => resolve({ status, type, location, body: Buffer.concat(chunks) }));
          res.on("error", reject);
        },
      );
      const deadline = setTimeout(() => req.destroy(new Error("timed out after 30 s")), 30_000);
      req.on("timeout", () => req.destroy(new Error("timed out")));
      req.on("error", (err) => {
        clearTimeout(deadline);
        reject(err);
      });
      req.on("close", () => clearTimeout(deadline));
      req.end();
    });
  }

  /** A GET with manual redirects: every hop is checked for scope, robots.txt and rate. */
  private async get(
    u: URL,
    maxBytes: number,
    depth: number,
    checkRobots = true,
  ): Promise<{ url: URL; status: number; type: string | null; body: Buffer }> {
    this.checkScope(u);
    if (depth > 0 && checkRobots) {
      if (!(await this.allowedByRobots(u)))
        throw new FetchRefused(`robots.txt disallows ${u.pathname} (after a redirect)`);
      await this.rate(u.hostname);
    }
    const r = await this.request(u, maxBytes);
    if (r.location) {
      if (depth >= 5) throw new FetchRefused("too many redirects");
      const next = new URL(r.location, u);
      next.hash = "";
      return this.get(next, maxBytes, depth + 1, checkRobots);
    }
    return { url: u, status: r.status, type: r.type, body: r.body };
  }

  async fetch(url: string): Promise<Fetched> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new FetchRefused(`not a URL: ${url.slice(0, 200)}`);
    }
    u.hash = "";
    this.checkScope(u);
    if (!(await this.allowedByRobots(u)))
      throw new FetchRefused(`robots.txt disallows ${u.pathname}`);
    await this.rate(u.hostname);
    const r = await this.get(u, this.policy.maxBytes, 0);
    statusRefusal(r.status);
    const sha256 = createHash("sha256").update(r.body).digest("hex");
    const type = r.type?.split(";")[0]?.trim().toLowerCase() ?? null;
    const raw = r.body.toString("utf8");
    const parsed =
      type === "text/html" ||
      type === "application/xhtml+xml" ||
      (!type && /<html/i.test(raw.slice(0, 2000)))
        ? htmlToText(raw)
        : type?.startsWith("text/") || type === "application/json" || type === "application/xml"
          ? { title: null, text: raw, links: [] }
          : { title: null, text: "", links: [] };
    const links = [
      ...new Set(
        parsed.links
          .map((l) => {
            try {
              const x = new URL(l, r.url);
              x.hash = "";
              return x.protocol.startsWith("http") ? x.toString() : null;
            } catch {
              return null;
            }
          })
          .filter((l): l is string => l !== null),
      ),
    ].slice(0, 300);
    const rawPath = join(this.archiveDir, `${sha256}.raw`);
    const textPath = join(this.archiveDir, `${sha256}.txt`);
    writeFileSync(rawPath, r.body, { mode: 0o600 });
    writeFileSync(textPath, parsed.text, { mode: 0o600 });
    // The links are kept beside the text, so nothing has to parse the page again later.
    writeFileSync(join(this.archiveDir, `${sha256}.links.json`), JSON.stringify(links), {
      mode: 0o600,
    });
    return {
      url: u.toString(),
      finalUrl: r.url.toString(),
      domain: r.url.hostname,
      status: r.status,
      contentType: type,
      bytes: r.body.byteLength,
      sha256,
      title: parsed.title,
      text: parsed.text,
      links,
      rawPath,
      textPath,
    };
  }
}
