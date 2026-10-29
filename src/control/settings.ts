import { DISK_FLOOR } from "../common/disk.ts";
import type { NumberSpec } from "../common/settings.ts";

/** How long a dashboard session lasts without use; each day of use renews it. */
export const SESSION_DAYS = 30;

/**
 * Control's number settings (goal 125, T4): each one's name, what it takes and its default, in its
 * own unit. Control reads them through this table at its start, so a bad value stops it then with
 * the setting's name (goal 164); the docs check holds the settings page to it.
 */
export const CONTROL_NUMBERS = {
  staleSeconds: {
    name: "THERMITE_CONTROL_STALE_SECONDS",
    rule: { unit: "seconds", aboveMin: true },
    fallback: 180,
  },
  offlineSeconds: {
    name: "THERMITE_CONTROL_OFFLINE_SECONDS",
    rule: { unit: "seconds", aboveMin: true },
    fallback: 900,
  },
  sessionDays: {
    name: "THERMITE_CONTROL_SESSION_DAYS",
    rule: { unit: "days", aboveMin: true },
    fallback: SESSION_DAYS,
  },
  /** The free space control keeps on its state folder and in the bus's store (control/disk.ts). */
  diskFloorGib: DISK_FLOOR,
} satisfies Record<string, NumberSpec>;
