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
