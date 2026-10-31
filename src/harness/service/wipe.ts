import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { Refusal } from "../../common/errors.ts";
import type { CommandPayloads } from "../../core/commands.ts";
import { KB_OUTBOX_FILES } from "../../core/kb.ts";
import type { HarnessPaths, HarnessService } from "./index.ts";

/** A full reset's wipe: the command that asks for it, and the wipe at the next start. */

/** Written by an accepted wipe_state; the next controller start wipes the state and removes it. */
export const WIPE_MARKER = "WIPE_REQUESTED";

/**
 * Carries out a requested wipe at start: everything in the state directory goes except the
 * rig's signing key (its identity stays), and the scratch directory is emptied. Returns
 * whether a wipe happened.
 */
export function wipeIfRequested(paths: HarnessPaths, keep: string[]): boolean {
  const marker = join(paths.stateDir, WIPE_MARKER);
  if (!existsSync(marker)) return false;
  // Build trees are locked read-only: make what this user owns writable before removing it.
  const remove = (p: string) => {
    try {
      execFileSync("chmod", ["-R", "u+rwX", p], { stdio: "ignore" });
    } catch {
      // files of other users: removing them needs the broker (root)
    }
    rmSync(p, { recursive: true, force: true });
  };
  for (const name of readdirSync(paths.stateDir)) {
    if (name === WIPE_MARKER) continue;
    if (name === "ledger") {
      for (const f of readdirSync(join(paths.stateDir, name))) {
        if (!keep.includes(f)) remove(join(paths.stateDir, name, f));
      }
      continue;
    }
    remove(join(paths.stateDir, name));
  }
  // Scratch, and the outbox: its exports reached the results repository before the wipe. The
  // knowledge base's files stay, for the supervisor to put on the bus (goal 175).
  for (const dir of [paths.scratchDir, paths.outboxDir]) {
    for (const name of existsSync(dir) ? readdirSync(dir) : [])
      if (!(dir === paths.outboxDir && name === KB_OUTBOX_FILES)) remove(join(dir, name));
  }
  mkdirSync(join(paths.stateDir, "ledger"), { recursive: true });
  writeFileSync(join(paths.stateDir, "ledger", NOT_BEFORE_FILE), notBeforeOf(marker));
  rmSync(marker, { force: true });
  return true;
}

/** Left by a wipe: the new ledger refuses commands issued before this time. */
export const NOT_BEFORE_FILE = "NOT_BEFORE";

/** The wipe command's issue time from a marker (control's clock), or now if it is missing. */
export function notBeforeOf(marker: string): string {
  try {
    const at = (JSON.parse(readFileSync(marker, "utf8")) as { not_before?: string }).not_before;
    if (at && Number.isFinite(Date.parse(at))) return at;
  } catch {
    // an unreadable marker: fall back to now
  }
  return new Date().toISOString();
}

/** Events that may follow the verified export without anything being lost in the wipe. */
const HOUSEKEEPING = new Set([
  "command",
  "command_rejected",
  "run_status",
  "export_written",
  "champion_published",
  "wipe_requested",
]);

/**
 * A full reset's wipe. Control has verified that the named export (a full one) reached the
 * results repository, and the owner confirmed it. The harness checks that the export exists,
 * was full, covers the events control names, and that nothing but housekeeping happened since.
 * The broker wipes at the next start (a marker is written and the controller exits), after
 * this command's result is delivered.
 */
export function requestWipe(
  svc: HarnessService,
  p: z.infer<(typeof CommandPayloads)["wipe_state"]>,
  by: string,
  issuedAt: string,
): unknown {
  const exp = svc.ledger.exports.at(p.export);
  if (!exp) throw new Refusal(`no export ${p.export} in this rig`);
  if (!(exp.manifest as { full?: boolean }).full)
    throw new Refusal(`export ${p.export} is not a full export`);
  if (exp.through_event < p.through_event)
    throw new Refusal("the export does not cover the events");
  const since = Object.entries(svc.ledger.events.countsByKind(exp.through_event)).filter(
    ([kind]) => !HOUSEKEEPING.has(kind),
  );
  if (since.length) {
    throw new Refusal(
      `research was recorded after the export (${since.map(([kind, n]) => `${kind} ${n}`).join(", ")}): export again`,
    );
  }
  for (const inst of svc.ledger.runs.list()) {
    if (inst.status === "running") svc.ledger.runs.setStatus(inst.id, "paused", "wiping", by);
  }
  writeFileSync(
    join(svc.paths.stateDir, WIPE_MARKER),
    // Commands issued before the wipe command (by control's clock) belonged to the old ledger.
    `${JSON.stringify({ export: p.export, by, at: new Date().toISOString(), not_before: issuedAt })}\n`,
  );
  svc.ledger.appendEvent(by, "wipe_requested", null, { export: p.export });
  // Exit after the result is on its way back; the broker restarts the controller, which wipes.
  setTimeout(() => svc.onWipe?.(), 2000).unref();
  return { wiping: true, export: p.export };
}
