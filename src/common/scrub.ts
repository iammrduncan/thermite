/**
 * Thermite's scrubber (goal 175): what could be a credential, blanked out of a text before it
 * leaves a part. Two halves. The values this process gave an agent (a trial's credential, a
 * call's, a program's password), each replaced exactly wherever it is: as it was given, split
 * across lines or by JSON's escapes, or in base64. Then anything shaped like a key, a token or a
 * password (withoutCredentials), which the log applies to every line too (log.ts). Each is
 * replaced by `***`. It guards against what an agent printed or echoed, not against anything a
 * text could hold.
 */

/** What a value or a credential is replaced by. */
const BLANKED = "***";

// ---------------------------------------------------------------- values given to agents

/** How many given values the process remembers, the newest: an older one is forgotten. */
const GIVEN_MAX = 1_000;
/** A value shorter than this is not a credential the harness made, and is not looked for. */
const GIVEN_MIN = 12;

/** The values this process gave agents, oldest first (a Map keeps the order they came in). */
const given = new Map<string, true>();

/**
 * Remembers a value this process gives an agent, in its environment, its files or its input: a
 * kept conversation is scrubbed of it (scrubSecrets). Call it where the value is made.
 */
export function gaveSecret(value: string): void {
  if (value.length < GIVEN_MIN) return;
  given.delete(value);
  given.set(value, true);
  while (given.size > GIVEN_MAX) given.delete(given.keys().next().value as string);
}

/** The values remembered, newest first. */
export const givenSecrets = (): string[] => [...given.keys()].reverse();

/**
 * Between two characters of a value split across lines: whitespace, or a line break as JSON and
 * shells escape it (`\n`, `\r`, `\t`, a backslash before a line's end).
 */
const GAP = /^(?:\s|\\[nrt]|\\\r?\n)+/;
/** How many characters key the search: each needle's first ones (values are longer). */
const KEY = 8;
/** How many characters of a value anchor the search for it split: each of three parts. */
const ANCHOR = 10;

/** Where `value` is in `text` from `start`, with gaps between its characters: its end, or -1. */
function matchSplit(text: string, start: number, value: string): number {
  let at = start;
  for (let i = 0; i < value.length; i++) {
    if (i > 0) {
      const gap = GAP.exec(text.slice(at, at + 16));
      if (gap) at += gap[0].length;
    }
    if (text[at] !== value[i]) return -1;
    at++;
  }
  return at;
}

/**
 * The value's base64 as it shows inside a longer base64 text, at each of the three places a byte
 * can start: the characters that only its own bytes make, in the standard and the URL alphabet.
 */
function base64Cores(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const out = new Set<string>();
  for (let k = 0; k < 3; k++) {
    const b64 = Buffer.concat([Buffer.alloc(k), bytes]).toString("base64");
    const from = Math.ceil((8 * k) / 6);
    const to = Math.floor((8 * (k + bytes.length) - 6) / 6) + 1;
    const core = b64.slice(from, to);
    if (core.length >= GIVEN_MIN) {
      out.add(core);
      out.add(core.replaceAll("+", "-").replaceAll("/", "_"));
    }
  }
  return [...out];
}

/**
 * What the one pass looks for: a value or its base64 whole, or `ANCHOR` characters of a value
 * from `at` in it (its start, its middle, its end), for the value split by up to two gaps.
 */
interface Needle {
  how: "whole" | "part";
  /** What starts at the place found. */
  text: string;
  value: string;
  /** Where `text` is in the value: 0 for a whole one. */
  at: number;
}

/**
 * A text with each of the values blanked out: as given, split across lines, and in base64. One
 * pass over the text, whatever how many values: each place is looked up by its next KEY
 * characters among the needles' first ones.
 */
