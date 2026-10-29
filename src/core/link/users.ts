import { fromPublic } from "@nats-io/nkeys";
import { sha256Hex } from "../canonical.ts";
import { RIG_ID } from "../ids.ts";
import { COMMAND_STREAM, commandConsumerName, commandSubject } from "./commands.ts";
import { CONFIG_STREAM, configConsumerConfig, configConsumerName } from "./config.ts";
import { EVENT_STREAM } from "./events.ts";
import { kbAskSubject } from "./kb.ts";
import { kbFileSubject } from "./kb-files.ts";
import { LIVE_RUNS_PER_RIG, liveSubject, rigLiveSubject } from "./live.ts";
import { reportSubject } from "./report.ts";

/**
 * Who may do what on the message bus (goal 168): only control, its backups and the rigs'
 * supervisors hold a credential, each a NATS user key (an nkey) that the part made itself. The server knows a user by
 * the key's public part alone; its seed, the secret, never leaves the part that made it. Control
 * writes every user, with what it may do, to the server's users file (usersFile), and asks the
 * server to read it again (reloadSubject): a rig's supervisor registers its key on its regular call
 * to control, and has a user once control has written it.
 */

/** The account every stream is in, with control's user, the backup's and each rig's. */
export const BUS_ACCOUNT = "THERMITE";
/**
 * The server's own account: control's system user, which asks the server to reload and reads how
 * much of its store JetStream uses.
 */
export const SYSTEM_ACCOUNT = "SYS";

/** A user key's public part: 56 characters of base32, starting with U. */
const USER_KEY = /^U[A-Z2-7]{55}$/;

/** What a user key is, in words, for a refusal. */
export const USER_KEY_WORDS =
  "a NATS user key's public part: 56 characters of A-Z and 2-7, starting with U";

/** Whether `key` is a NATS user key's public part, its checksum right. */
export function isUserKey(key: string): boolean {
  if (!USER_KEY.test(key)) return false;
  try {
    fromPublic(key);
    return true;
  } catch {
    return false;
  }
}

/** What logs, the audit log and a rig's history show of a user key: never the key itself. */
export function userKeyFingerprint(key: string): string {
  return sha256Hex(key).slice(0, 16);
}

/**
 * The start of every subject a rig's supervisor takes replies on: the server's acks of its
 * reports, its answers about the rig's consumers, the rig's commands and its config. Its user may
 * subscribe there and nowhere else.
 */
export function rigInboxPrefix(rig: string): string {
  if (!RIG_ID.test(rig)) throw new Error(`not a rig's name for an inbox: ${rig}`);
  return `_INBOX.rig.${rig}`;
}

/** What a user may publish to and subscribe to: these subjects, and nothing else. */
export interface Permissions {
  publish: { allow: string[] };
  subscribe: { allow: string[] };
}

/** The JetStream API's subjects: the server answers a request on these. */
const API = "$JS.API";

/** A subject's last token as a pattern: any source. */
const anySource = (subject: string) => subject.replace(/\.[^.]+$/, ".*");

/**
 * What a rig's user may do: publish its own reports, and the live lines of its own runs and its
 * own (`runs`: the runs control's run registry gives the rig, the newest LIVE_RUNS_PER_RIG); make,
 * read and take from its own consumer of the commands stream, and ack what it took; and make
 * again, read and take from its own consumer of its config keys, and ack what it took. The server
 * checks that a consumer it makes takes the rig's own subjects alone: the subject names the
 * consumer's filter. A run whose name a subject can't hold has no subject of its own. Nothing on
 * the events stream: control publishes a rig's events there, from its reports. It may put the
 * knowledge base's files on its own subjects of the `KB_FILES` stream, and may not read that
 * stream or remove from it (kb-files.ts). It may ask control to search and read the knowledge base
 * on its own subjects (kb.ts), and takes the answers at its inbox.
 */
export function rigPermissions(rig: string, runs: readonly string[] = []): Permissions {
  const consumer = `${COMMAND_STREAM}.${commandConsumerName(rig)}`;
  const config = `${CONFIG_STREAM}.${configConsumerName(rig)}`;
  const own = anySource(rigLiveSubject(rig, "judge"));
  const live = runs
    .slice(0, LIVE_RUNS_PER_RIG)
    .map((run) => anySource(liveSubject(rig, { run, source: "judge" })))
    .filter((s) => s !== own);
  return {
    publish: {
      allow: [
        reportSubject(rig),
        own,
        ...new Set(live),
        `${API}.CONSUMER.CREATE.${consumer}.${commandSubject(rig)}`,
        `${API}.CONSUMER.INFO.${consumer}`,
        `${API}.CONSUMER.MSG.NEXT.${consumer}`,
        `$JS.ACK.${consumer}.>`,
        `${API}.CONSUMER.CREATE.${config}.${configConsumerConfig(rig).filter_subject}`,
        `${API}.CONSUMER.INFO.${config}`,
        `${API}.CONSUMER.DELETE.${config}`,
        `${API}.CONSUMER.MSG.NEXT.${config}`,
        `$JS.ACK.${config}.>`,
        kbFileSubject(rig, "*"),
        kbAskSubject("search", rig),
        kbAskSubject("read", rig),
      ],
    },
    subscribe: { allow: [`${rigInboxPrefix(rig)}.>`] },
  };
}

