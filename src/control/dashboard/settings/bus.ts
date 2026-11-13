import { mapInTurn } from "../../../common/in-turn.ts";
import { COMMAND_STREAM, commandConsumerName } from "../../../core/link/commands.ts";
import { CONFIG_STREAM, configConsumerName } from "../../../core/link/config.ts";
import { REPORT_STREAM, reportSubject } from "../../../core/link/report.ts";
import { busReach, type busState } from "../../bus/index.ts";
import { controlDiskOf } from "../../disk.ts";
import { heldCommands } from "../../issue/index.ts";
import type { ControlStore } from "../../store/index.ts";
import { ago, esc, infoLabel } from "../../ui/components/index.ts";
import { sizeWords } from "../../ui/exports.ts";
import { STREAM_WORDS } from "../../ui/metrics/index.ts";
import { podStopped, type RigView } from "../../views/index.ts";

/**
 * Settings › Message bus (goal 168; the owner's decision of 2026-11-01, from a mockup): control's
 * connection to the bus (its state and since when, the server, its store's use against control's
 * disk floor, the rigs' events written and applied), each rig on the bus (on it or off it and
 * broken, since when; its reports and commands that wait; the messages sent it again; its last
 * report), and the streams, with what each carries, holds and keeps. The same figures as
 * `GET /v1/bus`, MCP's `bus_state` and `thermite bus`; each rig's connection as `busReach` gives
 * it to `GET /v1/rigs` and `list_rigs`.
 */

type BusState = Awaited<ReturnType<typeof busState>>;

/** A time as the page says it: 2026-11-01 05:20 UTC. */
const utc = (at: string) => `${at.slice(0, 16).replace("T", " ")} UTC`;
const count = (n: number) => n.toLocaleString("en-US");

const TIPS = {
  connection:
    "On the bus: nothing says the rig can't reach control's bus, since its supervisor last registered its keys, at its start. Off the bus: it calls control over HTTP with no keys on the bus, nothing came from it on the bus for 5 minutes after it registered them, or control's bus can't dial its pod; it is broken until it comes back.",
  reports:
    "The rig's reports on the bus that control has not taken yet. Control takes them as they come; more than a few means control is behind.",
  commands:
    "Commands control signed for the rig that it has not acknowledged yet: on the bus, or held by control until the bus has room. A command waits up to its own time limit, then expires.",
  again:
    "Messages the bus sent the rig again because it did not acknowledge them in time: its commands and its config. A few after a restart is normal.",
  kept: "How long the bus keeps each message. Until taken: control or the rig removes it once handled. Until a retention policy removes some: Space and Retention policies, on this page.",
};

/** Control's own connection: its state, the server, its store against the floor, the events. */
function connectionRows(state: Extract<BusState, { on: true }>, store: ControlStore): string {
  const c = state.connection;
  const status =
    c.state === "connected"
      ? `<span class="dot ok"></span> Connected${c.since ? `, since ${esc(utc(c.since))}` : ""}`
      : `<span class="dot bad"></span> <b class="bad">Away</b>: control holds no connection to the bus, and tries again by itself`;
  const server = `${c.version ? `NATS ${esc(c.version)}, ` : ""}${esc(state.server)}, over TLS with control's own authority${state.reachable ? "" : ` · <span class="bad">not reached just now: ${esc(state.error ?? "no answer")}</span>`}`;
  const disk = controlDiskOf(store)?.state();
  const place = disk?.places.find((p) => p.name === "bus store");
  const unread = disk?.unread.find((p) => p.name === "bus store");
  const floor = disk?.floor_gib
    ? `control holds new runs below ${disk.floor_gib} GiB left`
    : "no disk floor is set";
  const storeUse = place
    ? `${(place.total_gib - place.free_gib).toFixed(1)} GiB of ${place.total_gib} GiB · ${floor}`
    : unread
      ? `<span class="bad">not read: ${esc(unread.error)}</span>`
      : `<span class="muted">not read yet: control reads it once a minute</span>`;
  const a = state.events.apply;
  const behind =
    a.behind === null
      ? ""
      : a.behind
        ? ` <span class="chip warn">${count(a.behind)} behind</span>`
        : ` <span class="chip ok">none behind</span>`;
  const events = `${a.last_place === null ? "the stream's last place not read" : `written through place ${count(a.last_place)}`} · applied through ${count(a.place)}${behind}${a.stopped ? ` · <span class="bad">stopped: ${esc(a.stopped)}</span>` : a.waiting ? ` · <span class="warn">waits: ${esc(a.waiting)}</span>` : ""}`;
  return `<dl class="facts"><dt>State</dt><dd>${status}</dd><dt>Server</dt><dd>${server}</dd><dt>Its store</dt><dd>${storeUse}</dd><dt>Rigs' events</dt><dd>${events}</dd></dl>`;
}

