import { COMMAND_QUEUE_MAX, COMMAND_STREAM } from "../../../core/link/commands.ts";
import { CONFIG_STREAM } from "../../../core/link/config.ts";
import { EVENT_STREAM } from "../../../core/link/events.ts";
import { KB_FILES_STREAM } from "../../../core/link/kb-files.ts";
import {
  LIVE_KEPT_BYTES,
  LIVE_KEPT_PER_SUBJECT,
  LIVE_KEPT_SECONDS,
  LIVE_STREAM,
} from "../../../core/link/live.ts";
import { REPORT_STREAM, REPORTS_WAITING_PER_RIG } from "../../../core/link/report.ts";
import { sizeWords } from "../../../core/words.ts";

/** What each stream carries, and how long it keeps a message, in words (Metrics and Settings). */
export const STREAM_WORDS: Record<string, { carries: string; kept: string }> = {
  [EVENT_STREAM]: {
    carries: "Every event each rig reported: control's copy of the rigs' ledgers",
    kept: "Until a retention policy removes some; never deleted",
  },
  [REPORT_STREAM]: {
    carries: "Each rig's reports, until control takes them",
    kept: `Until taken · ${REPORTS_WAITING_PER_RIG} waiting per rig at most`,
  },
  [COMMAND_STREAM]: {
    carries: "Signed commands, until each rig acknowledges them",
    kept: `Until acknowledged, or its time limit · ${COMMAND_QUEUE_MAX} waiting per rig at most`,
  },
  [LIVE_STREAM]: {
    carries: "The agents' live lines, for Live",
    kept: `The newest ${LIVE_KEPT_SECONDS / 3600} hour, ${LIVE_KEPT_PER_SUBJECT.toLocaleString("en-US")} a subject, ${sizeWords(LIVE_KEPT_BYTES)} at most`,
  },
  [CONFIG_STREAM]: {
    carries: "Each rig's model routes, MCP servers and Git accesses, sealed to its key",
    kept: "The newest of each",
  },
  [KB_FILES_STREAM]: {
    carries: "Knowledge-base files on their way to control",
    kept: "Until taken",
  },
};

/** What each user on the bus may publish, by whose it is, in words (the Connections table). */
export function mayPublish(user: string | null): string {
  if (user === "control")
    return "everything in its account but removing a stream: events, commands, config, answers to asks";
  if (user === "control's system user")
    return "requests for the server's figures and a reload, nothing else";
  if (user === "the backup") return "snapshots and restores of the streams kept for good";
  if (user?.startsWith("rig ")) return "its own reports, live lines and files, and asks to control";
  return "what its account lets it";
}

/** The info icons' words on Metrics' system tabs. */
export const TIP = {
  live: "The page asks control for new figures every 2 seconds while it is shown. Pause stops it; nothing else changes.",
  serverMemory:
    "The bus's server process's memory. The server keeps an index of every stream's subjects in memory, and the blocks a read loaded: a stream with many subjects costs memory even when its messages are small.",
  keptMemory:
    "JetStream's memory store: streams kept in memory only. Thermite keeps every stream on disk, so this stays at 0.",
  keptDisk:
    "JetStream's file store, all streams together, against its limit (THERMITE_NATS_STORE, or three quarters of the free disk when the server started).",
  serverCpu: "The server process's CPU, as a share of one core: 100% is one core.",
  traffic:
    "Messages a second the server took in from publishers and handed out to subscribers, since the look before.",
  leaf: "Each RunPod rig's pod runs its own server, joined to this one as a leaf node.",
  onDisk:
    "The stream's messages in the server's file store. Every Thermite stream is kept on disk; none in memory.",
  subjects:
    "How many subjects the stream holds messages on. The server keeps an index entry for each in memory, so a stream with many subjects costs memory even when its messages are small.",
  largest: "The largest message the stream takes; a larger one is refused.",
  rate: "Messages a second the stream took since the look before, from its last place.",
  kept: "How the stream keeps its messages: until a reader takes them, up to a limit, or until a retention policy removes some.",
  pending: "Messages the stream holds that this consumer has not been handed yet.",
  ackPending: "Messages handed to the consumer that it has not acknowledged yet.",
  again:
    "Messages handed more than once because the reader did not acknowledge them in time. A few after a restart is normal.",
  sizes:
    "The EVENTS stream's messages of the last hour, as control took them, by kind: how many, their bytes, and the largest with the rig it came from.",
  msgs: "In: messages this client published. Out: messages the server delivered to it, from its subscriptions.",
  connPending:
    "Bytes the server queued for this client and has not sent yet: a client that reads slower than its messages come shows here first.",
  rtt: "The time a message takes to the client and back, as the server last measured it.",
  cpu: "CPUs busy on average over the last few seconds, as a share of the CPUs it may use (its container's quota, or the machine's).",
  memory:
    "Memory in use against the limit: the whole container's, as its control groups count it, without the page cache the kernel may take back; where it runs in no container, its process's.",
  loopDelay:
    "How late Node ran the work it had queued, over the last minute: control's pages and the rigs' answers wait as long. Above a few tens of milliseconds, something holds control busy.",
  loops:
    "Each of control's loops, and when it last came around. Late after: past this, control's health answers 503.",
  used: "What the place holds now.",
  available: "What it may still take: free space on the disk, or room under its limit.",
  dbFile:
    "control.db on disk. SQLite counts each table's and index's pages; the table below lists them.",
  wal: "The write-ahead log beside control.db: new writes wait there until SQLite copies them into the file.",
  freePages:
    "Pages in the file no row uses, left by removed rows. SQLite reuses them; a vacuum would give them back to the disk.",
  cache: "The most SQLite keeps of the file in control's memory.",
  rigCpu: "CPUs busy, as a share of the CPUs the part may use, as the part last reported it.",
  rigMemory: "The part's container's memory in use, as it last reported it.",
} as const;
