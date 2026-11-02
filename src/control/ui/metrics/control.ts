import type { ControlFigures, StorageFigures } from "../../system/index.ts";
import { esc, infoLabel } from "../components/index.ts";
import {
  bar,
  block,
  count,
  duration,
  placesTable,
  share,
  since,
  size,
  spark,
  split,
  tile,
} from "./common.ts";
import { TIP } from "./words.ts";

/** CPUs busy as a share of those it may use, in words: 7.5% of its 2 CPUs. */
export function cpuWords(cpu: number | null, cpus: number): { value: string; sub: string } {
  if (cpu === null) return { value: "—", sub: `of its ${cpus} CPUs · from the next look` };
  return {
    value: `${((cpu / cpus) * 100).toFixed(1)}%`,
    sub: `of its ${cpus} CPUs · ${cpu.toFixed(2)} busy`,
  };
}

/** Metrics' Control tab: control's CPU, memory, event loop and loops. */
export function controlTab(f: ControlFigures, now: number): string {
  const u = f.use;
  const cpu = cpuWords(u.cpu, u.cpus);
  const limit = u.memory_limit_bytes;
  const memSub =
    limit === null
      ? u.of === "container"
        ? "its container has no memory limit"
        : "its process: control runs in no container"
      : `of ${esc(size(limit))} · ${share(u.memory_bytes / limit)}`;
  const tiles = `<div class="sys-tiles">${[
    tile(
      "CPU",
      TIP.cpu,
      cpu.value,
      cpu.sub,
      spark(
        f.history.map((h) => h.cpu),
        u.cpus,
      ),
    ),
    tile(
      "Memory",
      TIP.memory,
      esc(size(u.memory_bytes)),
      memSub,
      spark(
        f.history.map((h) => h.memory_bytes),
        limit ?? Math.max(...f.history.map((h) => h.memory_bytes), 1),
      ),
    ),
    tile(
      "Event loop delay",
      TIP.loopDelay,
      `${f.event_loop.p99_ms.toFixed(1)} ms`,
      `p99 · mean ${f.event_loop.mean_ms.toFixed(1)} ms · max ${f.event_loop.max_ms.toFixed(0)} ms`,
    ),
    tile(
      "Up",
      "",
      esc(since(f.started_at, now)),
      `${esc(f.build.commit ? f.build.commit.slice(0, 8) : f.build.version)} · Node.js ${esc(f.node.replace(/^v/, ""))}`,
    ),
  ].join("")}</div>`;
  const m = f.memory;
  const native = Math.max(0, m.rss - m.heap_total - m.external);
  const memory = `<div class="card">${split(
    [
      { label: "JavaScript heap in use", bytes: m.heap_used },
      { label: "Heap kept, not in use", bytes: Math.max(0, m.heap_total - m.heap_used) },
      { label: "Buffers", bytes: m.external },
      { label: "Native (SQLite's page cache among it)", bytes: native },
    ],
    m.rss,
  )}<p class="muted small sys-gap">Control's own process: ${esc(size(m.rss))} resident.${u.of === "container" ? ` Its container, with every process in it: ${esc(size(u.memory_bytes))}.` : ""}</p></div>`;
  const loops = Object.entries(f.loops)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([name, l]) =>
        `<tr${l.late ? ` class="sys-warnrow"` : ""}><td><b>${esc(name)}</b></td><td class="num">${count(l.age_seconds)} s ago</td><td class="num">${esc(duration(l.limit_seconds))}</td><td>${l.late ? `<span class="chip bad">late</span>` : l.busy ? `<span class="chip">busy: ${esc(l.busy)}</span>` : `<span class="chip ok">on time</span>`}</td></tr>`,
    )
    .join("");
  return `${f.ok ? "" : `<div class="card warn sys-note">A loop of control's is late: its health answers 503 until it comes around again.</div>`}${tiles}
