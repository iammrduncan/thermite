import { createHash } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { ApiError } from "../common/api/call.ts";
import { controlClient } from "../common/api/control.ts";
import { log } from "../common/env.ts";
import { git as gitRun } from "../common/git.ts";
import { type GitAuth, gitHost, withGitAuth } from "../common/git-auth.ts";
import { GIT_ACCESS, gitRepoPath } from "../core/api/control/rigs.ts";
import type { SignedCommand } from "../core/commands.ts";
import { sshCommand } from "./git-export.ts";
import { downloadModel, ModelDownloads } from "./model-download.ts";

/**
 * Staging for commands that bring content, before the supervisor relays them:
 * - a `propagate` command names another rig's published champion (a patch in the results
 *   repository) and the inbox path the harness will read it from;
 * - an `assign_campaign` command's imports may name a source: a git repository with the
 *   project's or kit's commit, or a URL for a model. The supervisor fetches it into the inbox
 *   (a repository as a bundle of that commit; a model with its progress reported, see
 *   model-download.ts).
 * The supervisor cannot change what arrives: the harness checks the commit, the sha256 and the
 * tree the command signs. Fetches run in the background, and the command waits for them.
 * Deterministic code only: no model ever runs git here.
 */

export interface StagingConfig {
  rig: string;
  inboxDir: string;
  /** The supervisor's results repository (bare), the same one the exporter commits to. */
  resultsRepo: string;
  remote?: string | undefined;
  sshKeyFile?: string | undefined;
  knownHostsFile?: string | undefined;
  /** Where fetched git sources are kept between assignments (bare repositories). */
  sourcesDir?: string | undefined;
  /** Control's address and this rig's token: kits control keeps are fetched from there. */
  controlUrl?: string | undefined;
  controlToken?: string | undefined;
  /** Model downloads in progress, for the supervisor's report and the live view. */
  models?: ModelDownloads | undefined;
  /** The supervisor's Hugging Face token (gated models): sent to Hugging Face only. */
  hfToken?: string | undefined;
  /** How model files are fetched (tests give their own). */
  fetchImpl?: typeof fetch | undefined;
  /** The free space a model download leaves where it lands, in bytes (goal 173); none: 0. */
  floorBytes?: number | undefined;
  /**
   * Tests only: `file://` git sources, and model files at private or local addresses, are
   * fetched. Otherwise they are refused, in words.
   */
  localSources?: boolean | undefined;
}

/** What staging says about a command: relay it, wait, or report that its content failed. */
export type StageResult = "ready" | "wait" | { failed: string };

function sshEnv(cfg: StagingConfig): Record<string, string> {
  return sshCommand(cfg.sshKeyFile, cfg.knownHostsFile);
}

/** SSH for a source that names no Git access: no key, no agent, so none is ever offered. */
const NO_KEY_SSH =
  "ssh -o BatchMode=yes -o PubkeyAuthentication=no -o IdentityAgent=none -o StrictHostKeyChecking=accept-new";

const git = (repo: string, args: string[], env: Record<string, string> = {}) =>
  gitRun(["-C", repo, ...args], { env });

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** The kinds of command whose content the supervisor stages: it fetches something for them. */
const STAGED_KINDS: readonly string[] = ["assign_campaign", "propagate"];
/** Commands whose signature the harness has checked, by id: each is asked about once. */
const checked = new Set<string>();
/** At most this many are kept; past it, the set starts again. */
const CHECKED_MAX = 1000;

/**
 * A command's content staged only once control's signature on it is checked: `check` asks the
 * harness, which holds control's public key in every placement (the supervisor never chooses the
 * key it trusts), and answers why it refused it, or nothing. A command it refuses is never staged:
 * it goes on to the harness as it is, which refuses it again as it applies it, and its outcome
 * says why. Kinds with no content are relayed as they are.
 */
