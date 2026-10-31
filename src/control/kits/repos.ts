import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { gitSync, gitText } from "../../common/git.ts";
import { KIT_BUNDLE_MAX } from "../../core/api/control/owner.ts";
import { ID_PATTERN } from "../../core/contract.ts";
import { KitSchema } from "../../core/kit.ts";

/**
 * Kits control keeps (described on the new-campaign page, uploaded, or added as a git bundle of a
 * kit repository written elsewhere) are bare git repositories in control's state directory, one
 * per kit, served to rigs over git's plain ("dumb") HTTP protocol behind the rig's token. A rig's
 * supervisor fetches a kit like any git source, by commit, and the harness checks that commit as
 * it does any import. A kit's head is its `main` branch.
 */

/** A kit's name, as the kit's schema takes it. */
const NAME = ID_PATTERN;

/** The largest kit bundle control takes (its home: core/api/control/owner.ts). */
export { KIT_BUNDLE_MAX };

/** A kit bundle control refuses, in words, with the HTTP status that says why. */
export class KitRefused extends Error {
  readonly status: 400 | 404 | 409 | 413;
  constructor(message: string, status: 400 | 404 | 409 | 413 = 400) {
    super(message);
    this.status = status;
  }
}

/** A kit bundle control took. */
export interface KitAdded {
  name: string;
  /** The kit's head now: the commit its `main` branch names. */
  head: string;
  /** The head before, or null for a new kit. */
  previous: string | null;
  /** Commits in the kit's history at its head. */
  commits: number;
  /** The kit.json at the head: its name and target. */
  kit: { name: string; target: string };
  /** The head was replaced by a commit that does not descend from it. */
  forced: boolean;
  /** The refs the bundle holds, as it names them, with their commits. */
  refs: { ref: string; commit: string }[];
  /** The bundle's size in bytes. */
  size: number;
}

const ZERO = "0".repeat(40);
const _run = promisify(execFile);
/** Control's repositories' git: PATH and HOME alone of control's environment. */
const gitEnv = (home: string) => ({ only: true, env: { HOME: home } });
/** Git, asynchronously; its standard output, trimmed. Throws with git's own words. */
const gitAsync = async (gitDir: string, args: string[], home = gitDir): Promise<string> =>
  (
    await gitText(["--git-dir", gitDir, ...args], { ...gitEnv(home), maxBytes: 16 * 1024 * 1024 })
  ).trim();
/**
 * Git's words on standard error, on one line, with the bundle's temporary file called "the
 * bundle" and no other temporary path.
 */
const gitSaid = (err: unknown, file: string, work: string): string =>
  String((err as { stderr?: unknown }).stderr ?? "")
    .split(file)
    .join("the bundle")
    .split(work)
    .join("")
    .split("\n")
    .map((l) => l.replace(/^(?:error|fatal): /, "").trim())
    .filter(Boolean)
    .join(" ") || "git refused it";

/** The files a dumb-HTTP client asks for; anything else in a repository is never served. */
const SERVED =
  /^(?:HEAD|info\/refs|objects\/info\/packs|objects\/[0-9a-f]{2}\/[0-9a-f]{38,62}|objects\/pack\/pack-[0-9a-f]{40,64}\.(?:pack|idx))$/;

const git = (gitDir: string, args: string[], input?: Buffer | string) =>
  gitSync(["--git-dir", gitDir, ...args], {
    input,
    only: true,
    env: {
      HOME: gitDir,
      GIT_AUTHOR_NAME: "Thermite control",
      GIT_AUTHOR_EMAIL: "control@thermite.invalid",
      GIT_COMMITTER_NAME: "Thermite control",
      GIT_COMMITTER_EMAIL: "control@thermite.invalid",
    },
    maxBytes: 64 * 1024 * 1024,
  });

export class KitRepos {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  path(name: string): string {
    if (!NAME.test(name)) throw new Error(`not a kit name: ${name}`);
    return join(this.dir, `${name}.git`);
  }

