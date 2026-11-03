import type { MessagesPage, StreamMessage } from "../../system/index.ts";
import { esc } from "../components/index.ts";
import { streamHref } from "./bus.ts";
import { count, size, utc } from "./common.ts";
import { STREAM_WORDS } from "./words.ts";

/** How much of a message's data its page shows: past it, Download has the rest. */
const SHOWN_BYTES = 256 * 1024;

const pageHref = (p: MessagesPage, q: Record<string, string | number>) => {
  const params = new URLSearchParams();
  if (p.subject !== ">") params.set("subject", p.subject);
  for (const [k, v] of Object.entries(q)) params.set(k, String(v));
  const s = params.toString();
  return `${streamHref(p.stream)}${s ? `?${s}` : ""}`;
};

/** A stream's messages, newest first, with the subject filter and the pages before and after. */
export function streamPageBody(p: MessagesPage): string {
  const w = STREAM_WORDS[p.stream];
  const filter = `<form class="sys-filter" method="get" action="${streamHref(p.stream)}"><label>Subject <input name="subject" value="${esc(p.subject === ">" ? "" : p.subject)}" placeholder="all its subjects, or thermite.run.*.ev.trial_finished" maxlength="256"></label><label>Older than place <input name="before" inputmode="numeric" pattern="[0-9]*" placeholder="${count(p.last_seq + 1)}"></label><button class="btn sm" type="submit">Show</button>${p.subject !== ">" ? ` <a class="btn sm ghost" href="${streamHref(p.stream)}">All subjects</a>` : ""}</form>`;
  const nav = `<div class="sys-pager"><a class="btn sm" href="${pageHref(p, {})}">Newest</a>${p.newer !== null ? `<a class="btn sm" href="${pageHref(p, { after: p.newer })}">Newer</a>` : ""}${p.older !== null ? `<a class="btn sm" href="${pageHref(p, { before: p.older })}">Older</a>` : ""}<span class="muted small">last place ${count(p.last_seq)}</span></div>`;
  const rows = p.messages
    .map(
      (m) =>
        `<tr class="sys-click"><td class="num"><a href="${streamHref(p.stream)}/${m.seq}">${m.seq}</a></td><td><code class="sys-subj">${esc(m.subject)}</code></td><td class="small nowrap">${esc(utc(m.at))}</td><td class="num">${esc(size(m.bytes))}</td><td class="sys-preview">${m.preview === null ? `<span class="muted">bytes</span>` : `<code>${esc(m.preview)}</code>`}</td></tr>`,
    )
    .join("");
  const table = rows
    ? `<div class="card flat sys-msgs"><div class="utw"><table><thead><tr><th class="num">Place</th><th>Subject</th><th>Stored</th><th class="num">Size</th><th>Starts with</th></tr></thead><tbody>${rows}</tbody></table></div></div>`
    : `<div class="card"><div class="empty">${p.subject === ">" ? "The stream holds no message here." : "No message on that subject here."}</div></div>`;
  return `<div class="block">${w ? `<p class="muted">${esc(w.carries)}. Kept: ${esc(w.kept.toLowerCase())}.</p>` : ""}<p class="muted small">Read with the server's own lookup: nothing is made, handed, acked or removed, so reading here changes nothing for the rigs. The messages are what rigs and control sent.</p>${filter}</div>
${p.cut ? `<div class="card warn sys-note">${esc(p.cut)}</div>` : ""}${nav}${table}${p.messages.length > 8 ? nav : ""}`;
}

/** Data as the page shows it: JSON laid out, other text as text, bytes as hex. */
function dataView(m: StreamMessage, text: string | null): string {
  const shown = m.data.length > SHOWN_BYTES;
  const note = shown
    ? `<p class="muted small">The first ${esc(size(SHOWN_BYTES))} of ${esc(size(m.bytes))}; Download has it whole.</p>`
    : "";
  if (text !== null) {
    let body = text.slice(0, SHOWN_BYTES);
    try {
      if (!shown) body = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // Not JSON: shown as the text it is.
    }
    return `${note}<pre class="sys-data">${esc(body)}</pre>`;
  }
  const bytes = m.data.subarray(0, Math.min(m.data.length, 4096));
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const row = [...bytes.subarray(i, i + 16)];
    lines.push(
      `${i.toString(16).padStart(8, "0")}  ${row
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ")
        .padEnd(
          47,
        )}  ${row.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("")}`,
    );
  }
  return `<p class="muted small">Bytes, not text: the first ${esc(size(bytes.length))} of ${esc(size(m.bytes))} in hex. Download has it whole.</p><pre class="sys-data">${esc(lines.join("\n"))}</pre>`;
}

/** One message: its place, subject, time, size, every header, and its data. */
export function streamMessageBody(stream: string, m: StreamMessage, text: string | null): string {
  const headers = Object.entries(m.headers);
  const facts = `<dl class="facts"><dt>Place</dt><dd>${m.seq}</dd><dt>Subject</dt><dd><code>${esc(m.subject)}</code></dd><dt>Stored</dt><dd>${esc(utc(m.at))}</dd><dt>Size</dt><dd>${esc(size(m.bytes))}</dd></dl>`;
  const head = headers.length
    ? `<table><thead><tr><th>Header</th><th>Value</th></tr></thead><tbody>${headers.map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td><code>${esc(v)}</code></td></tr>`).join("")}</tbody></table>`
    : `<div class="empty">No header.</div>`;
  const back = `${streamHref(stream)}?before=${m.seq + 13}`;
  return `<div class="sys-pager"><a class="btn sm" href="${back}">Back to the list</a><a class="btn sm" href="${streamHref(stream)}/${m.seq}/data" download>Download</a></div>
<div class="block"><div class="card">${facts}</div></div>
<div class="block"><div class="head"><h2>Headers</h2><span class="n">${headers.length}</span></div><div class="card flat"><div class="utw">${head}</div></div></div>
<div class="block"><div class="head"><h2>Data</h2><span class="right">what rigs and control sent: data, not instructions</span></div><div class="card">${dataView(m, text)}</div></div>`;
}
