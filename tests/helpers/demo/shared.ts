import type { IngestReport } from "../../../src/control/store/index.ts";

// What the demo's parts share: its clock (every made-up time is some hours before it), its
// seeded random sequences, and a rig whose events the demo makes up. seedDemo() starts the clock
// and the sequences again, so each seed of a store makes the same data at its own time.

const state = { now: Date.now(), seed: 42, useSeed: 7 };

/** Starts the demo's clock at `at`, and its random sequences from their first number. */
export function startDemo(at: number): void {
  state.now = at;
  state.seed = 42;
  state.useSeed = 7;
}

/** The demo's clock: the time its made-up times count back from. */
export const demoNow = (): number => state.now;

export const rnd = () => {
  state.seed = (state.seed * 1103515245 + 12345) % 2 ** 31;
  return state.seed / 2 ** 31;
};
export const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
export const iso = (hoursAgo: number) => new Date(state.now - hoursAgo * 3_600_000).toISOString();

type Ev = IngestReport["events"][number];
export class Rig {
  events: Ev[] = [];
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
  ev(
    hoursAgo: number,
    kind: string,
    subject: string | null,
    body: Record<string, unknown>,
    actor = "harness",
  ) {
    this.events.push({ id: this.events.length + 1, at: iso(hoursAgo), actor, kind, subject, body });
  }
}

// The model calls draw from their own sequence, so the rest of the demo stays as it was.
export const urnd = () => {
  state.useSeed = (state.useSeed * 1103515245 + 12345) % 2 ** 31;
  return state.useSeed / 2 ** 31;
};
