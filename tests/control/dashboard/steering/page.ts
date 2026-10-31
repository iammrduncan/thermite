import assert from "node:assert/strict";

/** Pages read as a browser reads them: a form's fields, Live's recipients and its stream. */

export type Form = { action: string; fields: Record<string, string> };

export const unesc = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? unesc(m[1] ?? "") : undefined;
};

/**
 * The first form after `near` whose button reads `button`: where it posts and the fields a browser
 * sends from it as drawn (hidden and visible inputs, ticked boxes, text areas, chosen options).
 */
export function form(html: string, button: string, near = ""): Form {
  const at = html.indexOf(near);
  assert.ok(at >= 0, `the page shows ${near}`);
  const f = (html.slice(at).match(/<form\b[\s\S]*?<\/form>/g) ?? []).find((x) =>
    x.includes(`${button}</button>`),
  );
  assert.ok(f, `a form with ${button} after ${near}`);
  const fields: Record<string, string> = {};
  for (const [tag] of f.matchAll(/<input\b[^>]*>/g)) {
    const name = attr(tag, "name");
    const type = attr(tag, "type") ?? "text";
    if (!name || ((type === "checkbox" || type === "radio") && !/\schecked\b/.test(tag))) continue;
    fields[name] = attr(tag, "value") ?? "";
  }
  for (const m of f.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
    const name = attr(m[1] ?? "", "name");
    if (name) fields[name] = unesc(m[2] ?? "");
  }
  for (const m of f.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const name = attr(m[1] ?? "", "name");
    const opts = [...(m[2] ?? "").matchAll(/<option\b([^>]*)>/g)].map((o) => o[1] ?? "");
    const chosen = opts.find((o) => /\sselected\b/.test(o)) ?? opts[0];
    if (name) fields[name] = chosen === undefined ? "" : (attr(chosen, "value") ?? "");
  }
  return { action: attr(f.slice(0, f.indexOf(">") + 1), "action") ?? "", fields };
}

/** Live's message box: its recipients in order, each with its hint and why it is greyed out. */
export function recipients(html: string) {
  const box = /<form class="lcomposer"[\s\S]*?<\/form>/.exec(html)?.[0] ?? "";
  return [...box.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)].map((m) => ({
    to: attr(m[1] ?? "", "value"),
    label: m[2],
    hint: attr(m[1] ?? "", "data-hint"),
    chosen: /\sselected\b/.test(m[1] ?? ""),
    greyed: /\sdisabled\b/.test(m[1] ?? "") ? attr(m[1] ?? "", "title") : undefined,
  }));
}

/** Live's stream: each line's filters (data-who) and its words, without markup. */
export function stream(html: string) {
  const from = html.indexOf('id="transcript"');
  // The stream ends where the notice or the message box starts.
  const box = html.lastIndexOf("<", html.indexOf('class="lcomposer', from));
  const notice = html.indexOf('<div class="lnotice">', from);
  const body = html.slice(from, notice > 0 ? notice : box);
  const at = [...body.matchAll(/<div [^>]*data-who="([^"]*)"/g)];
  return at.map((m, i) => ({
    who: (m[1] ?? "").split(" "),
    text: unesc(
      body
        .slice(m.index, at[i + 1]?.index ?? body.length)
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    ),
  }));
}

/** The Live lines the "You" filter shows: the owner's messages, their receipts and the answers. */
export const yours = (html: string) =>
  stream(html)
    .filter((l) => l.who.includes("you"))
    .map((l) => l.text.replace(/^\S+ /, ""));
