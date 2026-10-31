import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { BadInput, Refusal } from "../common/errors.ts";
import { sha256Hex } from "../core/canonical.ts";
import type { CommandPayloads } from "../core/commands.ts";
import { FINAL_LIFECYCLES } from "../core/verdicts.ts";
import { createAttemptCommit, deleteRef, GitError, hasCommit, patchBytes, treeOf } from "./git.ts";
import { importFile, importRoom } from "./imports.ts";
import { type Ledger, LedgerError } from "./ledger/index.ts";
import type { HarnessService, SubmitResult } from "./service/index.ts";

/**
 * Propagation across rigs. A rig's champion is published in its exports as a binary patch
 * against the campaign seed, with the resulting git tree. Another rig receives it through a
 * signed `propagate` command that names the patch's sha256 and the tree: the supervisor only
 * transports the bytes. The receiving harness rebuilds the source champion on the seed, checks
 * the tree, and submits the difference from its own champion as an ordinary attempt, which its
 * own judge screens and confirms. Only if it is promoted here does the source result count as
 * cross-verified (control reads `propagation_accepted`).
 */

type Propagate = z.infer<(typeof CommandPayloads)["propagate"]>;

/** Lifecycles after which a propagated attempt's outcome is known. */
const SETTLED = FINAL_LIFECYCLES;