/** Each rig with what waits for it on the bus. */
async function rigRows(
  state: Extract<BusState, { on: true }>,
  store: ControlStore,
  views: RigView[],
  now: number,
): Promise<string> {
  const stream = (name: string) => state.streams.find((x) => x.name === name);
  const consumer = (s: string, name: string) => stream(s)?.consumers.find((k) => k.name === name);
  const reports = stream(REPORT_STREAM)?.counts ?? {};
  return (
    await mapInTurn(
      [...views].sort((x, y) => x.id.localeCompare(y.id)),
      async (u) => {
        const reach = await busReach(store, u.id, {
          lastSeen: u.last_seen,
          now,
          podStopped: podStopped(u),
        });
        const link =
          reach.state === "on"
            ? `<span class="dot ok"></span> On the bus${reach.since ? `, since ${esc(utc(reach.since))}` : ""}`
            : `<span class="dot bad"></span> <b>Off the bus</b> since ${esc(utc(reach.since))}: broken until it comes back`;
        const cmds = consumer(COMMAND_STREAM, commandConsumerName(u.id));
        const config = consumer(CONFIG_STREAM, configConsumerName(u.id));
        const waiting =
          (cmds?.pending ?? 0) + (cmds?.ack_pending ?? 0) + heldCommands(store, u.id).length;
        const again = (cmds?.redelivered ?? 0) + (config?.redelivered ?? 0);
        const last = Date.parse(u.last_seen) > 0 ? `${esc(ago(u.last_seen, now))} ago` : "never";
        return `<tr data-rig="${esc(u.id)}" data-bus="${reach.state}"><td><a href="/ui/rigs/${encodeURIComponent(u.id)}"><b>${esc(u.id)}</b></a></td><td>${link}</td><td class="num">${count(reports[reportSubject(u.id)] ?? 0)}</td><td class="num">${count(waiting)}</td><td class="num">${count(again)}</td><td>${last}</td></tr>`;
      },
    )
  ).join("");
}

/** The streams the server has, with what each carries, holds and keeps. */
function streamRows(state: Extract<BusState, { on: true }>): string {
  return state.streams
    .map((s) => {
      const w = STREAM_WORDS[s.name] ?? { carries: "", kept: "" };
      return `<tr data-stream="${esc(s.name)}"><td><code>${esc(s.name)}</code></td><td>${esc(w.carries)}</td><td class="num">${count(s.messages)}</td><td class="num">${esc(sizeWords(s.bytes))}</td><td>${esc(w.kept)}</td></tr>`;
    })
    .join("");
}

/** Settings › Message bus: control's connection, the rigs on the bus, and its streams. */
export async function busSettingsBlock(o: {
  state: BusState;
  store: ControlStore;
  views: RigView[];
  now: number;
}): Promise<string> {
  const head = (h: string, n: string, right: string) =>
    `<div class="head"><h2>${h}</h2>${n}<span class="right">${right}</span></div>`;
  if (!o.state.on)
    return `<div class="block" id="bus">${head("Message bus", "", "every rig reaches control only on the bus")}<div class="card"><div class="empty">Control runs without its message bus: only a test makes it so.</div></div></div>`;
  const state = o.state;
  const rigs = await rigRows(state, o.store, o.views, o.now);
  return `<div class="block" id="bus">${head("Message bus", "", "every rig reaches control only on the bus")}<div class="card"><h3 class="small" style="margin-top:0">Control's connection</h3>${connectionRows(state, o.store)}</div></div>
<div class="block" id="bus-rigs">${head("Rigs on the bus", `<span class="n">${o.views.length}</span>`, "each rig's own user, and what waits for it")}<div class="card">${
    rigs
      ? `<table><thead><tr><th>Rig</th><th>${infoLabel("Connection", TIPS.connection)}</th><th class="num">${infoLabel("Reports waiting", TIPS.reports)}</th><th class="num">${infoLabel("Commands waiting", TIPS.commands)}</th><th class="num">${infoLabel("Sent again", TIPS.again)}</th><th>Last report</th></tr></thead><tbody>${rigs}</tbody></table>`
      : `<div class="empty">No rig has reported yet.</div>`
  }</div></div>
<div class="block" id="bus-streams">${head("Bus streams", "", "what the bus keeps, and for how long")}<div class="card">${
    state.streams.length
      ? `<table><thead><tr><th>Stream</th><th>What it carries</th><th class="num">Messages</th><th class="num">Space</th><th>${infoLabel("Kept", TIPS.kept)}</th></tr></thead><tbody>${streamRows(state)}</tbody></table>`
      : `<div class="empty">${state.reachable ? "No stream yet: control makes them as it starts." : `The bus's server was not reached: ${esc(state.error ?? "no answer")}.`}</div>`
  }
<p class="muted small" style="margin-bottom:0">The same figures: <code>thermite bus</code>, <code>GET /v1/bus</code> and MCP's <code>bus_state</code>; each rig's connection also in <code>GET /v1/rigs</code> and <code>list_rigs</code>. Live, with every connection and each stream's messages: <a href="/ui/metrics?tab=bus">Metrics › Bus</a>.</p></div></div>`;
}
