import { DISK_FLOOR, GIB } from "../../common/disk.ts";
import { type NumberSpec, readNumber } from "../../common/settings.ts";

/**
 * The broker's number settings (goal 125, T4): each one's name, what it takes and its default,
 * in its own unit. The broker reads them through this table at its start, so a bad value stops it
 * then with the setting's name (goal 164); the docs check holds the settings page to it.
 */
export const BROKER_NUMBERS = {
  outboxGid: { name: "THERMITE_OUTBOX_GID", rule: { integer: true }, fallback: 10001 },
  fatalHoldSeconds: {
    name: "THERMITE_FATAL_HOLD_SECONDS",
    rule: { unit: "seconds" },
    fallback: 0,
  },
  snapshotMinutes: {
    name: "THERMITE_STATE_SNAPSHOT_MINUTES",
    rule: { unit: "minutes", aboveMin: true },
    fallback: 5,
  },
  snapshotStopSeconds: {
    name: "THERMITE_STATE_SNAPSHOT_STOP_SECONDS",
    rule: { unit: "seconds", aboveMin: true },
    fallback: 8,
  },
  /** The free space a snapshot leaves on the host's volume (common/disk.ts; goal 173). */
  diskFloorGib: DISK_FLOOR,
} satisfies Record<string, NumberSpec>;

/** The broker's numbers it reads at its start, in the units its code uses. */
export function brokerNumbers(env: Record<string, string | undefined>) {
  return {
    /** The supervisor's group: it reads exports from the shared outbox; roles may not. */
    outboxGid: readNumber(env, BROKER_NUMBERS.outboxGid),
    /** How long a fatal stop at start holds before the broker exits, at most 600 s. */
    fatalHoldMs: Math.min(readNumber(env, BROKER_NUMBERS.fatalHoldSeconds), 600) * 1000,
  };
}

/** How often a snapshot is taken (THERMITE_STATE_SNAPSHOT_MINUTES, 5 by default). */
export function snapshotEveryMs(env: Record<string, string | undefined>): number {
  return readNumber(env, BROKER_NUMBERS.snapshotMinutes) * 60_000;
}

/** The free space a snapshot leaves where it is kept, in bytes (THERMITE_DISK_FLOOR_GIB, 5). */
export function snapshotFloorBytes(env: Record<string, string | undefined>): number {
  return readNumber(env, BROKER_NUMBERS.diskFloorGib) * GIB;
}

/** How long a stop waits for its snapshot (THERMITE_STATE_SNAPSHOT_STOP_SECONDS, 8). */
export function stopBudgetMs(env: Record<string, string | undefined>): number {
  return readNumber(env, BROKER_NUMBERS.snapshotStopSeconds) * 1000;
}
