import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type GitAuth, gitHost, gitText, onGitHost, withGitAuth } from "../common/git/index.ts";
import type { RunResults, SignedCommand } from "../core/commands.ts";
import { commitFiles, verifyExport } from "./git-export.ts";

/**
 * A run's work in git (goal 185). A run whose assignment says where (`results`) has its
 * supervisor push two kinds of branch there after each export, beside the results repository's:
 *
 *   thermite/<run>/champion  the run's starting commit, then a commit for each champion: the
 *                            start's tree with the champion's patch applied (checked against the
 *                            tree the rig published), each on the one before
 *   thermite/<run>/<lane>    the lane's attempts as patches, a commit for each: README.md, and
 *                            attempts/<nnn>-<attempt>.patch with what it tried and its verdict
 *                            in a .json beside it
 *
 * A project in one folder of its repository has the champion's tree put back in the project's
 * commit at that folder, so the champion branch holds the whole repository. Pushes are
 * fast-forwards of branches under `thermite/<run>/` only, with the Git access the assignment names,
 * on the host control bound it to. Deterministic code only: no model ever runs git here.
 */

export interface RunBranchesConfig {
  /** The supervisor's results repository (bare), where the exporter commits: it holds the commits. */
  repo: string;
  outboxDir: string;
  /** Where staging keeps each fetched source (staging.ts): the run's start commit is there. */
  sourcesDir: string;
  /** A Git access by name, with the host it is for, from the rig's config on the message bus. */
  gitAccess: (name: string) => Promise<{ auth: GitAuth; host: string }>;
  /** Tests only: a file:// remote is pushed to. */
  localRemotes?: boolean | undefined;
}

/** One run's branches: where they go, where the run started, and what is made and pushed. */
interface RunGit {
  git: string;
  access?: string | undefined;
  /** The project's repository the run fetched, its commit, and its folder when it is one. */
  source: string;
  commit: string;
  folder?: string | undefined;
  /** Each champion's commit on the champion branch, by its number. */
  champions: Record<string, string>;
  /** Each lane's branch tip. */
  lanes: Record<string, string>;
  /** Commits made here that the remote does not have yet. */
  pending: boolean;
  pushedAt?: string | undefined;
  error?: string | undefined;
}

export interface RunBranchesState {
  runs: Record<string, RunGit>;
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "thermite",
  GIT_AUTHOR_EMAIL: "thermite@localhost",
  GIT_COMMITTER_NAME: "thermite",
  GIT_COMMITTER_EMAIL: "thermite@localhost",
};

const git = (repo: string, args: string[], env: Record<string, string> = {}) =>
  gitText(["-C", repo, ...args], { env: { ...IDENTITY, ...env } }).then((s) => s.trim());

/** A branch of the run's: under `thermite/<run>/` only. */
export const championBranch = (run: string) => `thermite/${run}/champion`;
const laneBranch = (run: string, lane: string | null) =>
  `thermite/${run}/${(lane ?? "by-hand").toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`;

/** Where staging keeps a source fetched from `url` (staging.ts). */
export const sourceCache = (sourcesDir: string, url: string) =>
  join(sourcesDir, `${createHash("sha256").update(url).digest("hex").slice(0, 16)}.git`);

/**
 * A run's branches from its assignment, when it says where its work goes: the repository it
 * started from, its commit, and its folder. Undefined for a run whose work stays on control.
 */
export function runGitOf(cmd: SignedCommand): { run: string; git: RunGit } | undefined {
  if (cmd.envelope.kind !== "assign_campaign") return undefined;
  const p = cmd.envelope.payload as {
    run?: string;
    seed?: { repo: string; commit: string };
    results?: RunResults;
    imports?: { kind: string; repo?: string; commit?: string; source?: { git?: string } }[];
  };
  if (!p.run || !p.results || !p.seed) return undefined;
  const seed = p.seed;
  const from = (p.imports ?? []).find(
    (i) => i.kind === "repo_bundle" && i.repo === seed.repo && i.commit === seed.commit,
  )?.source?.git;
  if (!from) return undefined;
  return {
    run: p.run,
    git: {
      git: p.results.git,
      ...(p.results.access ? { access: p.results.access } : {}),
      source: from,
      commit: seed.commit,
      ...(p.results.folder ? { folder: p.results.folder } : {}),
      champions: { "1": seed.commit },
      lanes: {},
      pending: false,
    },
  };
}

