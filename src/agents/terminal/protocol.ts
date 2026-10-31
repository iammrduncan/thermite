import { z } from "zod";
import { TERMINAL_KEYS, TERMINAL_PROGRAMS } from "../programs/index.ts";

/**
 * The terminal host's protocol with the harness (goal 169): the start it reads on its stdin, and
 * the requests it answers on its socket, `TERMINAL_SOCKET` in its run's area, one JSON object per
 * line each way, one request for each connection. Every request carries the secret its start gave
 * it. The host is a process of the lane's user, as the agent's own commands are, so the harness
 * checks every answer against these schemas and reads no more than ANSWER_MAX of it.
 */

/** The host's socket, in its run's area, which the harness may enter and the lane owns. */
export const TERMINAL_SOCKET = "terminal.sock";
/** The longest path a Unix socket may have (macOS's limit; Linux allows 108 bytes). */
export const SOCKET_PATH_MAX = 103;

/** The terminal's size unless the trial sets one. */
export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 40;
/** The lines of scrollback the emulator keeps unless the start says: about 1.4 MB at 120 columns. */
export const DEFAULT_SCROLLBACK = 1_000;
export const SCROLLBACK_MAX = 10_000;

/** The most characters of text in one request. */
export const TEXT_MAX = 64 * 1024;
/** The most keys in one request. */
export const KEYS_MAX = 64;
/** The most bytes of one request's line; a longer one is refused. */
export const REQUEST_MAX = 2 * TEXT_MAX + 4096;
/** The most bytes of one answer's line the harness reads (a snapshot with its scrollback). */
export const ANSWER_MAX = 8 * 1024 * 1024;
/** The most bytes of the start's line (the first message is one argument: at most 128 KiB). */
export const START_MAX = 1024 * 1024;

const Seed = z.object({
  path: z.string().min(1).startsWith("/"),
  content: z.string().max(1024 * 1024),
  mode: z.number().int().min(0).max(0o777),
});

/** What the host starts with, on its stdin. */
export const TerminalStart = z.object({
  /** What each request must carry. */
  secret: z.string().min(32).max(256),
  /** The trial it is for, in its log lines. */
  trial: z.string().max(200).optional(),
  /** Which program: how its turn is interrupted and how it ends. */
  program: z.enum(TERMINAL_PROGRAMS),
  /** The program's command line, from its absolute path. */
  argv: z
    .array(z.string().max(128 * 1024))
    .min(1)
    .max(512),
  /** Where the program runs. */
  cwd: z.string().min(1).startsWith("/"),
  cols: z.number().int().min(20).max(500).default(DEFAULT_COLS),
  rows: z.number().int().min(5).max(200).default(DEFAULT_ROWS),
  scrollback: z.number().int().min(0).max(SCROLLBACK_MAX).default(DEFAULT_SCROLLBACK),
  /** Files written before the program starts: its settings, so that no screen waits. */
  seeds: z.array(Seed).max(16).default([]),
  /** Given to the program on file descriptor 3, then closed: Claude Code's sign-in. */
  token: z
    .string()
    .min(1)
    .max(16 * 1024)
    .optional(),
  /**
   * The program's session log, copied into `to`, a plain file in the host's area that the harness
   * may read: the first file under `dir`, at most `depth` folders down, whose name matches `name`.
   */
  mirror: z
    .object({
      dir: z.string().min(1).startsWith("/"),
      depth: z.number().int().min(0).max(8),
      name: z.string().min(1).max(500),
      to: z.string().regex(/^[\w.-]+$/, "a file name in the host's area"),
    })
    .optional(),
  /**
   * A server the program attaches to (OpenCode's), started first: the host waits until it takes
   * connections on `port` on localhost, and ends it after the program.
   */
  server: z
    .object({
      argv: z.array(z.string().max(4096)).min(1).max(64),
      port: z.number().int().min(1024).max(65_535),
    })
    .optional(),
});
export type TerminalStart = z.infer<typeof TerminalStart>;
export type TerminalStartInput = z.input<typeof TerminalStart>;

