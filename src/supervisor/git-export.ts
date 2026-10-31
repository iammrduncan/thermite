import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { shellQuote } from "../common/exec.ts";
import { gitText } from "../common/git.ts";

/**
 * The supervisor's git exporter. The harness writes exports into the outbox (read-only here):
 * patches and manifests of new attempts, the events since the last export, and a ledger
 * snapshot. This turns each verified export into packed commits on a few branches of the
 * results repository, without a checkout:
 *
 *   thermite/<rig>/attempts  attempts/<id>.patch, attempts/<id>.json, events/<export>.jsonl,
 *                            champions/<run>/<seq>.patch and .json
 *   thermite/<rig>/ledger    ledger.sqlite and its manifest (at most once per ledgerEveryMs)
 *
 * and pushes them with the rig's deploy key. Git work is deterministic code only; no model
 * ever runs git here.
 */

export interface ExportConfig {
  rig: string;
  outboxDir: string;
  workDir: string;
  /** The results repository (an SSH URL in production, a file URL in tests). Unset: commit only. */
  remote?: string | undefined;
  /** Deploy key for the remote (write access to the results repository only). */
  sshKeyFile?: string | undefined;
  /** The results host's key (known_hosts); without it the first key seen is trusted. */
  knownHostsFile?: string | undefined;
  ledgerEveryMs?: number | undefined;
}

export interface ExportState {
  done: string[];
  /** Commits made since the last successful push (a push is retried until it succeeds). */
  pushPending?: boolean | undefined;
  /** Exports committed here but not yet pushed to the remote. */
  unpushed?: string[] | undefined;
  /** The newest exports known to be on the remote (a full reset waits for its export here). */
  pushed?: string[] | undefined;
  /** The attempts branch commit the last push left on the remote. */
  pushedCommit?: string | undefined;
  lastLedgerAt?: string | undefined;
  lastPushAt?: string | undefined;
  lastError?: string | undefined;
}

/** The results repository's identity: who commits the exports. */
const IDENTITY = {
  GIT_AUTHOR_NAME: "thermite",
  GIT_AUTHOR_EMAIL: "thermite@localhost",
  GIT_COMMITTER_NAME: "thermite",
  GIT_COMMITTER_EMAIL: "thermite@localhost",
};

async function git(
  repo: string,
  args: string[],
  opts: { env?: Record<string, string> } = {},
): Promise<string> {
  return (await gitText(["-C", repo, ...args], { env: { ...IDENTITY, ...opts.env } })).trim();
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** A single-quoted shell word (GIT_SSH_COMMAND is run by a shell). */

/** The ssh command for the results remote: the deploy key, and the host's key when pinned. */
export function sshCommand(keyFile?: string, knownHostsFile?: string): Record<string, string> {
  if (!keyFile) return {};
  const hostKey = knownHostsFile
    ? `-o UserKnownHostsFile=${shellQuote(knownHostsFile)} -o StrictHostKeyChecking=yes`
    : "-o StrictHostKeyChecking=accept-new";
  return { GIT_SSH_COMMAND: `ssh -i ${shellQuote(keyFile)} -o IdentitiesOnly=yes ${hostKey}` };
}

const Manifest = z.object({
  from_event: z.number().int().min(0),
  through_event: z.number().int().min(0),
  full: z.boolean().optional(),
  /** A run's export (goal 103): that run alone, with its research folder and fetched pages. */
  run: z.string().min(1).optional(),
  files: z.record(
    z.string().regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._()-]+)*$/),
    z.string().regex(/^[0-9a-f]{64}$/),
  ),
});
export type Manifest = z.infer<typeof Manifest>;

/** A path in the export that is a regular file (never a link, a directory or a device). */
function regularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Checks an export against its manifest: every listed file is a regular file with the listed
 * hash, the events and the manifest are there, and nothing unsafe is named. Returns the
 * problems and the manifest when it is valid.
 */