${block("Memory", "control's process, by part", memory)}
${block(`Loops ${infoLabel("", TIP.loops)}`, "each of control's loops and when it last came around", `<div class="card flat"><div class="utw"><table><thead><tr><th>Loop</th><th class="num">Last round</th><th class="num">Late after</th><th>State</th></tr></thead><tbody>${loops || `<tr><td colspan="4" class="muted">No loop yet.</td></tr>`}</tbody></table></div></div>`)}`;
}

/** Metrics' Storage tab: memory and disk, each place's used and available, and control.db. */
export function storageTab(f: StorageFigures): string {
  const tips = { used: TIP.used, available: TIP.available };
  const where = `<div class="card flat"><h3 class="sys-h3">In memory</h3>${placesTable(f.memory, tips)}<h3 class="sys-h3">On disk</h3>${placesTable(f.disk, tips)}</div>`;
  const kinds = [
    ...f.streams.map((s) => ({ label: `bus: ${s.name}`, bytes: s.bytes })),
    ...f.kinds
      .filter((k) => k.kind !== "events" && k.bytes !== null)
      .map((k) => ({ label: k.label, bytes: k.bytes ?? 0 })),
  ]
    .filter((k) => k.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
  const takes = kinds.length
    ? `<div class="card">${split(kinds, 0)}${
        f.kinds.some((k) => k.error)
          ? `<p class="muted small sys-gap">Not read: ${esc(
              f.kinds
                .filter((k) => k.error)
                .map((k) => `${k.label}: ${k.error}`)
                .join("; "),
            )}</p>`
          : ""
      }</div>`
    : `<div class="card"><div class="empty">Nothing on disk yet.</div></div>`;
  const db = f.db;
  const dbBlock = db
    ? `<div class="sys-tiles">${[
        tile(
          "File",
          TIP.dbFile,
          esc(size(db.file_bytes)),
          `${count(db.pages)} pages of ${esc(size(db.page_size))}`,
        ),
        tile(
          "Write-ahead log",
          TIP.wal,
          esc(size(db.wal_bytes)),
          "copied into the file as SQLite checkpoints",
        ),
        tile(
          "Free pages",
          TIP.freePages,
          esc(size(db.free_pages * db.page_size)),
          `${share(db.pages ? db.free_pages / db.pages : 0)} of the file`,
        ),
        tile("Page cache", TIP.cache, `up to ${esc(size(db.cache_bytes))}`, "in control's memory"),
        tile(
          "Schema",
          "",
          db.schema_version === null ? "—" : `version ${db.schema_version}`,
          `measured ${esc(db.at.slice(11, 16))} UTC`,
        ),
      ].join(
        "",
      )}</div><div class="card flat"><div class="utw"><table><thead><tr><th>Table or index</th><th class="num">Rows</th><th class="num">On disk</th><th class="num">Share</th><th></th></tr></thead><tbody>${db.tables
        .map((t) => {
          const part = db.file_bytes ? t.bytes / db.file_bytes : 0;
          return `<tr><td><code>${esc(t.name)}</code>${t.of ? ` <span class="muted small">index of ${esc(t.of)}</span>` : ""}</td><td class="num">${t.rows === null ? "—" : count(t.rows)}</td><td class="num">${esc(size(t.bytes))}</td><td class="num">${(part * 100).toFixed(1)}%</td><td class="sys-barcell">${bar(part)}</td></tr>`;
        })
        .join("")}</tbody></table></div></div>`
    : `<div class="card"><div class="empty">control.db was not measured: ${esc(f.db_error ?? "no answer")}.</div></div>`;
  const floor = f.floor
    ? f.floor.floor_gib
      ? `control holds new runs below ${f.floor.floor_gib} GiB free${f.floor.low ? ` · <b class="bad">at its floor now</b>` : ""}`
      : "no disk floor is set"
    : "";
  return `${block("Memory and disk", floor || "where control's state sits", where)}
${block("What takes the disk", "each kind of state, control's and the bus's", takes)}
${block("control.db", "SQLite, with its write-ahead log; each table's size from SQLite itself, measured every 5 minutes", dbBlock)}`;
}