export async function stageSigned(
  cfg: StagingConfig,
  cmd: SignedCommand,
  check: (cmd: SignedCommand) => Promise<string | undefined>,
): Promise<StageResult> {
  if (!STAGED_KINDS.includes(cmd.envelope.kind)) return "ready";
  if (!checked.has(cmd.envelope.id)) {
    const refused = await check(cmd);
    if (refused) {
      log("supervisor", "a command's sources not staged: the harness refused it", {
        command: cmd.envelope.id,
        why: refused,
      });
      return "ready";
    }
    if (checked.size >= CHECKED_MAX) checked.clear();
    checked.add(cmd.envelope.id);
  }
  return await stageCommand(cfg, cmd);
}

/**
 * Makes a command's content available in the inbox. "ready": relay it now. "wait": the content
 * is not available yet (for example the source rig's export is not pushed), try again later.
 */
export async function stageCommand(cfg: StagingConfig, cmd: SignedCommand): Promise<StageResult> {
  if (cmd.envelope.kind === "assign_campaign") return stageSources(cfg, cmd);
  if (cmd.envelope.kind !== "propagate") return "ready";
  // Past its expiry the harness refuses it anyway: relay it so the refusal is acknowledged.
  if (Date.parse(cmd.envelope.expires_at) < Date.now()) return "ready";
  const p = cmd.envelope.payload as {
    source_rig?: string;
    source_run?: string;
    source_seq?: number;
    import?: { kind?: string; path?: string; sha256?: string };
  };
  const imp = p.import;
  if (imp?.kind !== "champion_patch" || !imp.path || !imp.sha256) return "ready";
  const root = resolve(cfg.inboxDir);
  const target = resolve(root, imp.path);
  if (!target.startsWith(root + sep)) return "ready"; // the harness refuses such a path
  if (existsSync(target) && sha256(readFileSync(target)) === imp.sha256) return "ready";
  const branch = `thermite/${p.source_rig}/attempts`;
  const file = `champions/${p.source_run}/${p.source_seq}.patch`;
  let rev = `refs/heads/${branch}`;
  try {
    if (cfg.remote && p.source_rig !== cfg.rig) {
      rev = `refs/remotes/results/${p.source_rig}/attempts`;
      await git(
        cfg.resultsRepo,
        ["fetch", "--quiet", cfg.remote, `+refs/heads/${branch}:${rev}`],
        sshEnv(cfg),
      );
    }
    const data = await git(cfg.resultsRepo, ["show", `${rev}:${file}`]);
    if (sha256(data) !== imp.sha256) {
      log("supervisor", "staged champion does not match the command; waiting", {
        command: cmd.envelope.id,
        file,
      });
      return "wait";
    }
    mkdirSync(dirname(target), { recursive: true });
    const tmp = join(dirname(target), `.tmp-${process.pid}-${Date.now()}`);
    writeFileSync(tmp, data, { mode: 0o644 });
    renameSync(tmp, target);
    log("supervisor", "staged a champion for propagation", { command: cmd.envelope.id, file });
    return "ready";
  } catch (err) {
    log("supervisor", "champion not available yet; waiting", {
      command: cmd.envelope.id,
      file,
      error: err instanceof Error ? err.message.slice(0, 300) : String(err),
    });
    return "wait";
  }
}

// ------------------------------------------------------------------ sources by reference

type Sourced =
  | {
      kind: "repo_bundle" | "kit_bundle";
      path: string;
      commit: string;
      source: { git: string; access?: string } | { control: string };
    }
  | { kind: "model"; path: string; name: string; sha256: string; source: { url: string } };

/** Stagings in progress, and finished ones not yet reported, by command id. */
const inFlight = new Map<string, Promise<StageResult>>();
const finished = new Map<string, StageResult>();
/** Models already checked in the inbox (path, size and time), so a big file is hashed once. */
const verified = new Set<string>();

