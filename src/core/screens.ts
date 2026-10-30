import { z } from "zod";

/**
 * The terminal view (goal 169): a running trial's screen as its terminal host keeps it, sent only
 * for the trials someone watches on control, and held in memory on the way, never recorded. The
 * supervisor asks control which trials are watched, asks its harness for their screens, and sends
 * them to control on the message bus, as a request on the rig's own subject that no stream keeps
 * (core/link/asks.ts): the bus's LIVE stream keeps what it carries on disk for an hour, and a
 * frame is a view, not a record. A screen is what the agent's program drew: no decision reads it.
 */

/** The most characters of one screen: a running trial's screen, or an ended one's last. */
export const SCREEN_DATA_MAX = 256 * 1024;
/** The most trials of one rig whose screens are watched at once; more watchers are refused. */
export const SCREENS_WATCHED_MAX = 4;
/** How often the supervisor sends the watched screens, and asks which are watched when none is. */
export const SCREENS_WATCHED_MS = 1_000;
export const SCREENS_IDLE_MS = 5_000;

/** A trial's id, as stop_trial and terminal_input name one. */
const TrialRef = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "a trial's id");

export const ScreenFrame = z.object({
  trial: TrialRef,
  /**
   * `running`: its screen now; `ended`: its last screen, kept once the trial ended; `none`: it has
   * no terminal (its program runs headless, has not started yet, or the harness restarted since it
   * ended).
   */
  state: z.enum(["running", "ended", "none"]),
  /** The terminal's size, and the screen as a string that draws it in a terminal of that size. */
  cols: z.number().int().min(1).max(1000).optional(),
  rows: z.number().int().min(1).max(1000).optional(),
  data: z.string().max(SCREEN_DATA_MAX).optional(),
  /** While the program waits for its usage window: when it resets, when the program said. */
  limit: z.object({ resets_at: z.string().max(64).optional() }).optional(),
  /** How many of the owner's inputs wait for that reset. */
  queued: z.number().int().min(0).optional(),
  /**
   * The screen is a worker in Pi's Pi view, which Thermite draws of its own Pi session: its console
   * takes words (to steer, or as a follow-up), Esc and the Pi view's commands.
   */
  pi_view: z.literal(true).optional(),
  /** When the harness took it. */
  at: z.string().max(40),
});
export type ScreenFrame = z.infer<typeof ScreenFrame>;

/** The watched trials one ask names. */
export const WatchedTrials = z.array(TrialRef).max(SCREENS_WATCHED_MAX);

/** The most bytes of one ask of frames: every watched screen at its largest, as JSON. */
export const SCREENS_MAX_BYTES = SCREENS_WATCHED_MAX * SCREEN_DATA_MAX * 6 + 64 * 1024;
