import { chmodSync, type Dirent, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeAtomic } from "../../common/fs.ts";
import { LAYOUT_FILE, type LayoutRecord, type Role, walk } from "../broker/index.ts";

/**
 * What the role probes aim at in the rig's folders: a research folder written for the selftest,
 * the first file in the inbox, the first kit, build and baseline file there are, and the broker's
 * record of shared mode; and
 * the removal of what the selftest made.
 */

/**
 * A research folder for the selftest, written as the harness writes a run's (goal 062): its
 * index and one claim, under the controller's umask (main.ts) whoever runs the selftest. The
 * claim's file and its folder: no role may change the one or add to the other.
 */
export function researchProbeFolder(dir: string): { claim: string; claims: string } {
  removeOwnTree(dir);
  const claim = join(dir, "claims", "c-selftest.md");
  const umask = process.umask(0o022);
  try {
    writeAtomic(join(dir, "INDEX.md"), "# Isolation selftest\n");
    writeAtomic(claim, "# Claim c-selftest: verified\n\nThe isolation selftest wrote it.\n");
  } finally {
    process.umask(umask);
  }
  return { claim, claims: dirname(claim) };
}

/** The roles that read a run's research folder: the workers' users and the planner's. */
export function readsResearch(role: Role): boolean {
  return /^(lane-\d+|agent-\d+|planner)$/.test(role);
}

/** The shared-mode record the broker wrote, if any (its fence, or why it could not be set up). */
export function sharedRecord(socketPath: string): LayoutRecord | undefined {
  try {
    const r = JSON.parse(
      readFileSync(join(dirname(socketPath), LAYOUT_FILE), "utf8"),
    ) as LayoutRecord;
    return "mode" in r && r.mode === "shared" ? r : undefined;
  } catch {
    return undefined;
  }
}

/** The most entries the inbox's walk looks at for a file to probe. */
const INBOX_LOOK_MAX = 1000;

/** A file in the inbox (a bundle or a model the supervisor fetched), by its full path. */
export function firstInboxFile(inboxDir: string): string | undefined {
  const stack = [inboxDir];
  for (let seen = 0; stack.length && seen < INBOX_LOOK_MAX; ) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      seen++;
      if (e.isFile()) return join(dir, e.name);
      if (e.isDirectory()) stack.push(join(dir, e.name));
    }
  }
  return undefined;
}

export function firstKitFile(kitsDir: string): string | undefined {
  if (!existsSync(kitsDir)) return undefined;
  for (const commit of readdirSync(kitsDir)) {
    const f = join(kitsDir, commit, "kit.json");
    if (existsSync(f)) return f;
  }
  return undefined;
}

/** A file a kit's check kept with a hill climb's baseline (goal 115), by its full path. */
export function firstBaselineFile(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  for (const run of readdirSync(dir)) {
    for (const job of readdirSync(join(dir, run))) {
      const stack = [join(dir, run, job)];
      while (stack.length) {
        const d = stack.pop() as string;
        for (const e of readdirSync(d, { withFileTypes: true })) {
          if (e.isFile()) return join(d, e.name);
          if (e.isDirectory()) stack.push(join(d, e.name));
        }
      }
    }
  }
  return undefined;
}

export function firstBuildFile(buildsDir: string): string | undefined {
  if (!existsSync(buildsDir)) return undefined;
  for (const key of readdirSync(buildsDir)) {
    const manifest = join(buildsDir, key, "manifest.json");
    if (!existsSync(manifest)) continue;
    const files = Object.keys(
      (JSON.parse(readFileSync(manifest, "utf8")) as { files: Record<string, string> }).files,
    );
    if (files[0]) return join(buildsDir, key, files[0]);
  }
  return undefined;
}

/**
 * Removes a tree the controller made read-only (a run's kit copy): its directories are opened
 * again first, since only root may remove entries from a directory without write permission.
 */
export function removeOwnTree(path: string): void {
  if (!existsSync(path)) return;
  walk(path, (p, isDir) => {
    if (isDir) chmodSync(p, 0o755);
  });
  rmSync(path, { recursive: true, force: true });
}