export function verifyExport(dir: string): { problems: string[]; manifest?: Manifest } {
  const manifestPath = join(dir, "manifest.json");
  if (!regularFile(manifestPath)) return { problems: ["no manifest (or not a regular file)"] };
  let manifest: Manifest;
  try {
    manifest = Manifest.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  } catch (err) {
    return { problems: [`bad manifest: ${String(err).slice(0, 200)}`] };
  }
  const bad: string[] = [];
  if (!manifest.files["events.jsonl"]) bad.push("events.jsonl is not in the manifest");
  for (const [rel, sum] of Object.entries(manifest.files)) {
    if (rel.split("/").includes("..")) bad.push(`unsafe path ${rel}`);
    else if (!regularFile(join(dir, rel))) bad.push(`missing or not a regular file: ${rel}`);
    else if (sha256(join(dir, rel)) !== sum) bad.push(`hash mismatch ${rel}`);
  }
  return bad.length ? { problems: bad } : { problems: [], manifest };
}

/** Adds files (path in tree -> file on disk) on top of a branch and commits. */
async function commitFiles(
  repo: string,
  branch: string,
  files: Record<string, string>,
  message: string,
  opts: { overwrite?: boolean } = {},
): Promise<string> {
  const ref = `refs/heads/${branch}`;
  const tip = await git(repo, ["rev-parse", "--verify", "--quiet", ref]).catch(() => "");
  const index = join(repo, `index-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    if (tip) await git(repo, ["read-tree", tip], { env });
    else await git(repo, ["read-tree", "--empty"], { env });
    for (const [path, file] of Object.entries(files)) {
      // Published history is kept: an attempt, champion or source already on the branch is
      // never replaced by a later export.
      if (tip && !opts.overwrite) {
        const exists = await git(repo, ["cat-file", "-e", `${tip}:${path}`])
          .then(() => true)
          .catch(() => false);
        if (exists) continue;
      }
      const blob = await git(repo, ["hash-object", "-w", "--", file]);
      await git(repo, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
    }
    const tree = await git(repo, ["write-tree"], { env });
    const commit = await git(repo, [
      "commit-tree",
      tree,
      ...(tip ? ["-p", tip] : []),
      "-m",
      message,
    ]);
    await git(repo, ["update-ref", ref, commit, ...(tip ? [tip] : [])]);
    return commit;
  } finally {
    rmSync(index, { force: true });
  }
}

export async function exportOnce(cfg: ExportConfig, state: ExportState): Promise<ExportState> {
  const repo = join(cfg.workDir, "results.git");
  if (!existsSync(join(repo, "HEAD"))) {
    mkdirSync(repo, { recursive: true });
    await git(repo, ["init", "--bare", "--quiet"]);
  }
  const done = new Set(state.done);
  const pending = existsSync(cfg.outboxDir)
    ? readdirSync(cfg.outboxDir)
        .filter((n) => !n.startsWith(".") && !done.has(n))
        .sort()
    : [];
  const next: ExportState = { ...state, done: [...state.done] };
  const attemptsBranch = `thermite/${cfg.rig}/attempts`;
  const ledgerBranch = `thermite/${cfg.rig}/ledger`;
  // A new or wiped supervisor home continues the results repository's history, so its pushes
  // stay fast-forwards.
  if (cfg.remote && pending.length) {
    for (const b of [attemptsBranch, ledgerBranch]) {
      const have = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]).catch(
        () => "",
      );
      if (have) continue;
      await git(repo, ["fetch", "--quiet", cfg.remote, `+refs/heads/${b}:refs/heads/${b}`], {
        env: sshCommand(cfg.sshKeyFile, cfg.knownHostsFile),
      }).catch(() => undefined);
    }
  }
  for (const name of pending) {
    const dir = join(cfg.outboxDir, name);
    const { problems, manifest } = verifyExport(dir);
    if (!manifest) {
      next.lastError = `export ${name} refused: ${problems.join("; ")}`;
      next.done.push(name); // never retried: a corrupt export is reported, not pushed
      continue;
    }
    const files: Record<string, string> = {
      [`events/${name}.jsonl`]: join(dir, "events.jsonl"),
      [`exports/${name}.json`]: join(dir, "manifest.json"),
    };
    for (const rel of Object.keys(manifest.files)) {
      // The runs' field notes, research notes, briefings and part of their campaigns' folders
      // since the last export (goal 065), one file per export beside its events.
      const per = /^(journal|research-notes|briefing|knowledge)\.jsonl$/.exec(rel);
      if (per) files[`${per[1]}/${name}.jsonl`] = join(dir, rel);
      // The prompts the runs' agents were sent since then (goal 166), compressed.
      if (rel === "prompts.jsonl.gz") files[`prompts/${name}.jsonl.gz`] = join(dir, rel);
      // Attempts, and published champions (what other rigs fetch to judge them themselves).
      if (
        rel.startsWith("attempts/") ||
        rel.startsWith("champions/") ||
        // A finished run's research folder (its report, claims, findings, notes and sources).
        /^research\/[^/]+\/folder\//.test(rel) ||
        // A full export's research archive (kept before a full reset), and a run's export's
        // research folder and fetched pages.
        ((manifest.full || manifest.run) && rel.startsWith("research/"))
      )
        files[rel] = join(dir, rel);
    }
    const attempts = Object.keys(files).filter((f) => f.endsWith(".patch")).length;
    await commitFiles(
      repo,
      attemptsBranch,
      files,
      `${cfg.rig}: export ${name}, ${attempts} attempts, events ${manifest.from_event + 1}-${manifest.through_event}`,
    );
    // A full export's ledger snapshot is always kept: a full reset wipes the ledger after it.
    const due =
      manifest.full === true ||
      !next.lastLedgerAt ||
      Date.now() - Date.parse(next.lastLedgerAt) >= (cfg.ledgerEveryMs ?? 24 * 3_600_000);
    if (due && manifest.files["ledger.sqlite"]) {
      await commitFiles(
        repo,
        ledgerBranch,
        {
          "ledger.sqlite": join(dir, "ledger.sqlite"),
          "manifest.json": join(dir, "manifest.json"),
        },
        `${cfg.rig}: ledger snapshot through event ${manifest.through_event}`,
        { overwrite: true },
      );
      next.lastLedgerAt = new Date().toISOString();
    }
    next.done.push(name);
    next.unpushed = [...(next.unpushed ?? []), name];
    next.pushPending = true;
  }
  next.done = next.done.slice(-5000);

  // A local results repository (compose): created on first use.
  if (cfg.remote?.startsWith("file://")) {
    const path = new URL(cfg.remote).pathname;
    if (!existsSync(join(path, "HEAD"))) {
      mkdirSync(path, { recursive: true });
      await git(path, ["init", "--bare", "--quiet"]);
    }
  }
  if (cfg.remote && next.pushPending) {
    const branches = [attemptsBranch, ledgerBranch];
    const have: string[] = [];
    for (const b of branches) {
      if (
        await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]).catch(() => "")
      ) {
        have.push(`refs/heads/${b}:refs/heads/${b}`);
      }
    }
    const sshEnv = sshCommand(cfg.sshKeyFile, cfg.knownHostsFile);
    try {
      if (have.length) await git(repo, ["push", "--quiet", cfg.remote, ...have], { env: sshEnv });
      next.lastPushAt = new Date().toISOString();
      next.pushed = [...(next.pushed ?? []), ...(next.unpushed ?? [])].slice(-50);
      next.unpushed = [];
      next.pushPending = false;
      // What the remote now has: the owner can check this commit before confirming a wipe.
      next.pushedCommit =
        (await git(repo, [
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/heads/${attemptsBranch}`,
        ]).catch(() => "")) || undefined;
      if (next.lastError?.startsWith("push")) next.lastError = undefined;
    } catch (err) {
      next.lastError = `push failed: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`;
    }
  }
  return next;
}