  /**
   * Commits a kit's files as the new head of its repository and returns the commit. Files are
   * path → content; folders come from the paths. The same files on the same parent give the
   * same tree, and a commit is made only when the tree changes.
   */
  commit(name: string, files: Record<string, Buffer>, message: string): string {
    const gitDir = this.path(name);
    if (!existsSync(join(gitDir, "HEAD"))) {
      mkdirSync(gitDir, { recursive: true });
      gitSync(["init", "--quiet", "--bare", "--initial-branch=main", gitDir], { only: true });
    }
    // A tree per folder, from its files' blobs and its subfolders' trees.
    interface Dir {
      files: Map<string, string>;
      dirs: Map<string, Dir>;
    }
    const root: Dir = { files: new Map(), dirs: new Map() };
    for (const [path, body] of Object.entries(files)) {
      const parts = path.split("/");
      if (parts.some((p) => !p || p === "." || p === ".." || p === ".git"))
        throw new Error(`not a path inside a kit: ${path}`);
      let d = root;
      for (const p of parts.slice(0, -1)) {
        const next = d.dirs.get(p) ?? { files: new Map(), dirs: new Map() };
        d.dirs.set(p, next);
        d = next;
      }
      const blob = git(gitDir, ["hash-object", "-w", "--stdin"], body).toString().trim();
      d.files.set(parts.at(-1) as string, blob);
    }
    const tree = (d: Dir): string => {
      const lines = [
        ...[...d.files].map(([n, sha]) => `100644 blob ${sha}\t${n}`),
        ...[...d.dirs].map(([n, sub]) => `040000 tree ${tree(sub)}\t${n}`),
      ];
      return git(gitDir, ["mktree"], `${lines.join("\n")}\n`)
        .toString()
        .trim();
    };
    const top = tree(root);
    let parent: string | undefined;
    try {
      parent = git(gitDir, ["rev-parse", "--verify", "--quiet", "refs/heads/main"])
        .toString()
        .trim();
    } catch {
      parent = undefined;
    }
    if (
      parent &&
      git(gitDir, ["rev-parse", `${parent}^{tree}`])
        .toString()
        .trim() === top
    )
      return parent;
    const commit = git(
      gitDir,
      ["commit-tree", top, ...(parent ? ["-p", parent] : []), "-F", "-"],
      `${message}\n`,
    )
      .toString()
      .trim();
    git(gitDir, ["update-ref", "refs/heads/main", commit]);
    git(gitDir, ["update-server-info"]);
    return commit;
  }

  /** The head commit of a kit's repository, if it has one. */
  head(name: string): string | undefined {
    if (!existsSync(join(this.path(name), "HEAD"))) return undefined;
    try {
      return git(this.path(name), ["rev-parse", "--verify", "--quiet", "refs/heads/main"])
        .toString()
        .trim();
    } catch {
      return undefined;
    }
  }

  /**
   * A kept kit's kit.json at one of its commits, parsed, for the pages that show how a goal is
   * checked (goal 082). Undefined when control does not keep that kit or that commit, or the
   * file is not JSON.
   */
  manifest(name: string, commit: string): unknown {
    if (!NAME.test(name) || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) return undefined;
    if (!existsSync(join(this.path(name), "HEAD"))) return undefined;
    try {
      const text = gitSync(["--git-dir", this.path(name), "show", `${commit}:kit.json`], {
        only: true,
        maxBytes: 4 * 1024 * 1024,
      });
      return JSON.parse(text.toString());
    } catch {
      // not a commit of this kit, or not JSON: control cannot read it
      return undefined;
    }
  }

  /** One file a dumb-HTTP fetch asks for, or undefined when it is not one to serve. */
  file(name: string, rel: string): Buffer | undefined {
    if (!NAME.test(name) || !SERVED.test(rel)) return undefined;
    const p = join(this.path(name), rel);
    if (!existsSync(p) || !statSync(p).isFile()) return undefined;
    return readFileSync(p);
  }