function withoutValues(text: string, values: readonly string[]): string {
  const needles = new Map<string, Needle[]>();
  const add = (n: Needle) => {
    const key = n.text.slice(0, KEY);
    needles.set(key, [...(needles.get(key) ?? []), n]);
  };
  for (const value of values) {
    if (value.length < GIVEN_MIN) continue;
    add({ how: "whole", text: value, value, at: 0 });
    for (const core of base64Cores(value)) add({ how: "whole", text: core, value: core, at: 0 });
    // Three parts that don't overlap: with at most two gaps in the value, one is whole.
    if (value.length >= 3 * ANCHOR)
      for (const at of [0, Math.floor((value.length - ANCHOR) / 2), value.length - ANCHOR])
        add({ how: "part", text: value.slice(at, at + ANCHOR), value, at });
  }
  if (!needles.size) return text;
  const spans: [number, number][] = [];
  for (let i = 0; i + KEY <= text.length; i++) {
    const found = needles.get(text.slice(i, i + KEY));
    if (!found) continue;
    for (const n of found) {
      if (!text.startsWith(n.text, i)) continue;
      if (n.how === "whole") {
        spans.push([i, i + n.text.length]);
        continue;
      }
      // The value's start, found back from the part: gaps make it at most 16 characters a step further.
      for (let from = i; from >= Math.max(0, i - 17 * n.at); from--) {
        if (text[from] !== n.value[0]) continue;
        const end = matchSplit(text, from, n.value);
        if (end > i) {
          spans.push([from, end]);
          break;
        }
      }
    }
  }
  if (!spans.length) return text;
  // Overlapping spans are one: each is blanked out once.
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const parts: string[] = [];
  let at = 0;
  for (const [from, to] of spans) {
    if (to <= at) continue;
    parts.push(text.slice(at, Math.max(at, from)), BLANKED);
    at = to;
  }
  parts.push(text.slice(at));
  return parts.join("");
}

// ---------------------------------------------------------------- shapes of credentials

/** Names whose value is a credential, at the end of a variable's or a field's name. */
const SECRET_NAME = "(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|AUTH|CREDENTIALS?)";

/**
 * A text with what is shaped like a credential taken out: a URL's user and password, a bearer or
 * basic credential, keys with a known prefix (`sk-`, `ghp_`, `AKIA`, …), a credential Thermite
 * makes (`trial.<hex>`, `proxy.…`, `mcp.…`, `call.…`), a NATS key's seed, a JSON web token, a
 * private key's block, the value of a variable whose name ends in KEY, TOKEN, SECRET, PASSWORD,
 * AUTH or CREDENTIALS (`NAME=value`, or `"NAME": "value"` in JSON; for Thermite's and RunPod's,
 * also CODE and PREFIX), a query string's or a form's token, key, secret, password, signature or
 * code, a JSON field so named, and a credential header (`x-api-key: …`, `authorization: …`,
 * `cookie: …`).
 */
export function withoutCredentials(text: string): string {
  return text
    .replace(/(\/\/)[^/\s@]+@/g, "$1***@")
    .replace(/\b(Bearer\s+)\S+/gi, "$1***")
    .replace(/\b(Basic\s+)[A-Za-z0-9+/]{8,}={0,2}/g, "$1***")
    .replace(
      /\b(sk-|rpa_|ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|hf_|xox[abps]-|npm_|pypi-)[A-Za-z0-9_-]{6,}/g,
      "$1***",
    )
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA***")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}/g, "AIza***")
    .replace(/\b(trial|proxy|mcp|call)\.[0-9a-f]{40,}/g, "$1.***")
    .replace(/\bS[UACNOPX][A-Z2-7]{56}\b/g, "S***")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "***")
    .replace(
      /(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g,
      "$1***$2",
    )
    .replace(
      new RegExp(
        `\\b((?:[A-Z][A-Z0-9_]*${SECRET_NAME}|(?:THERMITE|RUNPOD)_[A-Z0-9_]*(?:CODE|PREFIX))(?:=\\\\?["']?|\\\\?["']\\s*:\\s*\\\\?["']))[^\\s"'\\\\,;}&]+`,
        "g",
      ),
      "$1***",
    )
    .replace(
      /\b([a-z0-9_-]*(?:token|api[_-]?key|apikey|secret|password|passwd|signature)=)[^\s&"'#,;}]+/gi,
      "$1***",
    )
    .replace(/([?&](?:code|sig|key)=)[^\s&"'#,;}]+/gi, "$1***")
    .replace(
      /("[a-z0-9_-]*(?:token|api[_-]?key|apikey|secret|password|passwd|credentials?)"\s*:\s*")[^"\\]+/gi,
      "$1***",
    )
    .replace(
      /\b((?:x-)?api-key|x-[a-z-]*token|private-token|(?:proxy-)?authorization|cookie)(["']?\s*:\s*["']?)(?:(?:bearer|basic|token)\s+)?[^\s,;"'}]+/gi,
      "$1$2***",
    );
}

/**
 * A text scrubbed of credentials before it leaves a part: each value given to an agent blanked
 * out exactly (givenSecrets, by default those this process gave), then each shape of one.
 */
export function scrubSecrets(text: string, values: readonly string[] = givenSecrets()): string {
  return withoutCredentials(withoutValues(text, values));
}
