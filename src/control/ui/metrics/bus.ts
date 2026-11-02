import type { BusFigures, BusStreamFigures } from "../../system/index.ts";
import { esc, infoLabel } from "../components/index.ts";
import { block, count, perSecond, share, since, size, tile, utc } from "./common.ts";
import { mayPublish, STREAM_WORDS, TIP } from "./words.ts";

/** A stream's inspector, where a click on the stream goes. */
export const streamHref = (stream: string) => `/ui/metrics/streams/${encodeURIComponent(stream)}`;

/** The server's tiles. */
function serverTiles(f: BusFigures, now: number): string {
  const s = f.server;
  if (!s)
    return `<div class="card"><div class="empty">The bus's server gave no figures: ${esc(f.errors.join("; ") || "no answer")}.</div></div>`;
  const js = s.jetstream;
  const r = s.rate;
  return `<div class="sys-tiles">${[
    tile(
      "Control's server",
      "",
      `NATS ${esc(s.version)}`,
      `up ${esc(since(s.started, now))} · ${esc(s.name)}`,
    ),
    tile("Its memory", TIP.serverMemory, esc(size(s.memory_bytes)), "the server's process"),
    js
      ? tile(
          "Kept in memory",
          TIP.keptMemory,
          esc(size(js.memory_bytes)),
          `of ${esc(size(js.memory_max))} it may use`,
        )
      : "",
    js
      ? tile(
          "Kept on disk",
          TIP.keptDisk,
          esc(size(js.store_bytes)),
          `of ${esc(size(js.store_max))} it may use · ${share(js.store_max ? js.store_bytes / js.store_max : 0)}`,
        )
      : "",
    tile("CPU", TIP.serverCpu, `${s.cpu_pct.toFixed(1)}%`, `of one core · ${s.cores} cores`),
    tile(
      "Traffic",
      TIP.traffic,
      r ? `${perSecond(r.in_msgs)} / ${perSecond(r.out_msgs)}` : "—",
      r
        ? `messages a second in / out · ${esc(size(r.in_bytes))}/s in`
        : "a second, from the next look",
    ),
    tile("Connections", "", count(s.connections), `${count(s.subscriptions)} subscriptions`),
    tile(
      "Leaf nodes",
      TIP.leaf,
      count(f.leafnodes.length),
      f.leafnodes.length ? "RunPod pods joined to it" : "no RunPod pod is joined",
    ),
  ].join("")}</div>`;
}

/** A stream's row: a click opens its messages. */
function streamRow(x: BusStreamFigures, now: number): string {
  const w = STREAM_WORDS[x.name];
  const max = x.config.max_bytes;
  const full = max ? x.bytes / max : 0;
  const href = streamHref(x.name);
  return `<tr class="sys-click${full > 0.85 ? " sys-warnrow" : ""}" data-stream="${esc(x.name)}"><td><a href="${href}"><b>${esc(x.name)}</b></a>${w ? `<div class="muted small">${esc(w.carries)}</div>` : ""}</td><td class="num">${count(x.messages)}</td><td class="num">${esc(size(x.bytes))}${max ? `<div class="muted small">of ${esc(size(max))}</div>` : ""}</td><td class="num">${count(x.subjects)}</td><td class="num">${x.messages ? esc(size(x.bytes / x.messages)) : "—"}</td><td class="num">${esc(size(x.config.max_msg_size))}</td><td class="num">${perSecond(x.rate)}</td><td class="num">${esc(since(x.first_at, now))}</td><td class="small">${esc(w?.kept ?? x.config.retention)}</td><td class="num">${count(x.consumers)}</td></tr>`;
}