/** The tree `root` with the tree at `folder` (a/b/c) replaced by `tree`, built bottom up. */
async function graft(repo: string, root: string, folder: string, tree: string): Promise<string> {
  const parts = folder.split("/");
  const at = async (base: string, i: number): Promise<string> => {
    const name = parts[i] as string;
    const listing = await git(repo, ["ls-tree", base]);
    const entries = listing ? listing.split("\n") : [];
    let inner = tree;
    if (i < parts.length - 1) {
      const sub = entries.find((e) => e.endsWith(`\t${name}`) && e.includes(" tree "));
      if (!sub) throw new Error(`the run's folder ${folder} is not in its start commit`);
      inner = await at(sub.split(" ")[2]?.split("\t")[0] as string, i + 1);
    }
    const kept = entries.filter((e) => !e.endsWith(`\t${name}`));
    const input = [...kept, `040000 tree ${inner}\t${name}`].join("\n");
    return gitText(["-C", repo, "mktree"], { input: `${input}\n` }).then((s) => s.trim());
  };
  return at(root, 0);
}

/** A champion's commit on the branch: the start's tree and the champion's patch, checked. */
async function championCommit(
  repo: string,
  g: RunGit,
  run: string,
  seq: number,
  patch: string,
  manifest: { tree?: string; attempt?: string },
  parent: string,
  hypothesis: string | undefined,
): Promise<string> {
  const start = g.folder ? `${g.commit}:${g.folder}` : `${g.commit}^{tree}`;
  const index = join(repo, `index-branch-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: index };
  let tree: string;
  try {
    await git(repo, ["read-tree", start], env);
    await git(repo, ["apply", "--cached", "--whitespace=nowarn", patch], env);
    tree = await git(repo, ["write-tree"], env);
  } finally {
    rmSync(index, { force: true });
  }
  if (manifest.tree && tree !== manifest.tree)
    throw new Error(
      `champion #${seq}'s patch on the run's start gives tree ${tree}, not the ${manifest.tree} the rig published`,
    );
  const root = g.folder
    ? await graft(repo, await git(repo, ["rev-parse", `${g.commit}^{tree}`]), g.folder, tree)
    : tree;
  const message = [
    `Champion #${seq} of ${run}${hypothesis ? `: ${hypothesis.split("\n")[0]?.slice(0, 120)}` : ""}`,
    "",
    `Thermite's run ${run} confirmed this change and promoted it as champion #${seq}${manifest.attempt ? ` (attempt ${manifest.attempt})` : ""}.`,
  ].join("\n");
  return git(repo, ["commit-tree", root, "-p", parent, "-m", message]);
}

