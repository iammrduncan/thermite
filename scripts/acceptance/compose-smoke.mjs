#!/usr/bin/env node
// Local compose smoke test: build and start control and one rig, assign the smoke campaign
// through control, submit one candidate as a proposer, and wait until its verdict reaches
// control. Usage: COMPOSE="podman compose" node scripts/acceptance/compose-smoke.mjs (or "docker compose").
//
// Control and the rig talk only on the message bus (goal 168), and control keeps every rig's
// events in its events stream: the smoke checks that the rig's events are there, and that control
// applied the stream to its end. The rig's supervisor sends its reports and live lines over the
// bus, over TLS, and the smoke checks that they reached control that way. It prints how long
// events took to reach control.
import {
  api,
  assign,
  candidatePatch,
  control,
  dc,
  events,
  latestVerdicts,
  prepare,
  submit,
  until,
} from "./lib/smoke-env.mjs";

const composeEnv = {
  THERMITE_POLL_SECONDS: "3",
  THERMITE_CALIBRATION_BLOCKS: "0",
};
const stack = (...args) => dc(composeEnv, ...args);

/**
 * Seconds from each event's time at the rig to control holding it (when the events stream stored
 * it, as control's raw events route says), for the events from the run's start on (the rig's start
 * waits for its first report). Both times are from the same machine's clock.
 */
async function eventDelays() {
  const rows = (await api("/v1/rigs/local-1/events?limit=5000")).body.events;
  const start = rows.findIndex((r) => r.kind === "run_created");
  return rows
    .slice(Math.max(0, start))
    .map((r) => (Date.parse(r.received_at) - Date.parse(r.at)) / 1000)
    .sort((a, b) => a - b);
}

/** A stream's state, from the NATS server's own monitoring; undefined before it is made. */
function streamState(name) {
  const url = "http://127.0.0.1:8222/jsz?streams=true&consumers=true";
  const jsz = JSON.parse(stack("exec", "-T", "nats", "wget", "-q", "-O", "-", url));
  return (jsz.account_details ?? [])
    .flatMap((a) => a.stream_detail ?? [])
    .find((s) => s.name === name);
}

/** The reports stream and control's consumer of it, from the NATS server's own monitoring. */
function busState() {
  const stream = streamState("REPORTS");
  const consumer = (stream?.consumer_detail ?? []).find((c) => c.name === "control-reports");
  return {
    messages: stream?.state?.messages ?? 0,
    lastSeq: stream?.state?.last_seq ?? 0,
    ackedTo: consumer?.ack_floor?.stream_seq ?? 0,
    pending: (consumer?.num_pending ?? 0) + (consumer?.num_ack_pending ?? 0),
  };
}

const env = prepare();
console.log("compose: build and start (the rig reports over the message bus)");
stack("up", "-d", "--build");
try {
  await until("control health", async () => (await fetch(`${control}/v1/health`)).ok);
  // Control's health says how it holds its bus: connected once the server took control's files.
  const health = await until(
    "control's health says the bus is connected",
    async () => {
      const h = await (await fetch(`${control}/v1/health`)).json();
      return h.bus === "connected" ? h : undefined;
    },
    60_000,
  );
  console.log("control's health:", JSON.stringify(health));
  await assign(env, "smoke-1");
  console.log("assign_campaign delivered and accepted");
  const a = submit(
    composeEnv,
    "smoke-1",
    candidatePatch(env, "kits/smoke-cpu/candidates/noop"),
    "rename the accumulator",
  );
  console.log("submitted", a.attempt, a.lifecycle);
  const verdict = await until(
    "verdict at control",
    async () => latestVerdicts(await events())[a.attempt],
    300_000,
    2000,
  ).catch(async (err) => {
    // What the rig had done, for a failure that says why: its newest events at control and the
    // harness's last log lines.
    const evs = await events().catch(() => []);
    for (const e of evs.slice(-25))
      console.log("event:", e.at, e.kind, JSON.stringify(e.body ?? {}).slice(0, 300));
    try {
      console.log(stack("logs", "--tail", "60", "harness"));
    } catch {
      // The logs are for the reader only: the failure below is the result.
    }
    throw err;
  });
  const kinds = [...new Set((await events()).map((e) => e.kind))];
  console.log("events at control:", kinds.join(", "));
  console.log("verdict:", verdict);
  // The reports came over the bus: the stream took them, and, an inbox, holds none once control
  // has taken each one it folded.
  const state = await until(
    "control folded every report on the bus",
    async () => {
      const s = busState();
      return s.lastSeq > 0 && s.messages === 0 && s.pending === 0 && s.ackedTo === s.lastSeq
        ? s
        : undefined;
    },
    60_000,
    1000,
  );
  console.log("reports on the bus:", JSON.stringify(state));
  // The live lines came over the bus too: control's state of the bus says it took them, and the
  // supervisor's figures say it published them.
  const live = await until(
    "live lines over the bus",
    async () => {
      const { body } = await api("/v1/bus");
      const rig = body.live?.rigs?.find((r) => r.rig === "local-1");
      const stream = body.streams?.find((x) => x.name === "LIVE");
      return stream?.messages > 0 && rig?.taken > 0 && rig?.supervisor?.published > 0
        ? { messages: stream.messages, taken: body.live.taken, rig }
        : undefined;
    },
    60_000,
    1000,
  );
  console.log("live lines on the bus:", JSON.stringify(live));
  // The rig's events are on the events stream: control published
  // each report's events there first, and applied the stream to its end, where its records (a
  // command's outcome, the model calls, the knowledge base) come from. The stream holds as many of
  // the rig's events as control's raw events route gives.
  const onBus = await until(
    "the rig's events on the events stream, and applied",
    async () => {
      const stream = streamState("EVENTS")?.state;
      const messages = stream?.messages ?? 0;
      const { events: e } = (await api("/v1/bus")).body;
      const rigs = (await api("/v1/rigs/local-1/events?limit=5000")).body.events.length;
      return messages > 0 &&
        rigs === messages &&
        e?.published > 0 &&
        e.apply?.place === stream?.last_seq &&
        e.apply.behind === 0 &&
        e.apply.stopped === null
        ? {
            messages,
            rigs,
            published: e.published,
            applied_place: e.apply.place,
            applied: e.apply.applied,
          }
        : undefined;
    },
    60_000,
    1000,
  );
  console.log("events on the bus:", JSON.stringify(onBus));
  const delays = await eventDelays();
  const at = (q) => delays[Math.min(delays.length - 1, Math.floor(q * delays.length))] ?? 0;
  console.log(
    `seconds from an event to control holding it, over the bus (${delays.length} events): median ${at(0.5).toFixed(2)}, 90th percentile ${at(0.9).toFixed(2)}, max ${(delays.at(-1) ?? 0).toFixed(2)}`,
  );
  console.log("compose smoke: OK");
} finally {
  if (process.env.KEEP !== "1") stack("down", "-v");
}