export async function receivePropagation(
  svc: HarnessService,
  p: Propagate,
  by: string,
): Promise<unknown> {
  const inst = svc.ledger.runs.get(p.run);
  if (!inst) throw new LedgerError("not_found", `no run ${p.run}`);
  if (inst.mode === "research") throw new Refusal("research campaigns do not take propagations");
  const spec = p.import;
  if (spec.kind !== "champion_patch") {
    throw new BadInput("propagate takes a champion_patch import (a published champion)");
  }
  if (spec.repo !== inst.seed_repo) {
    throw new Refusal(`the champion is in ${spec.repo}; this run works on ${inst.seed_repo}`);
  }
  const mirror = svc.mirrorFor(inst.seed_repo);
  if (!(await hasCommit(mirror, spec.base_commit))) {
    throw new Refusal(`base commit ${spec.base_commit} is not in this rig's repository`);
  }
  // Copied into the harness's own store and hashed as copied; the sha256 is the signed one.
  const stored = await importFile({
    inboxDir: svc.paths.inboxDir,
    rel: spec.path,
    expectedSha256: spec.sha256,
    storeDir: join(svc.paths.stateDir, "imports", "patches"),
    room: importRoom(svc.disk, `the champion's patch ${spec.path}`),
  });
  const id = `p-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  let rebuilt: { commit: string; ref: string };
  try {
    rebuilt = await createAttemptCommit({
      mirror,
      scratchDir: join(svc.paths.scratchDir, "propagations"),
      parent: spec.base_commit,
      patch: readFileSync(stored),
      id,
      message: `thermite propagation ${id} from ${p.source_rig} ${p.source_run} seq ${p.source_seq}`,
      refPrefix: "refs/thermite/propagations",
    });
  } catch (err) {
    throw new Refusal(
      `the champion patch does not apply to the base: ${err instanceof GitError ? err.message : String(err)}`,
    );
  }
  const tree = await treeOf(mirror, rebuilt.commit);
  if (tree !== spec.tree) {
    await deleteRef(mirror, rebuilt.ref).catch(() => undefined);
    throw new Refusal(`tree mismatch: the signed tree is ${spec.tree}, the patch gives ${tree}`);
  }
  svc.ledger.imports.record({
    kind: "champion_patch",
    name: `${p.source_rig}/${p.source_run}/${p.source_seq}`,
    sha256: spec.sha256,
    commitSha: rebuilt.commit,
    sourcePath: spec.path,
    storedPath: stored,
    actor: by,
  });
  const champion = svc.ledger.champions.current(p.run);
  const source = {
    source_rig: p.source_rig,
    source_run: p.source_run,
    source_seq: p.source_seq,
    tree,
  };
  if ((await treeOf(mirror, champion.commit_sha)) === tree) {
    svc.ledger.appendEvent(by, "propagation_received", p.run, {
      ...source,
      attempt: null,
      result: "identical",
    });
    return { identical: true, note: "this rig's champion already has the same tree" };
  }
  const patch = await patchBytes(mirror, champion.commit_sha, rebuilt.commit);
  let r: SubmitResult;
  try {
    r = await svc.submitAttempt(
      {
        run: p.run,
        parent: champion.commit_sha,
        patch_base64: patch.toString("base64"),
        hypothesis: `Propagated: ${p.source_rig}'s champion (run ${p.source_run}, seq ${p.source_seq}), judged here against this rig's champion`,
        known_flaws: [],
      },
      by,
    );
  } finally {
    await deleteRef(mirror, rebuilt.ref).catch(() => undefined);
  }
  // The candidate judged here must be exactly the source champion's tree.
  const got = await treeOf(mirror, r.commit);
  if (got !== tree) {
    svc.ledger.attempts.setLifecycle(r.attempt, "errored", by);
    throw new Error(`the propagated attempt has tree ${got}, not ${tree}`);
  }
  svc.ledger.tx(() => {
    svc.ledger.propagations.add({
      attempt: r.attempt,
      run: p.run,
      sourceRig: p.source_rig,
      sourceRun: p.source_run,
      sourceSeq: p.source_seq,
      tree,
      at: new Date().toISOString(),
    });
    svc.ledger.appendEvent(by, "propagation_received", p.run, {
      ...source,
      attempt: r.attempt,
      lifecycle: r.lifecycle,
    });
  });
  settlePropagations(svc.ledger, by);
  return { attempt: r.attempt, lifecycle: r.lifecycle, tree };
}

/**
 * Records the outcome of propagated attempts once their judging is over: accepted (promoted
 * here, so the source champion is cross-verified) or rejected, with the verdict.
 */
export function settlePropagations(ledger: Ledger, by: string): number {
  // Open ones, and rejected ones whose attempt the owner promoted later (an audit override).
  const open = ledger.propagations
    .unsettledOrRejected()
    .filter(
      (r) =>
        r.result === null ||
        String(ledger.attempts.get(String(r.attempt))?.lifecycle) === "promoted",
    );
  let settled = 0;
  for (const row of open) {
    const attempt = String(row.attempt);
    const lifecycle = String(ledger.attempts.get(attempt)?.lifecycle);
    if (!SETTLED.has(lifecycle)) continue;
    const verdict = ledger.verdicts.current(attempt)?.verdict ?? lifecycle;
    const accepted = lifecycle === "promoted";
    ledger.tx(() => {
      ledger.propagations.settle(
        attempt,
        accepted ? "accepted" : `rejected:${verdict}`,
        new Date().toISOString(),
      );
      ledger.appendEvent(
        by,
        accepted ? "propagation_accepted" : "propagation_rejected",
        String(row.run),
        {
          attempt,
          source_rig: row.source_rig,
          source_run: row.source_run,
          source_seq: row.source_seq,
          tree: row.tree,
          verdict,
        },
      );
    });
    settled++;
  }
  return settled;
}

/**
 * The champion files an export publishes: for each run's current champion (beyond the
 * seed), the binary patch from the seed and a manifest with the tree and the patch's sha256.
 * Returns the files written (relative paths) and the publications to announce.
 */
export async function championFiles(input: {
  ledger: Ledger;
  mirrorFor: (repo: string) => string;
  write: (rel: string, data: string | Buffer) => void;
}): Promise<
  {
    run: string;
    seq: number;
    base_commit: string;
    tree: string;
    sha256: string;
    path: string;
  }[]
> {
  const out: {
    run: string;
    seq: number;
    base_commit: string;
    tree: string;
    sha256: string;
    path: string;
  }[] = [];
  for (const inst of input.ledger.runs.list()) {
    if (inst.mode === "research") continue;
    const champ = input.ledger.champions.current(inst.id);
    if (champ.seq <= 1 || !champ.attempt) continue;
    const published = input.ledger.events.newest("champion_published", {
      subject: inst.id,
      body: { seq: champ.seq },
    });
    if (published) continue;
    const mirror = input.mirrorFor(inst.seed_repo);
    const patch = await patchBytes(mirror, inst.seed_commit, champ.commit_sha);
    const tree = await treeOf(mirror, champ.commit_sha);
    const sha256 = sha256Hex(patch);
    const path = `champions/${inst.id}/${champ.seq}.patch`;
    input.write(path, patch);
    const manifest = {
      rig_run: inst.id,
      seq: champ.seq,
      repo: inst.seed_repo,
      base_commit: inst.seed_commit,
      commit: champ.commit_sha,
      tree,
      sha256,
      attempt: champ.attempt,
    };
    input.write(`champions/${inst.id}/${champ.seq}.json`, `${JSON.stringify(manifest)}\n`);
    out.push({
      run: inst.id,
      seq: champ.seq,
      base_commit: inst.seed_commit,
      tree,
      sha256,
      path,
    });
  }
  return out;
}
