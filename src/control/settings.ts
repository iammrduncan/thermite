import { DISK_FLOOR } from "../common/disk.ts";
import { LOCAL_HTTP_HOSTS } from "../common/mcp-client.ts";
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
  /** How long a knowledge-base file no item names is kept (control/kb/files.ts); 0: for good. */
  kbOrphanHours: {
    name: "THERMITE_CONTROL_KB_ORPHAN_HOURS",
    rule: { unit: "hours", zeroMeans: "every file is kept" },
    fallback: 0,
  },
} satisfies Record<string, NumberSpec>;

/** Control's address as rigs and the machines it sets rigs up on reach it. */
export const PUBLIC_URL_SETTING = "THERMITE_CONTROL_PUBLIC_URL";
/** `1`: control may give rigs a plain `http://` address on another host, as on a home network. */
export const PLAIN_HTTP_SETTING = "THERMITE_CONTROL_ALLOW_PLAIN_HTTP";

/**
 * Control's address for rigs (THERMITE_CONTROL_PUBLIC_URL), or undefined when it is not set. Rigs
 * send their tokens to it, and a rig off the message bus gets its keys there, so a plain `http://`
 * address must name this computer (localhost, 127.0.0.1, [::1]) or a name with no dot, as compose
 * names a service (`http://control:8800`), unless THERMITE_CONTROL_ALLOW_PLAIN_HTTP is `1`. Throws
 * otherwise, in words that name both settings, so control stops at its start.
 */
export function controlPublicUrl(env: Record<string, string | undefined>): string | undefined {
  const raw = env[PUBLIC_URL_SETTING]?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `${PUBLIC_URL_SETTING} takes an https:// address, such as https://control.example.com, not "${raw}"`,
    );
  }
  if (url.protocol === "https:") return raw;
  if (url.protocol !== "http:")
    throw new Error(
      `${PUBLIC_URL_SETTING} takes an https:// address, such as https://control.example.com, not "${raw}"`,
    );
  const host = url.hostname;
  const local = LOCAL_HTTP_HOSTS.includes(host);
  const service = !host.includes(".") && !host.includes(":");
  if (local || service || env[PLAIN_HTTP_SETTING] === "1") return raw;
  throw new Error(
    `${PUBLIC_URL_SETTING} is "${raw}", plain http to another host: rigs would send their tokens, and rigs off the message bus their keys, across the network unencrypted. Give control an https:// address, or set ${PLAIN_HTTP_SETTING}=1 to allow plain http on a network you trust`,
  );
}