/** Lets the results repository read a source's objects without copying them. */
function borrow(repo: string, cache: string): void {
  const file = join(repo, "objects", "info", "alternates");
  const line = join(cache, "objects");
  const have = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  if (have.includes(line)) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${line}\n`);
}

type Json = Record<string, unknown>;
const readJson = (path: string): Json => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Json;
  } catch {
    return {};
  }
};

/**
 * The branches of each run an export names, made from its champions' and attempts' files: what
 * the exports `names` hold, in order. A run's failure is its `error`, and its other runs go on.
 */
export async function buildRunBranches(
  cfg: RunBranchesConfig,
  state: RunBranchesState,
  names: readonly string[],
): Promise<RunBranchesState> {
  const runs = structuredClone(state.runs);
  for (const name of names) {
    const dir = join(cfg.outboxDir, name);
    const { manifest } = verifyExport(dir);
    if (!manifest) continue;
    const files = Object.keys(manifest.files);
    // Each attempt's hypothesis, for its champion's commit message.
    const hypotheses = new Map<string, string>();
    const attempts: { id: string; run: string; lane: string | null; json: Json }[] = [];
    for (const f of files) {
      const m = /^attempts\/([^/]+)\.json$/.exec(f);
      if (!m) continue;
      const json = readJson(join(dir, f));
      const a = (json.attempt ?? {}) as Json;
      if (typeof a.hypothesis === "string") hypotheses.set(m[1] as string, a.hypothesis);
      if (typeof a.run === "string" && runs[a.run])
        attempts.push({
          id: m[1] as string,
          run: a.run,
          lane: typeof a.lane === "string" ? a.lane : null,
          json,
        });
    }
    for (const [run, g] of Object.entries(runs)) {
      try {
        const seqs = files
          .flatMap((f) => {
            const m = new RegExp(`^champions/${run.replace(/[.]/g, "\\.")}/(\\d+)\\.patch$`).exec(
              f,
            );
            return m ? [Number(m[1])] : [];
          })
          .sort((a, b) => a - b);
        const newest = Math.max(...Object.keys(g.champions).map(Number));
        for (const seq of seqs.filter((s) => s > newest)) {
          borrow(cfg.repo, sourceCache(cfg.sourcesDir, g.source));
          const ref = `refs/heads/${championBranch(run)}`;
          const tip = await git(cfg.repo, ["rev-parse", "--verify", "--quiet", ref]).catch(
            () => "",
          );
          const parent = tip || g.commit;
          const m = readJson(join(dir, "champions", run, `${seq}.json`)) as {
            tree?: string;
            attempt?: string;
          };
          const commit = await championCommit(
            cfg.repo,
            g,
            run,
            seq,
            join(dir, "champions", run, `${seq}.patch`),
            m,
            parent,
            m.attempt ? hypotheses.get(m.attempt) : undefined,
          );
          await git(cfg.repo, ["update-ref", ref, commit, ...(tip ? [tip] : [])]);
          g.champions[String(seq)] = commit;
          g.pending = true;
        }
        for (const a of attempts.filter((x) => x.run === run)) {
          const branch = laneBranch(run, a.lane);
          const tip = g.lanes[branch];
          const listed = tip
            ? (await git(cfg.repo, ["ls-tree", "--name-only", `${tip}:attempts`]).catch(() => ""))
                .split("\n")
                .filter(Boolean)
            : [];
          if (listed.some((n) => n.endsWith(`-${a.id}.patch`))) continue;
          const n = String(listed.filter((x) => x.endsWith(".patch")).length + 1).padStart(3, "0");
          const add: Record<string, string> = {
            [`attempts/${n}-${a.id}.patch`]: join(dir, "attempts", `${a.id}.patch`),
            [`attempts/${n}-${a.id}.json`]: join(dir, "attempts", `${a.id}.json`),
          };
          if (!tip) add["README.md"] = readme(run, branch, cfg.repo);
          g.lanes[branch] = await commitFiles(
            cfg.repo,
            branch,
            add,
            `${a.id} of ${run}${hypotheses.get(a.id) ? `: ${hypotheses.get(a.id)?.split("\n")[0]?.slice(0, 120)}` : ""}`,
          );
          g.pending = true;
        }
        if (g.error && !g.error.startsWith("push")) g.error = undefined;
      } catch (err) {
        g.error = err instanceof Error ? err.message.slice(0, 500) : String(err);
      }
    }
  }
  return { runs };
}

/** A lane branch's README, written once beside the results repository, for its first commit. */
function readme(run: string, branch: string, repo: string): string {
  const dir = join(dirname(repo), "run-branches");
  const path = join(dir, `${createHash("sha256").update(branch).digest("hex").slice(0, 12)}.md`);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(path))
    appendFileSync(
      path,
      [
        `# ${branch}`,
        "",
        `One lane of Thermite's run ${run}: each attempt the lane made, in order, as a patch.`,
        "",
        "- `attempts/<nnn>-<attempt>.patch`: the change, against its parent commit.",
        "- `attempts/<nnn>-<attempt>.json`: the attempt as the rig recorded it (its parent commit, what it tried) and its verdict.",
        "",
        `A champion's code is a commit on thermite/${run}/champion: check it out, or start a new campaign from it.`,
        "",
      ].join("\n"),
    );
  return path;
}