/** Metrics' Bus tab: the server, its streams, consumers, event sizes, connections and leaf nodes. */
export function busTab(f: BusFigures, now: number): string {
  const warn = f.warnings.map((w) => `<div class="card warn sys-note">${esc(w)}</div>`).join("");
  const errs =
    f.server && f.errors.length
      ? `<div class="card sys-note muted small">Not read on this look: ${esc(f.errors.join("; "))}</div>`
      : "";
  const streams = f.streams.length
    ? `<div class="card flat"><div class="utw"><table><thead><tr><th>Stream</th><th class="num">Messages</th><th class="num">${infoLabel("On disk", TIP.onDisk)}</th><th class="num">${infoLabel("Subjects", TIP.subjects)}</th><th class="num">Avg size</th><th class="num">${infoLabel("Largest allowed", TIP.largest)}</th><th class="num">${infoLabel("In /s", TIP.rate)}</th><th class="num">Oldest</th><th>${infoLabel("Kept", TIP.kept)}</th><th class="num">Consumers</th></tr></thead><tbody>${f.streams.map((x) => streamRow(x, now)).join("")}</tbody></table></div></div>`
    : `<div class="card"><div class="empty">No stream to show.</div></div>`;
  const consumers = f.consumers.length
    ? `<div class="card flat"><div class="utw"><table><thead><tr><th>Stream</th><th>Consumer</th><th>Reads</th><th class="num">${infoLabel("Pending", TIP.pending)}</th><th class="num">${infoLabel("Not acked", TIP.ackPending)}</th><th class="num">${infoLabel("Sent again", TIP.again)}</th><th>Last active</th></tr></thead><tbody>${f.consumers
        .map(
          (c) =>
            `<tr${c.redelivered || (c.durable && c.pending > 100) ? ` class="sys-warnrow"` : ""}><td>${esc(c.stream)}</td><td><code>${esc(c.name)}</code>${c.durable ? "" : ` <span class="muted small">a read, removed after</span>`}</td><td class="small">${c.filter.length ? c.filter.map((x) => `<code>${esc(x)}</code>`).join(" ") : "all its subjects"}</td><td class="num">${count(c.pending)}</td><td class="num">${count(c.ack_pending)}</td><td class="num">${count(c.redelivered)}</td><td>${c.last_active ? `${esc(since(c.last_active, now))} ago` : "never"}</td></tr>`,
        )
        .join("")}</tbody></table></div></div>`
    : `<div class="card"><div class="empty">No consumer.</div></div>`;
  const sizes = f.event_sizes.length
    ? `<div class="card flat"><div class="utw"><table><thead><tr><th>Kind</th><th class="num">Events</th><th class="num">Bytes</th><th class="num">Average</th><th class="num">Largest</th><th>Largest from</th></tr></thead><tbody>${f.event_sizes
        .map(
          (k) =>
            `<tr><td><code>${esc(k.kind)}</code></td><td class="num">${count(k.events)}</td><td class="num">${esc(size(k.bytes))}</td><td class="num">${esc(size(k.bytes / Math.max(1, k.events)))}</td><td class="num"><a href="${streamHref("EVENTS")}/${k.largest_seq}">${esc(size(k.largest))}</a></td><td>${esc(k.largest_rig ?? "—")}</td></tr>`,
        )
        .join("")}</tbody></table></div></div>`
    : `<div class="card"><div class="empty">No event in the last hour.</div></div>`;
  const conns = f.connections.length
    ? `<div class="card flat"><div class="utw"><table><thead><tr><th>Who</th><th>User</th><th>Since</th><th class="num">${infoLabel("RTT", TIP.rtt)}</th><th class="num">${infoLabel("Msgs in / out", TIP.msgs)}</th><th class="num">Bytes in / out</th><th class="num">${infoLabel("Pending", TIP.connPending)}</th><th class="num">Subscriptions</th></tr></thead><tbody>${f.connections
        .map(
          (x) =>
            `<tr${x.pending_bytes > 1024 * 1024 ? ` class="sys-warnrow"` : ""}><td><details class="sys-conn" data-k="conn-${esc(x.name)}-${x.id}"><summary><b>${esc(x.name || `connection ${x.id}`)}</b> <span class="muted small">${esc(x.kind)}</span></summary><div class="small"><div><b>Subscriptions:</b> ${x.subscriptions.length ? x.subscriptions.map((s) => `<code>${esc(s)}</code>`).join(" ") : "none"}</div><div class="muted">May publish (its permissions): ${esc(mayPublish(x.user))}.${x.lang ? ` Client: ${esc(x.lang)} ${esc(x.version ?? "")}.` : ""}</div></div></details></td><td class="small">${esc(x.user ?? x.account ?? "—")}</td><td class="small">${esc(utc(x.started))}</td><td class="num">${esc(x.rtt ?? "—")}</td><td class="num">${count(x.total.in_msgs)} / ${count(x.total.out_msgs)}</td><td class="num">${esc(size(x.total.in_bytes))} / ${esc(size(x.total.out_bytes))}</td><td class="num">${esc(size(x.pending_bytes))}</td><td class="num">${count(x.subscriptions.length)}</td></tr>`,
        )
        .join(
          "",
        )}</tbody></table></div>${f.connections_left_out ? `<p class="muted small sys-pad">${count(f.connections_left_out)} more not listed.</p>` : ""}</div>`
    : `<div class="card"><div class="empty">No connection.</div></div>`;
  const leafs = f.leafnodes.length
    ? block(
        "Leaf nodes",
        "each RunPod pod's server, joined to control's",
        `<div class="card flat"><div class="utw"><table><thead><tr><th>Leaf node</th><th>Account</th><th class="num">RTT</th><th class="num">Msgs in / out</th><th class="num">Bytes in / out</th><th class="num">Subscriptions</th></tr></thead><tbody>${f.leafnodes
          .map(
            (l) =>
              `<tr><td><b>${esc(l.name)}</b></td><td class="small">${esc(l.account ?? "—")}</td><td class="num">${esc(l.rtt ?? "—")}</td><td class="num">${count(l.total.in_msgs)} / ${count(l.total.out_msgs)}</td><td class="num">${esc(size(l.total.in_bytes))} / ${esc(size(l.total.out_bytes))}</td><td class="num">${count(l.subscriptions)}</td></tr>`,
          )
          .join("")}</tbody></table></div></div>`,
        String(f.leafnodes.length),
      )
    : "";
  return `${warn}${errs}${block("Servers", "control's NATS server, and each RunPod pod's leaf node", serverTiles(f, now))}
${block("Streams", "a click on a stream opens its messages", streams, String(f.streams.length))}
${block("Consumers", "what waits for each reader", consumers, String(f.consumers.length))}
${block(`Event sizes ${infoLabel("", TIP.sizes)}`, "EVENTS by kind, over the last hour, as control takes them", sizes)}
${block("Connections", "every client; open one for its subscriptions", conns, String(f.connections.length))}
${leafs}`;
}
