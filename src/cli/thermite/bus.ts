import { parseArgs } from "node:util";
import { BUS, type BusState } from "../../core/api/control/bus.ts";
import { controlAt, orFail } from "../calls.ts";
import { fail } from "./shared.ts";
import { USAGE } from "./usage.ts";

/**
 * thermite bus (goal 168): the message bus as control sees it now (`GET /v1/bus`, as MCP's
 * `bus_state` gives it), in lines to read; `--json` prints control's answer as it came.
 */
export async function thermiteBus(rest: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      control: { type: "string" },
      "token-file": { type: "string" },
      json: { type: "boolean" },
    },
  });
  if (positionals.length || !values.control || !values["token-file"]) fail(USAGE);
  const state = await orFail(controlAt(values.control, values["token-file"]).call(BUS));
  process.stdout.write(values.json ? `${JSON.stringify(state)}\n` : formatBus(state));
}

/** Bytes in the largest unit that keeps the number at 1 or more: 0 B, 512 B, 4.2 KiB, 1.5 GiB. */
function bytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return u === 0 ? `${v} B` : `${v.toFixed(1)} ${units[u]}`;
}

const count = (n: number) => n.toLocaleString("en-US");

/** Rows as columns, each as wide as its widest cell, two spaces apart. */
function columns(rows: string[][]): string[] {
  const width = (i: number) => Math.max(...rows.map((r) => (r[i] ?? "").length));
  return rows.map((r) =>
    r
      .map((cell, i) => cell.padEnd(width(i)))
      .join("  ")
      .trimEnd(),
  );
}

/** The bus's state in lines: its server, each stream and its consumers, the events, live and config. */
function formatBus(state: BusState): string {
  if (!state.on) return "control runs without its message bus (only a test makes it so)\n";
  const link = state.connection;
  const said = [
    link?.version ? `NATS ${link.version}` : "",
    link?.since ? `control connected since ${link.since}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const lines = [
    state.reachable
      ? `bus ${state.server}: reached${said ? ` (${said})` : ""}`
      : `bus ${state.server}: not reached: ${state.error ?? "no answer"}`,
  ];
  if (state.streams.length) {
    const rows = [["STREAM", "MESSAGES", "BYTES", "SUBJECTS", "NEWEST"]];
    const consumers = new Map<number, string[]>();
    for (const s of state.streams) {
      const notes = s.consumers.map(
        (k) =>
          `  consumer ${k.name}: ${count(k.pending)} not handed yet, ${count(k.ack_pending)} not acked, ${count(k.redelivered)} handed again`,
      );
      if (s.consumers_left_out) notes.push(`  and ${count(s.consumers_left_out)} more consumers`);
      consumers.set(rows.length, notes);
      rows.push([
        s.name,
        count(s.messages),
        bytes(s.bytes),
        count(s.subjects),
        s.last_at ?? "none",
      ]);
    }
    columns(rows).forEach((line, i) => {
      lines.push(line, ...(consumers.get(i) ?? []));
    });
  } else if (state.reachable) lines.push("no stream yet: control makes them as it starts");
  const e = state.events;
  lines.push(
    `events: ${count(e.published)} published since control started, ${count(e.moved)} moved from an older store, ${count(e.later)} reports refused for now${e.waiting ? `; the last because ${e.waiting}` : ""}`,
  );
  const a = e.apply;
  lines.push(
    `apply: through place ${count(a.place)}${a.last_place === null ? " (the stream's last place not read)" : ` of ${count(a.last_place)}, ${count(a.behind ?? 0)} behind`}; ${count(a.applied)} applied, ${count(a.refused)} passed over since control started`,
  );
  if (a.waiting) lines.push(`  it waits: ${a.waiting}`);
  if (a.stopped) lines.push(`  it stopped: ${a.stopped}`);
  const live = state.live;
  lines.push(
    `live: ${count(live.taken.messages)} messages and ${count(live.taken.lines)} lines taken since control started${live.rigs.length ? `; ${live.rigs.map((r) => `${r.rig} ${count(r.taken)}`).join(", ")}` : ""}`,
  );
  const rigs = state.config.rigs;
  lines.push(
    `config: ${
      rigs.length
        ? rigs
            .map(
              (r) =>
                `${r.rig} ${r.sealed ? `${count(r.written)} values written` : "no seal key, nothing written"}`,
            )
            .join(", ")
        : "no rig on the bus yet"
    }`,
  );
  return `${lines.join("\n")}\n`;
}
