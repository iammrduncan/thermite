import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../../common/env.ts";
import { writeAtomic } from "../../common/fs.ts";
import { withoutCredentials } from "../../common/scrub.ts";

/**
 * The conversations a harness of an earlier build kept in a run's research folder before it
 * scrubbed them (goal 175): each scrubbed by shape (common/scrub.ts, withoutCredentials), the
 * harness's own copy in its state and the copy the agents see, before an agent reads it again or
 * an export takes it. Once for each run: a mark in the run's folder of kept conversations in the
 * harness's state says it is done, and a conversation kept since is scrubbed as it is kept
 * (compactions.ts). The ledger's events stay as they are: events never change.
 */

/** The mark: every conversation in the folder beside it is scrubbed. */
const SCRUBBED_MARK = ".scrubbed";

/** A kept conversation's file name (core/compaction.ts, compactionFile). */
const KEPT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$/;

/**
 * Scrubs one run's kept conversations by shape, once: `kept`, the folder in the harness's state;
 * `shown`, the folder the agents read, which takes each scrubbed text where it has the file.
 * Returns how many conversations the scrub changed.
 */
export function scrubKeptFiles(run: string, kept: string, shown: string): number {
  if (!existsSync(kept) || existsSync(join(kept, SCRUBBED_MARK))) return 0;
  let changed = 0;
  for (const name of readdirSync(kept)) {
    if (!KEPT_NAME.test(name)) continue;
    const text = readFileSync(join(kept, name), "utf8");
    const scrubbed = withoutCredentials(text);
    if (scrubbed === text) continue;
    writeAtomic(join(kept, name), scrubbed);
    // The agents' copy is the state's, as keepCompaction and showCompactions write it.
    if (existsSync(join(shown, name))) writeAtomic(join(shown, name), scrubbed);
    changed++;
  }
  writeAtomic(join(kept, SCRUBBED_MARK), "");
  if (changed) log("harness", "kept conversations scrubbed by shape", { run, changed });
  return changed;
}
