export type JetStreamName = "EVENTS" | "JOBS" | "LIVE";
export type JetStreamRetention = "limits" | "workqueue";
export type JetStreamStorage = "file" | "memory";
export type JetStreamDiscard = "old" | "new";
export type JetStreamCompression = "none" | "s2";

export type JetStreamStreamSpec = {
  readonly name: JetStreamName;
  readonly subjects: readonly string[];
  readonly retention: JetStreamRetention;
  readonly storage: JetStreamStorage;
  readonly discard: JetStreamDiscard;
  readonly discardNewPerSubject?: boolean;
  readonly compression?: JetStreamCompression;
  readonly maxAgeNs: number;
  readonly maxBytes?: number;
  readonly maxMsgsPerSubject?: number;
  readonly maxMsgSizeBytes?: number;
  readonly duplicateWindowNs?: number;
  readonly allowDirect?: boolean;
  readonly allowAtomic?: boolean;
};

const HOUR_NS = 3600 * 1e9;
const WEEK_NS = 7 * 24 * HOUR_NS;
export const MAX_JOB_PAYLOAD_BYTES = 1_048_576 as const;

export const JETSTREAM_STREAMS = {
  EVENTS: {
    name: "EVENTS",
    subjects: ["t.run.*.ev.*", "t.run.*.attempt.*", "t.run.*.need.*", "t.machine.*.ev.*"],
    retention: "limits",
    storage: "file",
    compression: "s2",
    discard: "new",
    maxAgeNs: 0,
    allowDirect: true,
    allowAtomic: true,
  },
  JOBS: {
    name: "JOBS",
    subjects: ["t.machine.*.job.dispatch", "t.machine.*.job.result"],
    retention: "workqueue",
    storage: "file",
    discard: "new",
    discardNewPerSubject: true,
    maxAgeNs: WEEK_NS,
    maxMsgsPerSubject: 256,
    duplicateWindowNs: WEEK_NS,
    maxMsgSizeBytes: MAX_JOB_PAYLOAD_BYTES,
  },
  LIVE: {
    name: "LIVE",
    subjects: ["t.run.*.live.*", "t.machine.*.job.*.live", "t.need.*.live", "t.live.*.*"],
    retention: "limits",
    storage: "file",
    discard: "old",
    maxAgeNs: HOUR_NS,
    maxBytes: 256 * 1024 * 1024,
    maxMsgsPerSubject: 1000,
  },
} as const satisfies Readonly<Record<JetStreamName, JetStreamStreamSpec>>;

export const CORE_NATS_SUBJECTS = {
  heartbeat: "t.machine.*.hb",
  cancel: "t.machine.*.cancel",
} as const;
