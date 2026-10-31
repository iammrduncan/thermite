/**
 * A web page's text, as control's text extractor reads it (main.ts): its words only, with no
 * markup, scripts or styles. A tag ends where a browser ends it: a quoted value may hold `>`, and a
 * script or a style runs to its first closing tag, quotes or not. What is left is text: an entity
 * such as `&lt;` becomes the character it names, and is never read as markup again.
 */

/** A tag's name and attributes, quoted values and all, up to the `>` that ends it. */
const ATTRS = `(?:[^>"']|"[^"]*"|'[^']*')*`;
/**
 * What is never text, in one pass from the start, so whichever begins first wins, as in a browser:
 * comments, CDATA sections, declarations and processing instructions, and the elements dropped
 * with everything in them (code, styles, and what a page never shows as text).
 */
const NOT_TEXT = new RegExp(
  [
    "<!--[\\s\\S]*?(?:-->|$)",
    `<(script|style|template|svg|math)\\b${ATTRS}>[\\s\\S]*?(?:<\\/\\1\\s*>|$)`,
    "<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>|$)",
    "<[!?][^>]*>",
  ].join("|"),
  "gi",
);
/** Tags that end a line of text. */
const BREAKS = new RegExp(
  `<\\/?(?:br|p|div|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|nav|blockquote|pre|hr|dt|dd|title)\\b${ATTRS}>`,
  "gi",
);
/** Any other tag, with its attributes, quoted values and all. */
const TAGS = new RegExp(`<\\/?[a-zA-Z][^\\s/>]*${ATTRS}>`, "g");

/** The named entities pages use most; any other stays as it is written. */
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  times: "×",
  euro: "€",
  pound: "£",
};

/** A code point an entity names, or the entity as written when it names none. */
function codePoint(n: number, written: string): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
    ? String.fromCodePoint(n)
    : written;
}

/** Entities as the characters they name. */
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (all, e: string) => {
    if (e[0] !== "#") return NAMED[e.toLowerCase()] ?? all;
    return codePoint(
      e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)),
      all,
    );
  });
}

/** A page's text: its words, a line for each block, with no markup. */
export function htmlText(html: string): string {
  const text = html.replace(NOT_TEXT, " ").replace(BREAKS, "\n").replace(TAGS, " ");
  return decode(text)
    .replace(/[ \t\f\v\r\u00a0]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