  /** The kits control keeps, by name, with their heads (a kit with no head yet is left out). */
  list(): { name: string; head: string }[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".git") && NAME.test(f.slice(0, -4)))
      .sort()
      .flatMap((f) => {
        const name = f.slice(0, -4);
        const head = this.head(name);
        return head ? [{ name, head }] : [];
      });
  }

  /** How many commits a kit's history has at one of its commits; 0 when control can't tell. */
  commitCount(name: string, commit: string): number {
    try {
      return Number(git(this.path(name), ["rev-list", "--count", commit]).toString().trim()) || 0;
    } catch {
      return 0;
    }
  }

  /** The newest commits of a kit's history at its head: id, commit time and first line. */
  history(name: string, limit = 20): { commit: string; at: string; subject: string }[] {
    const head = this.head(name);
    if (!head) return [];
    const out = git(this.path(name), [
      "log",
      `--max-count=${limit}`,
      "--format=%H%x09%cI%x09%s",
      head,
    ]).toString();
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [commit = "", at = "", ...subject] = line.split("\t");
        return { commit, at, subject: subject.join("\t") };
      });
  }

  /** One import at a time for each kit: a second waits for the first. */
  private readonly importing = new Map<string, Promise<unknown>>();

  /**
   * Takes a git bundle of a kit repository written elsewhere, with its history: every commit
   * keeps its id. The bundle is checked in a repository of its own first (`git bundle verify`;
   * a bundle that needs commits builds on the kit's own). The kit's head becomes the bundle's
   * HEAD, its only branch, or `ref` (a branch, a tag or a commit in the bundle), and that commit
   * must have a valid kit.json at its top. A kit control keeps already moves only to a commit
   * that descends from its head, unless `force`; the old head's commits are kept even then, so a
   * contract that names one still fetches. Refused in words (KitRefused).
   */
  async importBundle(
    name: string,
    bundle: Buffer,
    opts: { ref?: string | undefined; force?: boolean | undefined } = {},
  ): Promise<KitAdded> {
    if (!NAME.test(name))
      throw new KitRefused(
        `not a kit name: ${JSON.stringify(name)} (lowercase letters, digits, dots, dashes and underscores, at most 64, starting with a letter or digit)`,
      );
    if (bundle.length === 0) throw new KitRefused("the bundle is empty");
    if (bundle.length > KIT_BUNDLE_MAX)
      throw new KitRefused(
        `the bundle is ${bundle.length} bytes, above the ${KIT_BUNDLE_MAX} bytes (64 MiB) control takes`,
        413,
      );
    const before = this.importing.get(name) ?? Promise.resolve();
    const mine = before.then(
      () => this.importNow(name, bundle, opts),
      () => this.importNow(name, bundle, opts),
    );
    this.importing.set(name, mine);
    try {
      return await mine;
    } finally {
      if (this.importing.get(name) === mine) this.importing.delete(name);
    }
  }

  private async importNow(
    name: string,
    bundle: Buffer,
    opts: { ref?: string | undefined; force?: boolean | undefined },
  ): Promise<KitAdded> {
    const gitDir = this.path(name);
    const exists = existsSync(join(gitDir, "HEAD"));
    const previous = exists ? (this.head(name) ?? null) : null;
    const work = mkdtempSync(join(tmpdir(), "thermite-kit-bundle-"));
    try {
      const file = join(work, "kit.bundle");
      writeFileSync(file, bundle);
      // A repository of its own, which sees the kit's objects (for a bundle that builds on them)
      // but writes nothing into the kit's repository until every check passed.
      const scratch = join(work, "check.git");
      await gitText(["init", "--quiet", "--bare", scratch], gitEnv(work));
      if (exists)
        writeFileSync(
          join(scratch, "objects", "info", "alternates"),
          `${resolve(gitDir, "objects")}\n`,
        );
      const g = (args: string[]) => gitAsync(scratch, args, work);
      try {
        await g(["bundle", "verify", file]);
      } catch (err) {
        throw new KitRefused(`not a git bundle control can take: ${gitSaid(err, file, work)}`);
      }
      const refs = (await g(["bundle", "list-heads", file]))
        .split("\n")
        .map((l) => /^([0-9a-f]{40}|[0-9a-f]{64}) (\S+)$/.exec(l.trim()))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => ({ ref: m[2] as string, commit: m[1] as string }));
      if (!refs.length) throw new KitRefused("the bundle holds no ref");
      // Each object the bundle names, once, under a ref of the scratch repository.
      const tips = [...new Set(refs.map((r) => r.commit))];
      const firstRef = (sha: string) => refs.find((r) => r.commit === sha)?.ref as string;
      try {
        await g([
          "fetch",
          "--quiet",
          "--no-tags",
          "--no-write-fetch-head",
          file,
          ...tips.map((sha) => `+${firstRef(sha)}:refs/kept/${sha}`),
        ]);
      } catch (err) {
        throw new KitRefused(`control could not read the bundle: ${gitSaid(err, file, work)}`);
      }
      // The head: the ref asked for, else the bundle's HEAD, else its only branch.
      const branches = refs.filter((r) => r.ref.startsWith("refs/heads/"));
      const names = refs
        .map((r) => r.ref.replace(/^refs\/(?:heads|tags)\//, ""))
        .filter((r, i, all) => all.indexOf(r) === i);
      let chosen: string | undefined;
      const ref = opts.ref?.trim();
      if (ref) {
        const listed = refs.find(
          (r) => r.ref === ref || r.ref === `refs/heads/${ref}` || r.ref === `refs/tags/${ref}`,
        );
        if (listed) chosen = listed.commit;
        else if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(ref)) chosen = ref;
        else throw new KitRefused(`the bundle has no ref ${ref}: it has ${names.join(", ")}`);
      } else {
        const head = refs.find((r) => r.ref === "HEAD");
        const only = branches.length === 1 ? branches[0] : refs.length === 1 ? refs[0] : undefined;
        chosen = (head ?? only)?.commit;
        if (!chosen)
          throw new KitRefused(
            `the bundle has no HEAD and ${branches.length} branches (${names.join(", ")}): name the one to use with ref`,
          );
      }
      let head: string;
      try {
        head = await g(["rev-parse", "--verify", "--quiet", `${chosen}^{commit}`]);
      } catch {
        throw new KitRefused(`the bundle has no commit ${chosen}`);
      }
      // A commit given by its id must be in the bundle, not only in the kit already.
      if (!refs.some((r) => r.commit === chosen)) {
        const inBundle = await Promise.all(
          tips.map((sha) =>
            g(["merge-base", "--is-ancestor", head, sha]).then(
              () => true,
              () => false,
            ),
          ),
        );
        if (!inBundle.some(Boolean)) throw new KitRefused(`the bundle has no commit ${chosen}`);
      }
      // kit.json at the head's top, valid as the harness reads it.
      let text: string;
      try {
        text = await g(["cat-file", "blob", `${head}:kit.json`]);
      } catch {
        throw new KitRefused(`the bundle's head ${head} has no kit.json at its top`);
      }
      let manifest: unknown;
      try {
        manifest = JSON.parse(text);
      } catch {
        throw new KitRefused(`kit.json at ${head} is not JSON`);
      }
      const parsed = KitSchema.safeParse(manifest);
      if (!parsed.success)
        throw new KitRefused(
          `kit.json at ${head}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        );
      // A kit that exists moves forward only, unless the caller says to replace its head.
      const descends =
        !previous ||
        previous === head ||
        (await g(["merge-base", "--is-ancestor", previous, head]).then(
          () => true,
          () => false,
        ));
      if (!descends && !opts.force)
        throw new KitRefused(
          `the bundle's head ${head} does not descend from the kit's head ${previous}: give force to make it the head (control keeps the old head's commits)`,
          409,
        );
      // Every check passed: into the kit's repository, each object the bundle named kept under
      // refs/kept/, then the head moved only if no one moved it since.
      if (!exists) {
        mkdirSync(gitDir, { recursive: true });
        await gitText(
          ["init", "--quiet", "--bare", "--initial-branch=main", gitDir],
          gitEnv(gitDir),
        );
      }
      try {
        await gitAsync(gitDir, [
          "fetch",
          "--quiet",
          "--no-tags",
          "--no-write-fetch-head",
          file,
          ...tips.map((sha) => `+${firstRef(sha)}:refs/kept/${sha}`),
        ]);
        if (previous && !descends)
          await gitAsync(gitDir, ["update-ref", `refs/kept/${previous}`, previous]);
        await gitAsync(gitDir, ["update-ref", "refs/heads/main", head, previous ?? ZERO]);
        await gitAsync(gitDir, ["update-server-info"]);
      } catch (err) {
        if (this.head(name) !== (previous ?? undefined))
          throw new KitRefused(
            `the kit ${name} changed while control took the bundle: send it again`,
            409,
          );
        throw new Error(`control could not keep the bundle: ${gitSaid(err, file, work)}`);
      }
      return {
        name,
        head,
        previous,
        commits: this.commitCount(name, head),
        kit: { name: parsed.data.name, target: parsed.data.target },
        forced: !descends,
        refs,
        size: bundle.length,
      };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}
