/**
 * Markdown as HTML, for a campaign's brief (goal 078): its page shows the additional information
 * with this, and New campaign's preview runs the same function in the browser (MD_CORE_JS), so
 * what the owner sees as they type is what the page shows.
 *
 * Everything is escaped first; only these come back as markup: headings (as h3 to h6, under the
 * page's own), paragraphs with their line breaks, lists (- * + and 1.), quotes (>), fenced code,
 * rules (---), `code`, **bold**, *italic* or _italic_, and links to http and https addresses,
 * written [text](address) or bare. No HTML passes through, and no other kind of link.
 *
 * The function is whole in itself (no outer names), because the browser gets its source.
 */
export function mdHtml(text: string): string {
  const esc = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  // Inline marks. Code spans and links are kept aside first, so nothing inside them changes.
  const inline = (raw: string): string => {
    const kept: string[] = [];
    const keep = (html: string) => `\uE000${kept.push(html) - 1}\uE000`;
    let s = raw.replace(/`([^`\n]+)`/g, (_m, c: string) => keep(`<code>${esc(c)}</code>`));
    s = s.replace(
      /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"]/g,
      (m: string, label?: string, url?: string) =>
        keep(
          `<a href="${esc(url ?? m)}" rel="noopener noreferrer" target="_blank">${esc(label ?? m)}</a>`,
        ),
    );
    s = esc(s)
      .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
      .replace(/__([^_\n]+)__/g, "<b>$1</b>")
      .replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, "$1<i>$2</i>")
      .replace(/(^|[^\w_])_([^_\n]+)_(?![\w_])/g, "$1<i>$2</i>");
    return s.replace(/\uE000(\d+)\uE000/g, (_m, i: string) => kept[Number(i)] ?? "");
  };
  const listItem = /^\s*(?:[-*+]|\d+[.)])\s+/;
  const fence = /^\s*```/;
  const lines = text
    .replace(/\uE000/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const out: string[] = [];
  let i = 0;
  const at = (n: number) => lines[n] ?? "";
  while (i < lines.length) {
    const line = at(i);
    if (fence.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !fence.test(at(i))) body.push(at(i++));
      i++;
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const n = Math.min(6, (h[1] ?? "#").length + 2);
      out.push(`<h${n}>${inline(h[2] ?? "")}</h${n}>`);
      i++;
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(at(i))) body.push(at(i++).replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${mdHtml(body.join("\n"))}</blockquote>`);
      continue;
    }
    if (listItem.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      // An item's further lines are indented under it; a list of the other kind starts anew.
      const same = (l: string) => listItem.test(l) && /^\s*\d/.test(l) === ordered;
      while (i < lines.length && (same(at(i)) || (items.length && /^\s{2,}\S/.test(at(i))))) {
        if (listItem.test(at(i))) items.push(at(i).replace(listItem, ""));
        else items[items.length - 1] += `\n${at(i).trim()}`;
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(
        `<${tag}>${items.map((x) => `<li>${x.split("\n").map(inline).join("<br>")}</li>`).join("")}</${tag}>`,
      );
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      at(i).trim() &&
      !fence.test(at(i)) &&
      !/^#{1,6}\s/.test(at(i)) &&
      !/^\s*>/.test(at(i)) &&
      !listItem.test(at(i))
    )
      para.push(at(i++));
    if (!para.length) para.push(at(i++));
    out.push(`<p>${para.map(inline).join("<br>")}</p>`);
  }
  return out.join("");
}

/** mdHtml for the browser: the same source, so the preview is what the page shows. */
export const MD_CORE_JS = `const mdHtml = (${mdHtml.toString()});`;