/**
 * The streams kept for good: the record of every rig's events, which a backup holds (core/backup.ts).
 * The reports stream is an inbox (report.ts), which control makes again when it was made as one
 * kept for good.
 */
export const STREAMS_KEPT_FOR_GOOD = [EVENT_STREAM] as const;

/**
 * What control's user may not do: delete or purge a stream kept for good. Such a stream refuses to
 * delete a message or to be purged (`deny_delete`, `deny_purge`), and refuses an update that would
 * undo that; but the server lets the stream itself be deleted. Both are denied here, so the rule
 * holds whatever a stream's settings say. Control's user may do the rest.
 */
export function controlPermissions(): { publish: { deny: string[] } } {
  const deny = STREAMS_KEPT_FOR_GOOD.flatMap((s) => [
    `${API}.STREAM.DELETE.${s}`,
    `${API}.STREAM.PURGE.${s}`,
  ]);
  return { publish: { deny } };
}

/**
 * The start of every subject the backup's user takes replies on: the server's answers, and the
 * chunks of a stream's snapshot. Its user may subscribe there and nowhere else.
 */
export const BACKUP_INBOX_PREFIX = "_INBOX.backup";

/**
 * What the backup's user may do (`thermite backup` and `thermite restore`): for each stream kept
 * for good, read its state and a message by its place, take its snapshot and ack its chunks, and
 * restore it, which the server does only for a stream it does not have. Nothing else: it may not
 * publish to a stream, nor delete or purge one.
 */
export function backupPermissions(): Permissions {
  const allow = STREAMS_KEPT_FOR_GOOD.flatMap((s) => [
    `${API}.STREAM.INFO.${s}`,
    `${API}.STREAM.MSG.GET.${s}`,
    `${API}.STREAM.SNAPSHOT.${s}`,
    `$JS.SNAPSHOT.ACK.${s}.>`,
    `${API}.STREAM.RESTORE.${s}`,
    `$JS.SNAPSHOT.RESTORE.${s}.>`,
  ]);
  return { publish: { allow }, subscribe: { allow: [`${BACKUP_INBOX_PREFIX}.>`] } };
}

/** The subject control's system user asks the server with this id to reload its configuration. */
export function reloadSubject(serverId: string): string {
  return `$SYS.REQ.SERVER.${serverId}.RELOAD`;
}

/**
 * The subject control's system user asks the server with this id for JetStream's figures on: how
 * much of its store JetStream uses, and its limit (the server's monitoring, as `/jsz`).
 */
export function jetStreamFiguresSubject(serverId: string): string {
  return `$SYS.REQ.SERVER.${serverId}.JSZ`;
}

/** What control's system user may do: ask for a reload and for JetStream's figures, and read the answers. */
const SYSTEM_PERMISSIONS: Permissions = {
  publish: { allow: [reloadSubject("*"), jetStreamFiguresSubject("*")] },
  subscribe: { allow: ["_INBOX.>"] },
};

/**
 * The users the server knows: control's two keys, the backup's when control has made it, and each
 * rig's that has one registered, with the runs control gives it.
 */
export interface BusUserKeys {
  control: string;
  system: string;
  backup?: string | undefined;
  rigs: readonly { rig: string; key: string; runs?: readonly string[] | undefined }[];
}

/**
 * The server's users file, which its configuration includes: control's user, which may do
 * everything in the account but what controlPermissions denies it; the backup's, which may do only
 * what backupPermissions gives it; a user for each rig, which may do only what rigPermissions gives
 * it; and control's system user. A rig with no key has no user. The values are JSON, which the
 * server's configuration reads. Throws on a key or a rig's name that is not one.
 */
export function usersFile(u: BusUserKeys): string {
  const backup = u.backup === undefined ? [] : [u.backup];
  for (const key of [u.control, u.system, ...backup, ...u.rigs.map((r) => r.key)])
    if (!isUserKey(key)) throw new Error("not a NATS user key for the bus's users file");
  const rigs = [...u.rigs].sort((a, b) => (a.rig < b.rig ? -1 : a.rig > b.rig ? 1 : 0));
  const accounts = {
    [BUS_ACCOUNT]: {
      jetstream: "enabled",
      users: [
        { nkey: u.control, permissions: controlPermissions() },
        ...backup.map((nkey) => ({ nkey, permissions: backupPermissions() })),
        ...rigs.map((r) => ({ nkey: r.key, permissions: rigPermissions(r.rig, r.runs) })),
      ],
    },
    [SYSTEM_ACCOUNT]: { users: [{ nkey: u.system, permissions: SYSTEM_PERMISSIONS }] },
  };
  return [
    "# The message bus's users, written by Thermite's control: control's own, and one for each rig",
    "# whose supervisor registered its key. Control writes it whole when one changes, and asks the",
    "# server to reload it. Edits here are lost.",
    `accounts: ${JSON.stringify(accounts, null, 2)}`,
    `system_account: ${JSON.stringify(SYSTEM_ACCOUNT)}`,
    "",
  ].join("\n");
}