const secret = z.string().max(256);

/** What the harness may ask of the host. */
export const TerminalRequest = z.discriminatedUnion("op", [
  z.object({ op: z.literal("status"), secret }),
  /** Text typed into the program, then (unless `enter` is false) Enter, sent apart. */
  z.object({
    op: z.literal("type"),
    secret,
    text: z.string().min(1).max(TEXT_MAX),
    enter: z.boolean().default(true),
  }),
  z.object({
    op: z.literal("keys"),
    secret,
    keys: z.array(z.enum(TERMINAL_KEYS)).min(1).max(KEYS_MAX),
  }),
  /** The program's own steps to interrupt the agent's turn. */
  z.object({ op: z.literal("interrupt"), secret }),
  /** The screen as plain lines, or as a snapshot that restores it in a terminal of its size. */
  z.object({
    op: z.literal("screen"),
    secret,
    form: z.enum(["text", "snapshot"]).default("text"),
    scrollback: z.number().int().min(0).max(SCROLLBACK_MAX).default(0),
  }),
  /**
   * The program's clean end, then SIGTERM; the host exits after it answers. `steps` false: SIGTERM
   * at once, nothing typed (the harness's choice while the program shows a usage limit, whose
   * screen may take any key as an answer).
   */
  z.object({ op: z.literal("end"), secret, steps: z.boolean().default(true) }),
]);
export type TerminalRequest = z.input<typeof TerminalRequest>;

/** Where the host's program is: starting (seeds, server), running, being ended, or ended. */
export const HOST_STATES = ["starting", "running", "ending", "ended"] as const;

/** How the program ended. */
export const END_HOWS = [
  /** It exited on its own: a crash, or `/exit` typed into it. */
  "by itself",
  /** It exited after its end steps (`/exit`). */
  "end steps",
  /** It exited after SIGTERM. */
  "sigterm",
  /** It was still running: the host exited, and the broker ends what is left. */
  "left to the broker",
  /** It could not start. */
  "not started",
] as const;

export const ProgramExit = z.object({
  how: z.enum(END_HOWS),
  code: z.number().int().nullable(),
  signal: z.string().nullable(),
  /** Why it could not start, or what failed. */
  error: z.string().max(4000).optional(),
  /** The screen's last lines that were not empty, for the words of a failure. */
  screen: z.array(z.string().max(1000)).max(40).optional(),
});
export type ProgramExit = z.infer<typeof ProgramExit>;

const MirrorState = z.object({
  /** The session log it copies, once found. */
  from: z.string().optional(),
  bytes: z.number().int().min(0),
  /** Why it stopped copying, when it did. */
  stopped: z.string().optional(),
});

export const TerminalStatus = z.object({
  state: z.enum(HOST_STATES),
  pid: z.number().int().optional(),
  cols: z.number().int(),
  rows: z.number().int(),
  /** Bytes the program has written to its terminal. */
  output: z.number().int().min(0),
  mirror: MirrorState.optional(),
  exit: ProgramExit.optional(),
});
export type TerminalStatus = z.infer<typeof TerminalStatus>;

export const ScreenText = z.object({
  cols: z.number().int(),
  rows: z.number().int(),
  cursor: z.object({ x: z.number().int(), y: z.number().int() }),
  /** The program has its alternate screen up (a full-screen program's). */
  alternate: z.boolean(),
  lines: z.array(z.string()),
});
export type ScreenText = z.infer<typeof ScreenText>;

export const ScreenSnapshot = z.object({
  cols: z.number().int(),
  rows: z.number().int(),
  data: z.string(),
});
export type ScreenSnapshot = z.infer<typeof ScreenSnapshot>;

/** An answer: `{ok: true, ...}` with what was asked, or `{ok: false, error}`. */
export const RefusedAnswer = z.object({ ok: z.literal(false), error: z.string().max(2000) });
