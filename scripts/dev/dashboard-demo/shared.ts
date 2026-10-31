import type { IngestReport } from "../../../src/control/store/index.ts";

// What the demo's parts share: its clock (every made-up time is some hours before now), its
// seeded random sequences, and a rig whose events the demo makes up.

export const now = Date.now();
let seed = 42;
export const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};
export const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
export const iso = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();

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
let useSeed = 7;
export const urnd = () => {
  useSeed = (useSeed * 1103515245 + 12345) % 2 ** 31;
  return useSeed / 2 ** 31;
};