async function stageSources(cfg: StagingConfig, cmd: SignedCommand): Promise<StageResult> {
  if (Date.parse(cmd.envelope.expires_at) < Date.now()) return "ready";
  const id = cmd.envelope.id;
  const done = finished.get(id);
  if (done) {
    finished.delete(id);
    return done;
  }
  if (inFlight.has(id)) return "wait";
  const imports = ((cmd.envelope.payload as { imports?: unknown[] }).imports ?? []) as Sourced[];
  const root = resolve(cfg.inboxDir);
  const todo: { imp: Sourced; target: string }[] = [];
  for (const imp of imports) {
    if (!imp?.source) continue;
    const target = resolve(root, imp.path);
    if (!target.startsWith(root + sep)) continue; // the harness refuses such a path
    if (!(await present(imp, target))) todo.push({ imp, target });
  }
  if (!todo.length) return "ready";
  const run = (cmd.envelope.payload as { run?: unknown }).run;
  const work = (async (): Promise<StageResult> => {
    try {
      for (const { imp, target } of todo) {
        if (imp.kind === "model")
          await downloadModel({
            url: imp.source.url,
            sha256: imp.sha256,
            target,
            path: relative(root, target),
            name: imp.name,
            run: typeof run === "string" ? run : undefined,
            hfToken: cfg.hfToken,
            downloads: cfg.models ?? new ModelDownloads(),
            fetchImpl: cfg.fetchImpl,
            allowPrivate: cfg.localSources,
            floor: cfg.floorBytes,
          });
        else await bundleFromGit(cfg, imp, target);
      }
      log("supervisor", "staged sources", { command: id, files: todo.map((t) => t.imp.path) });
      return "ready";
    } catch (err) {
      const error = err instanceof Error ? err.message.slice(0, 500) : String(err);
      log("supervisor", "staging failed", { command: id, error }, "error");
      return { failed: `staging: ${error}` };
    }
  })();
  inFlight.set(id, work);
  void work.then((r) => {
    inFlight.delete(id);
    finished.set(id, r);
  });
  return "wait";
}

async function present(imp: Sourced, target: string): Promise<boolean> {
  if (!existsSync(target)) return false;
  // A bundle is checked by the harness (it must hold the commit); a model by its hash, here
  // once, so a wrong file is replaced rather than relayed.
  if (imp.kind !== "model") return true;
  const st = statSync(target);
  const key = `${target}\0${st.size}\0${st.mtimeMs}`;
  if (verified.has(key)) return true;
  const h = createHash("sha256");
  await pipeline(createReadStream(target), h);
  if (h.digest("hex") !== imp.sha256) return false;
  verified.add(key);
  return true;
}

/**
 * A repository's commit as a bundle: fetched into a bare cache kept per source, then bundled
 * from a ref at that commit (with its history, so the harness can import it alone).
 */
