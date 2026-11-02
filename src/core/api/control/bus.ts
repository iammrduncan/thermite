import { z } from "zod";
import type { Route } from "../route.ts";

/**
 * Control's API for the state of its message bus (goal 168; src/control/api/bus.ts answers it, and
 * MCP's `bus_state` gives the same): its server, the streams control makes and what each consumer
 * has still to take, the writer of the events stream and its apply, and the live stream's and the
 * config bucket's figures. The owner's and the reader's tokens read it. The schema names what the
 * command line reads; the answer goes on whole.
 */

/** A consumer of a stream, as the server has it now. */
const Consumer = z.looseObject({
  name: z.string(),
  pending: z.number(),
  ack_pending: z.number(),
  redelivered: z.number(),
});

/** A stream control makes, as the server has it now. */
const Stream = z.looseObject({
  name: z.string(),
  messages: z.number(),
  bytes: z.number(),
  subjects: z.number(),
  first_at: z.string().nullable(),
  last_at: z.string().nullable(),
  consumers: z.array(Consumer),
  consumers_left_out: z.number(),
  /** Its messages by subject: REPORTS only, one subject for each rig. */
  counts: z.record(z.string(), z.number()).optional(),
});

/** The bus's state: `on` false only for a control made without its bus, as a test makes it. */
export const BusState = z.union([
  z.looseObject({ on: z.literal(false) }),
  z.looseObject({
    on: z.literal(true),
    server: z.string(),
    /** Control's connection now, and since when, with the server's version. */
    connection: z
      .looseObject({
        state: z.string(),
        since: z.string().nullable(),
        version: z.string().nullable(),
      })
      .optional(),
    reachable: z.boolean(),
    error: z.string().nullable(),
    streams: z.array(Stream),
    events: z.looseObject({
      published: z.number(),
      moved: z.number(),
      later: z.number(),
      waiting: z.string().nullable(),
      apply: z.looseObject({
        place: z.number(),
        last_place: z.number().nullable(),
        behind: z.number().nullable(),
        applied: z.number(),
        refused: z.number(),
        waiting: z.string().nullable(),
        stopped: z.string().nullable(),
      }),
    }),
    live: z.looseObject({
      taken: z.looseObject({ messages: z.number(), lines: z.number() }),
      rigs: z.array(z.looseObject({ rig: z.string(), taken: z.number() })),
    }),
    config: z.looseObject({
      rigs: z.array(z.looseObject({ rig: z.string(), sealed: z.boolean(), written: z.number() })),
    }),
  }),
]);
export type BusState = z.input<typeof BusState>;

export const BUS = { method: "GET", path: "/v1/bus", answer: BusState } as const satisfies Route;

/**
 * A rig's connection to the bus, as the rig list (`GET /v1/rigs`, MCP's `list_rigs`) and the rig's
 * view give it, from what its page knows (src/control/bus/reach.ts): `off`, so broken, since when,
 * why (`http`: it calls control over HTTPS with no keys on the bus; `silent`: it registered its
 * keys and nothing came from it on the bus since; `leaf`: a pod on RunPod that control's bus can't
 * dial), in words, and what to do; or `on` while nothing says it is off, since its supervisor last
 * registered its keys over HTTPS (at its start), null when control has no registration of it.
 */
export const BusReach = z.discriminatedUnion("state", [
  z.object({ state: z.literal("on"), since: z.string().nullable() }),
  z.object({
    state: z.literal("off"),
    since: z.string(),
    why: z.enum(["http", "silent", "leaf"]),
    words: z.string(),
    fix: z.string(),
  }),
]);
export type BusReach = z.infer<typeof BusReach>;

/**
 * The whole system's figures (goal 179; src/control/api/bus.ts answers it, MCP's `system_state`
 * gives the same, and Metrics shows it): `bus`, the bus's server, streams, consumers, connections,
 * leaf nodes and the events' sizes by kind, from the server's own monitoring; `control`, its
 * process's CPU, memory, event loop and loops; `storage`, where control's state sits, in memory and
 * on disk, each place's used and available space and control.db's tables; `rigs`, each rig's
 * parts' CPU and memory as they report them. `?part=` names some of the four, by commas.
 */
const SystemAnswer = z.looseObject({
  bus: z
    .looseObject({ at: z.string(), streams: z.array(z.looseObject({ name: z.string() })) })
    .optional(),
  control: z.looseObject({ at: z.string() }).optional(),
  storage: z.looseObject({ at: z.string() }).optional(),
  rigs: z.array(z.looseObject({ rig: z.string() })).optional(),
});

export const SYSTEM = {
  method: "GET",
  path: "/v1/system",
  what: "the system's figures",
  answer: SystemAnswer,
} as const satisfies Route;

/** A stream's message as a page of them lists it: no data, its size and the start of its text. */
const MessageRow = z.looseObject({
  seq: z.number(),
  subject: z.string(),
  at: z.string().nullable(),
  bytes: z.number(),
  headers: z.record(z.string(), z.string()),
  preview: z.string().nullable(),
});

/**
 * A page of a stream's messages, newest first (goal 179): `?subject=` filters (`*` and `>` too),
 * `?before=<seq>` gives the page older than a place and `?after=<seq>` the page newer. Read with
 * the server's message lookup alone: no consumer is made, nothing is acked or removed. The owner's
 * token only, since the previews show what the messages hold.
 */
export const BUS_MESSAGES = {
  method: "GET",
  path: "/v1/bus/streams/:stream/messages",
  what: "a stream's messages",
  answer: z.looseObject({
    stream: z.string(),
    subject: z.string(),
    last_seq: z.number(),
    messages: z.array(MessageRow),
    older: z.number().nullable(),
    newer: z.number().nullable(),
    cut: z.string().nullable(),
  }),
} as const satisfies Route;

/** One message of a stream whole: its data as `text` when it is text, else as `base64`. */
export const BUS_MESSAGE = {
  method: "GET",
  path: "/v1/bus/streams/:stream/messages/:seq",
  what: "a stream's message",
  answer: MessageRow.extend({ text: z.string().nullable(), base64: z.string().nullable() }),
} as const satisfies Route;
