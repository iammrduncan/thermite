import { execFileSync } from "node:child_process";
import { chmodSync, chownSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

/**
 * What root closes and makes in the supervisor's container before the supervisor starts, so that
 * an advisor user (core/advisor-runs.ts) reaches none of the supervisor's tokens, keys, seeds,
 * state, inbox or results. The advisor users are in none of the supervisor's groups: a folder
 * closed to "others" is closed to them.
 */

export interface SupervisorFolders {
  /** Root's folders with what only the supervisor reads: the secret files', the advisors file's. */
  closed: string[];
  /** The folder the inbox is mounted in (core/paths.ts: SUPERVISOR_INBOX_DIR's). */
  inboxParent: string;
  inbox: string;
  /** The supervisor's own folders: its state, and the results volume where it has one. */
  own: string[];
  /** The advisors' runs' root: each run's folder is one of its children. Emptied at each start. */
  runs: string;
  /** The folder of the advisors' runner's socket. */
  socketDir: string;
}

/** Who owns what: root (0 in the image; a test's own user), and the supervisor's user and group. */
export interface FolderIds {
  root: number;
  uid: number;
  gid: number;
}

/** A tree given to the supervisor, links not followed, when its top is not the supervisor's. */
function giveTree(path: string, ids: FolderIds): void {
  if (statSync(path).uid === ids.uid) return;
  execFileSync("chown", ["-R", "-P", `${ids.uid}:${ids.gid}`, path], { stdio: "ignore" });
}

/**
 * Closes and makes the supervisor's folders; returns what it did, in words, for the log. A closed
 * folder that does not exist is left out (no secret mounted there), except the inbox's, which the
 * image has. The inbox itself keeps its owner and modes when the supervisor may write in it
 * already (compose's folder from the host, open to every user inside its closed parent): it is
 * given to the supervisor only when it may not (a machine's new volume, made by the harness's
 * container first).
 */
export function prepareSupervisorFolders(f: SupervisorFolders, ids: FolderIds): string[] {
  const done: string[] = [];
  const closeToOthers = (d: string) => {
    chownSync(d, ids.root, ids.gid);
    chmodSync(d, 0o750);
    done.push(`${d}: root's, the supervisor's group may read it (0750)`);
  };
  for (const d of f.closed) if (existsSync(d)) closeToOthers(d);
  mkdirSync(f.inboxParent, { recursive: true });
  closeToOthers(f.inboxParent);
  if (dirname(f.inbox) !== f.inboxParent)
    done.push(`${f.inbox}: NOT in ${f.inboxParent}, so the advisor users are not kept from it`);
  mkdirSync(f.inbox, { recursive: true });
  const inbox = statSync(f.inbox);
  if (inbox.uid !== ids.uid && !(inbox.mode & 0o002)) {
    giveTree(f.inbox, ids);
    done.push(`${f.inbox}: given to the supervisor`);
  }
  for (const d of f.own) {
    if (!existsSync(d)) continue;
    giveTree(d, ids);
    chmodSync(d, 0o700);
    done.push(`${d}: the supervisor's, closed to every other user (0700)`);
  }
  // The runs' root: the supervisor makes each run's folder in it, and the advisor users pass
  // through it to their own, listing nothing.
  rmSync(f.runs, { recursive: true, force: true });
  mkdirSync(f.runs, { recursive: true });
  chownSync(f.runs, ids.uid, ids.gid);
  chmodSync(f.runs, 0o711);
  mkdirSync(f.socketDir, { recursive: true });
  closeToOthers(f.socketDir);
  return done;
}