async function bundleFromGit(
  cfg: StagingConfig,
  imp: Extract<Sourced, { kind: "repo_bundle" | "kit_bundle" }>,
  target: string,
): Promise<void> {
  // A kit control keeps comes from control, as this rig, over plain HTTP(S); the token goes in
  // a header and only to control's own address.
  const fromControl = "control" in imp.source;
  if (fromControl && (!cfg.controlUrl || !cfg.controlToken))
    throw new Error(`${imp.path}: a kit from control, but this supervisor has no control to ask`);
  const url =
    "control" in imp.source
      ? `${cfg.controlUrl}${gitRepoPath(cfg.rig, imp.source.control)}`
      : imp.source.git;
  if (!fromControl && /^file:/i.test(url) && !cfg.localSources)
    throw new Error(`${imp.path}: a file:// source is refused: a source is a repository on a host`);
  const dir = cfg.sourcesDir ?? join(dirname(cfg.resultsRepo), "sources");
  const cache = join(dir, `${createHash("sha256").update(url).digest("hex").slice(0, 16)}.git`);
  if (!existsSync(join(cache, "HEAD"))) {
    mkdirSync(cache, { recursive: true });
    await git(cache, ["init", "--quiet", "--bare"]);
  }
  // Never git's ext:: or other command transports: a URL in a command only names a repository.
  // A source that names no Git access is fetched with no key: never the results repository's.
  const env: Record<string, string> = fromControl
    ? {
        GIT_ALLOW_PROTOCOL: "http:https",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Bearer ${cfg.controlToken}`,
      }
    : {
        GIT_SSH_COMMAND: NO_KEY_SSH,
        GIT_ALLOW_PROTOCOL: cfg.localSources ? "https:ssh:git:file" : "https:ssh:git",
      };
  const has = () =>
    git(cache, ["cat-file", "-e", `${imp.commit}^{commit}`]).then(
      () => true,
      () => false,
    );
  const fetchWith = async (e: Record<string, string>) => {
    if (await has()) return;
    // The commit by its id first (most servers allow a reachable one), then all branches and tags.
    await git(cache, ["fetch", "--quiet", "--no-tags", url, imp.commit], e).catch(() =>
      git(cache, ["fetch", "--quiet", "--tags", url, "+refs/heads/*:refs/sources/heads/*"], e),
    );
  };
  // A private repository: the Git access its campaign names, handed by control for this fetch.
  const access = "git" in imp.source ? imp.source.access : undefined;
  if (access) {
    // Used only on the host control bound it to.
    const { auth, host } = await gitAccessFromControl(cfg, access);
    const from = gitHost(url);
    if (from !== host)
      throw new Error(
        `Git access ${access} is for ${host} only, and ${imp.path} comes from ${from ?? "an address with no host"}`,
      );
    await withGitAuth(auth, join(dirname(dir), "known_hosts", access), (g) =>
      fetchWith({ ...g.env, GIT_ALLOW_PROTOCOL: g.protocols }),
    );
  } else await fetchWith(env);
  if (!(await has())) throw new Error(`${url} has no commit ${imp.commit}`);
  const ref = `refs/thermite/stage/${imp.commit}`;
  await git(cache, ["update-ref", ref, imp.commit]);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    await git(cache, ["bundle", "create", tmp, ref]);
    chmodSync(tmp, bundleMode(cfg.inboxDir));
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * A bundle's mode: its owner and the inbox's group read it, and other users only where the inbox
 * lets them in. Where the inbox is closed to others, its group is the harness's controller's (the
 * one-container image, a cluster's volume), and the bundle is 0640. Under compose and on a machine,
 * the controller reads the inbox as another user, in a folder of the harness image that only it
 * may enter, and the bundle is 0644.
 */
function bundleMode(inboxDir: string): number {
  return statSync(inboxDir).mode & 0o004 ? 0o644 : 0o640;
}

/**
 * Git access by name, from control, with the host it is for: only while a live assignment of this
 * rig names it.
 */
async function gitAccessFromControl(
  cfg: StagingConfig,
  name: string,
): Promise<{ auth: GitAuth; host: string }> {
  if (!cfg.controlUrl || !cfg.controlToken)
    throw new Error(`Git access ${name}: this supervisor has no control to ask`);
  const control = controlClient({ url: cfg.controlUrl, token: cfg.controlToken, rig: cfg.rig });
  const g = await control.call(GIT_ACCESS, { params: { name } }).catch((err: unknown) => {
    const answered = err instanceof ApiError && err.status !== undefined;
    throw answered ? new Error(`Git access ${name}: control answered ${err.status}`) : err;
  });
  if (!g.host) throw new Error(`Git access ${name}: control's answer names no host`);
  if (g.kind === "ssh" && g.private_key)
    return { auth: { kind: "ssh", privateKey: g.private_key }, host: g.host };
  if (g.kind === "token" && g.token)
    return { auth: { kind: "token", token: g.token, username: g.username }, host: g.host };
  throw new Error(`Git access ${name}: control's answer has no key`);
}
