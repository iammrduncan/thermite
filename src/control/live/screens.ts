import {
  KEYS_MAX,
  type PressedKeys,
  SCREENS_WATCHED_MAX,
  type ScreenFrame,
} from "../../core/screens.ts";

/**
 * The terminal view on control (goal 169; core/screens.ts): which trials the owner's pages watch
 * now, and the newest screen of each, in memory only, while it is watched. A rig's supervisor asks
 * which of its trials are watched on the message bus (core/link/asks.ts's `screens`) and sends
 * their screens; a screen nobody watches is not kept, and none is ever written down. The keys the
 * owner presses into a watched terminal wait here for the rig's next ask, which takes them with
 * its answer (goal 187).
 */

/** How long after the owner's last key the rig is asked to come back soon. */
const TYPING_MS = 5_000;
/** The most pieces of keys that wait for one rig: past it, more are refused until it asks. */
const KEYS_WAITING_MAX = 64;

/** A frame as control keeps it, with when it came. */
export type HeldFrame = ScreenFrame & { got: string };

const key = (rig: string, trial: string) => `${rig}\n${trial}`;

export class Screens {
  /** How many pages watch each trial, by rig. */
  private readonly watchers = new Map<string, Map<string, number>>();
  /** The newest frame of each watched trial. */
  private readonly frames = new Map<string, HeldFrame>();
  private readonly listeners = new Set<(rig: string, trial: string) => void>();
  /** Keys pressed on Live, by rig, waiting for its next ask, and when the owner last pressed one. */
  private readonly keys = new Map<string, PressedKeys>();
  private readonly typedAt = new Map<string, number>();

  /**
   * A page watches a trial's screen until it calls the function this returns. Undefined when the
   * rig has SCREENS_WATCHED_MAX other trials watched already.
   */
  watch(rig: string, trial: string): (() => void) | undefined {
    const of = this.watchers.get(rig) ?? new Map<string, number>();
    if (!of.has(trial) && of.size >= SCREENS_WATCHED_MAX) return undefined;
    of.set(trial, (of.get(trial) ?? 0) + 1);
    this.watchers.set(rig, of);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (of.get(trial) ?? 1) - 1;
      if (n > 0) return void of.set(trial, n);
      of.delete(trial);
      this.frames.delete(key(rig, trial));
      if (!of.size) this.watchers.delete(rig);
    };
  }

  /** The rig's trials watched now. */
  watched(rig: string): string[] {
    return [...(this.watchers.get(rig)?.keys() ?? [])];
  }

  /** A rig's frames: kept, the newest of each, only for its trials watched now. How many were. */
  take(rig: string, frames: readonly ScreenFrame[], now = new Date()): number {
    const watched = this.watchers.get(rig);
    let kept = 0;
    for (const f of frames) {
      if (!watched?.has(f.trial)) continue;
      this.frames.set(key(rig, f.trial), { ...f, got: now.toISOString() });
      kept++;
      for (const l of this.listeners) l(rig, f.trial);
    }
    return kept;
  }

  /** A watched trial's newest frame. */
  frame(rig: string, trial: string): HeldFrame | undefined {
    return this.frames.get(key(rig, trial));
  }

  /**
   * Keys the owner pressed into a watched terminal, for the rig's next ask. False when the trial
   * is not watched now, or too many wait already.
   */
  press(rig: string, trial: string, data: string, now = Date.now()): boolean {
    if (!this.watchers.get(rig)?.has(trial)) return false;
    const waiting = this.keys.get(rig) ?? [];
    const last = waiting.at(-1);
    if (last && last.trial === trial && last.data.length + data.length <= KEYS_MAX)
      last.data += data;
    else if (waiting.length >= KEYS_WAITING_MAX) return false;
    else waiting.push({ trial, data });
    this.keys.set(rig, waiting);
    this.typedAt.set(rig, now);
    return true;
  }

  /** The keys waiting for a rig, handed over once. */
  takeKeys(rig: string): PressedKeys {
    const waiting = this.keys.get(rig) ?? [];
    this.keys.delete(rig);
    return waiting;
  }

  /** Whether the owner pressed a key into one of the rig's terminals in the last few seconds. */
  typing(rig: string, now = Date.now()): boolean {
    return now - (this.typedAt.get(rig) ?? 0) < TYPING_MS;
  }

  /** Told of each frame kept, until the function it returns is called. */
  onFrame(listener: (rig: string, trial: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
