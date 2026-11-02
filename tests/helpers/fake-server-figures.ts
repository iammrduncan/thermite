import type { FiguresAsker } from "../../src/control/system/index.ts";
import type { ServerFigures } from "../../src/core/link/users.ts";

/**
 * The bus's server's monitoring as control's system user gets it (goal 179), for the tests of
 * Metrics' figures and pages: VARZ, JSZ with streams, consumers and config, CONNZ and LEAFZ.
 */

const MIB = 2 ** 20;

/** The server's answers, as its monitoring gives them; `seq` moves its counts on. */
export function serverAnswers(o: {
  inMsgs: number;
  lastSeq: number;
  liveBytes: number;
  pending?: number;
}) {
  return {
    VARZ: {
      server_name: "nats",
      version: "2.15.1",
      start: "2026-11-02T01:00:00Z",
      mem: 200 * MIB,
      cpu: 3.5,
      cores: 4,
      connections: 2,
      total_connections: 9,
      leafnodes: 0,
      subscriptions: 40,
      slow_consumers: 0,
      max_payload: 8 * MIB,
      in_msgs: o.inMsgs,
      out_msgs: 2 * o.inMsgs,
      in_bytes: 1000 * o.inMsgs,
      out_bytes: 0,
      jetstream: {
        config: { max_memory: 384 * MIB, max_storage: 1024 * MIB },
        stats: { memory: 0, storage: 900 * MIB, api: { total: 77, errors: 1 } },
      },
    },
    JSZ: {
      account_details: [
        {
          name: "THERMITE",
          stream_detail: [
            {
              name: "LIVE",
              created: "2026-11-01T00:00:00Z",
              config: {
                retention: "limits",
                storage: "file",
                discard: "old",
                max_bytes: 256 * MIB,
                max_age: 3600e9,
                max_msgs_per_subject: 1000,
                max_msg_size: MIB,
              },
              state: {
                messages: 10,
                bytes: o.liveBytes,
                first_seq: 1,
                first_ts: "2026-11-02T03:00:00Z",
                last_seq: o.lastSeq,
                last_ts: "2026-11-02T04:00:00Z",
                num_subjects: 3,
                num_deleted: 0,
                consumer_count: 0,
              },
            },
            {
              name: "REPORTS",
              config: {
                retention: "workqueue",
                storage: "file",
                discard: "new",
                max_bytes: -1,
                max_age: 0,
                max_msgs_per_subject: 32,
                max_msg_size: 8 * MIB,
              },
              state: {
                messages: 0,
                bytes: 0,
                first_seq: 0,
                first_ts: "0001-01-01T00:00:00Z",
                last_seq: 0,
                last_ts: "0001-01-01T00:00:00Z",
                num_subjects: 0,
                consumer_count: 1,
              },
              consumer_detail: [
                {
                  name: "control-reports",
                  config: {
                    durable_name: "control-reports",
                    filter_subject: "thermite.rig.*.report",
                  },
                  num_pending: o.pending ?? 0,
                  num_ack_pending: 0,
                  num_redelivered: 0,
                  num_waiting: 1,
                  delivered: { last_active: "2026-11-02T03:00:00Z" },
                },
              ],
            },
          ],
        },
      ],
    },
    CONNZ: {
      total: 3,
      connections: [
        {
          cid: 5,
          kind: "Client",
          name: "control",
          start: "2026-11-02T01:00:01Z",
          rtt: "200µs",
          in_msgs: 9,
          out_msgs: 3,
          in_bytes: 900,
          out_bytes: 300,
          pending_bytes: 0,
          subscriptions_list: ["_INBOX.x.*", "$JS.API.>"],
          authorized_user: "UCONTROL",
          account: "THERMITE",
          lang: "nats.js",
          version: "3.0.0",
        },
        {
          cid: 7,
          kind: "Client",
          name: "supervisor rig-a",
          rtt: "1ms",
          pending_bytes: 2 * MIB,
          subscriptions_list: [],
          authorized_user: "URIGA",
          account: "THERMITE",
        },
      ],
    },
    LEAFZ: { leafs: [] },
  } satisfies Record<ServerFigures, unknown>;
}

/** Answers each question from `now`; `failing` names one it gives no answer to. */
export class FakeServer implements FiguresAsker {
  now: ReturnType<typeof serverAnswers>;
  asked: { what: ServerFigures; options: Record<string, unknown> }[] = [];
  failing: ServerFigures | undefined;
  constructor(a: ReturnType<typeof serverAnswers>) {
    this.now = a;
  }
  async ask<T>(what: ServerFigures, options: Record<string, unknown> = {}): Promise<T> {
    this.asked.push({ what, options });
    if (what === this.failing) throw new Error("no answer");
    return this.now[what] as T;
  }
}