/**
 * Pushes each run's branches that the remote does not have yet, with the run's Git access, as
 * fast-forwards: a branch the remote has with other history is refused, and the run says why.
 */
export async function pushRunBranches(
  cfg: RunBranchesConfig,
  state: RunBranchesState,
): Promise<RunBranchesState> {
  const runs = structuredClone(state.runs);
  for (const [run, g] of Object.entries(runs)) {
    if (!g.pending) continue;
    const refs = [championBranch(run), ...Object.keys(g.lanes)];
    const have: string[] = [];
    for (const b of refs)
      if (
        await git(cfg.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]).catch(() => "")
      )
        have.push(`refs/heads/${b}:refs/heads/${b}`);
    if (!have.length) continue;
    try {
      if (/^file:/i.test(g.git) && !cfg.localRemotes)
        throw new Error("a file:// address is refused: the branches go to a repository on a host");
      const push = (env: Record<string, string>) =>
        git(cfg.repo, ["push", "--quiet", g.git, ...have], env);
      if (g.access) {
        const { auth, host } = await cfg.gitAccess(g.access);
        if (!onGitHost(g.git, host))
          throw new Error(
            `Git access ${g.access} is for ${host} only, and the run's branches go to ${gitHost(g.git) ?? "an address with no host"}`,
          );
        await withGitAuth(auth, join(dirname(cfg.repo), "known_hosts", g.access), (a) =>
          push({ ...a.env, GIT_ALLOW_PROTOCOL: a.protocols }),
        );
      } else
        await push({
          GIT_ALLOW_PROTOCOL: cfg.localRemotes ? "https:ssh:git:file" : "https:ssh:git",
        });
      g.pending = false;
      g.pushedAt = new Date().toISOString();
      g.error = undefined;
    } catch (err) {
      g.error = `push failed: ${err instanceof Error ? err.message.slice(0, 400) : String(err)}`;
    }
  }
  return { runs };
}

/** The run branches of this supervisor, kept in a file of its home across restarts. */
export class RunBranches {
  private state: RunBranchesState;
  private readonly path: string;
  private readonly cfg: RunBranchesConfig;
  constructor(path: string, cfg: RunBranchesConfig) {
    this.path = path;
    this.cfg = cfg;
    this.state = loadState(path);
  }

  /** An assignment the harness took: its run's branches, when it says where they go. */
  assigned(cmd: SignedCommand): void {
    const r = runGitOf(cmd);
    if (!r || this.state.runs[r.run]) return;
    this.state.runs[r.run] = r.git;
    this.save();
  }

  /** The branches from the exports just made, then a push of what the remotes lack. */
  async afterExport(fresh: readonly string[]): Promise<void> {
    if (!Object.keys(this.state.runs).length) return;
    const before = JSON.stringify(this.state);
    if (fresh.length) this.state = await buildRunBranches(this.cfg, this.state, fresh);
    this.state = await pushRunBranches(this.cfg, this.state);
    if (JSON.stringify(this.state) !== before) this.save();
  }

  /** Each run's branches for the supervisor's report: where, each champion's commit, the lanes. */
  figures(): Record<string, RunBranchesFigure> {
    return Object.fromEntries(
      Object.entries(this.state.runs).map(([run, g]) => [
        run,
        {
          git: g.git,
          branch: championBranch(run),
          champions: g.champions,
          lanes: g.lanes,
          waiting: g.pending,
          pushed_at: g.pushedAt ?? null,
          error: g.error ?? null,
        },
      ]),
    );
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(this.state)}\n`);
  }
}

/** One run's branches in the supervisor's report. */
interface RunBranchesFigure {
  git: string;
  branch: string;
  champions: Record<string, string>;
  lanes: Record<string, string>;
  waiting: boolean;
  pushed_at: string | null;
  error: string | null;
}

function loadState(path: string): RunBranchesState {
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as RunBranchesState;
    return s && typeof s.runs === "object" ? s : { runs: {} };
  } catch {
    return { runs: {} };
  }
}
