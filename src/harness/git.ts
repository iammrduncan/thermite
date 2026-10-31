import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { GitError, git as gitPatch, gitText } from "../common/git.ts";
import { sha256Hex } from "../core/canonical.ts";

const run = promisify(execFile);

/**
 * The harness's git mirror: a bare repository per project holding imported history, attempt refs
 * and champion refs. Only the controller writes to it.
 */

const IDENTITY = [
  "-c",
  "user.name=thermite",
  "-c",
  "user.email=thermite@localhost",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
];

export { GitError };

/**
 * A repository Git runs in must exist: Node starts no program in a folder that does not, and
 * says only `spawn git ENOENT`, as if Git were missing. Say what is missing instead.
 */
function needRepo(cwd: string, op: string): void {
  if (!existsSync(cwd))
    throw new GitError(`git ${op} failed: there is no repository ${basename(cwd)} on this rig`);
}

/** The most output one call returns: a mirror's patches and files are smaller. */
const MAX_BYTES = 256 * 1024 * 1024;

async function git(cwd: string, args: string[]): Promise<string> {
  needRepo(cwd, args[0] ?? "");
  return gitText([...IDENTITY, ...args], { cwd, maxBytes: MAX_BYTES });
}

export async function initMirror(path: string): Promise<void> {
  if (existsSync(join(path, "HEAD"))) return;
  mkdirSync(path, { recursive: true });
  await git(path, ["init", "--bare", "--quiet"]);
}

export async function hasCommit(mirror: string, sha: string): Promise<boolean> {
  try {
    await git(mirror, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCommit(mirror: string, rev: string): Promise<string> {
  return (await git(mirror, ["rev-parse", "--verify", `${rev}^{commit}`])).trim();
}

/**
 * A project that is one folder of its repository starts from a commit whose tree is that folder
 * at the repository's commit. The commit is written byte for byte here (no parent, a fixed
 * author and time, a message naming the folder and the commit), so every rig makes the same
 * one from the same signed commit and folder: champions move between rigs on the same base.
 */
export async function folderCommit(
  mirror: string,
  commit: string,
  folder: string,
): Promise<string> {
  // After the colon everything is the path: whether it is a folder is asked on its own.
  const tree = await git(mirror, ["rev-parse", "--verify", "--quiet", `${commit}:${folder}`]).then(
    (id) => id.trim(),
    () => "",
  );
  const type = tree
    ? await git(mirror, ["cat-file", "-t", tree]).then(
        (t) => t.trim(),
        () => "",
      )
    : "";
  if (type !== "tree") throw new GitError(`commit ${commit} has no folder ${folder}`);
  const body =
    `tree ${tree}\n` +
    "author thermite <thermite@localhost> 0 +0000\n" +
    "committer thermite <thermite@localhost> 0 +0000\n" +
    `\n${folder} at ${commit}\n`;
  const args = ["hash-object", "-t", "commit", "-w", "--stdin"];
  return (await gitText(args, { cwd: mirror, input: body })).trim();
}

/**
 * Fetches a bundle into refs/thermite/imports/<importId>/* and checks that it contains the
 * expected commit. On mismatch the fetched refs are removed and an error is thrown.
 */
export async function fetchBundle(
  mirror: string,
  bundlePath: string,
  importId: string,
  expectedCommit: string,
): Promise<string> {
  await git(mirror, ["bundle", "verify", "--quiet", bundlePath]);
  const prefix = `refs/thermite/imports/${importId}`;
  await git(mirror, ["fetch", "--quiet", "--no-tags", bundlePath, `+refs/*:${prefix}/*`]);
  const found = (await hasCommit(mirror, expectedCommit))
    ? await resolveCommit(mirror, expectedCommit)
    : undefined;
  // The full id must match exactly: an abbreviated or ground prefix never resolves to a pass.
  if (found !== expectedCommit) {
    const refs = await git(mirror, ["for-each-ref", "--format=%(refname)", prefix]);
    for (const ref of refs.split("\n").filter(Boolean))
      await git(mirror, ["update-ref", "-d", ref]);
    throw new GitError(`bundle does not contain commit ${expectedCommit}`);
  }
  return found;
}

export interface AttemptCommit {
  commit: string;
  ref: string;
  changedFiles: string[];
  addedLines: string[];
  binaryFiles: string[];
  specialFiles: string[];
  diffSha: string;
  normalizedDiffSha: string;
  stat: { path: string; added: number | null; removed: number | null }[];
}

/**
 * Turns a submitted patch into a commit on its parent and preserves it as
 * refs/thermite/attempts/<id> before anything else happens to it.
 */
export async function createAttemptCommit(input: {
  mirror: string;
  scratchDir: string;
  parent: string;
  patch: Buffer;
  id: string;
  message: string;
  /** Where the commit is preserved; attempts by default. */
  refPrefix?: string | undefined;
}): Promise<AttemptCommit> {
  if (input.patch.length === 0) throw new GitError("empty change");
  mkdirSync(input.scratchDir, { recursive: true });
  const worktree = join(input.scratchDir, `wt-${input.id}`);
  const patchFile = join(input.scratchDir, `${input.id}.patch`);
  writeFileSync(patchFile, input.patch);
  await git(input.mirror, ["worktree", "add", "--detach", "--quiet", worktree, input.parent]);
  try {
    await git(worktree, ["apply", "--index", "--binary", "--whitespace=nowarn", patchFile]);
    await git(worktree, ["commit", "--quiet", "--no-verify", "-m", input.message]);
    const commit = (await git(worktree, ["rev-parse", "HEAD"])).trim();
    const ref = `${input.refPrefix ?? "refs/thermite/attempts"}/${input.id}`;
    await git(input.mirror, ["update-ref", ref, commit]);
    const info = await diffInfo(input.mirror, input.parent, commit);
    return { commit, ref, ...info, diffSha: sha256Hex(input.patch) };
  } finally {
    await git(input.mirror, ["worktree", "remove", "--force", worktree]).catch(() => undefined);
    await git(input.mirror, ["worktree", "prune"]).catch(() => undefined);
    rmSync(patchFile, { force: true });
  }
}

export async function diffInfo(
  mirror: string,
  parent: string,
  commit: string,
): Promise<{
  changedFiles: string[];
  addedLines: string[];
  binaryFiles: string[];
  specialFiles: string[];
  normalizedDiffSha: string;
  /** Each changed file with its added and removed lines (null for a binary file). */
  stat: { path: string; added: number | null; removed: number | null }[];
}> {
  const names = await git(mirror, ["diff", "--name-only", "-z", "--no-renames", parent, commit]);
  const normalized = await git(mirror, [
    "diff",
    "--binary",
    "--full-index",
    "--no-color",
    "--no-ext-diff",
    "--no-renames",
    parent,
    commit,
  ]);
  // --text so that a NUL byte cannot hide added lines behind "Binary files differ".
  const unified = await git(mirror, [
    "diff",
    "-U0",
    "--text",
    "--no-color",
    "--no-ext-diff",
    "--no-renames",
    parent,
    commit,
  ]);
  const numstat = await git(mirror, ["diff", "--numstat", "-z", "--no-renames", parent, commit]);
  const raw = await git(mirror, ["diff", "--raw", "-z", "--no-renames", parent, commit]);
  return {
    changedFiles: names.split("\0").filter(Boolean),
    addedLines: addedLinesOf(unified),
    binaryFiles: binaryFilesOf(numstat),
    specialFiles: specialFilesOf(raw),
    normalizedDiffSha: sha256Hex(normalized),
    stat: statOf(numstat),
  };
}

/** `git diff --numstat -z` (no renames) as one entry per file: "added<TAB>removed<TAB>path". */
function statOf(
  numstatZ: string,
): { path: string; added: number | null; removed: number | null }[] {
  return numstatZ
    .split("\0")
    .filter(Boolean)
    .map((r) => {
      const [added = "", removed = "", ...path] = r.split("\t");
      const n = (x: string) => (x === "-" ? null : Number(x));
      return { path: path.join("\t"), added: n(added), removed: n(removed) };
    });
}

/**
 * Added lines of a unified diff. Header lines (`--- `, `+++ `) are recognised only before the
 * first hunk of each file, so an added line whose content starts with "++" is still an added
 * line.
 */
export function addedLinesOf(unified: string): string[] {
  const added: string[] = [];
  let inHunk = false;
  for (const line of unified.split("\n")) {
    if (line.startsWith("diff --git ")) inHunk = false;
    else if (line.startsWith("@@")) inHunk = true;
    else if (inHunk && line.startsWith("+")) added.push(line.slice(1));
  }
  return added;
}

/** Paths whose new mode is a symlink (120000) or a submodule (160000), from `diff --raw -z`. */
export function specialFilesOf(rawZ: string): string[] {
  const out: string[] = [];
  const f = rawZ.split("\0");
  for (let i = 0; i + 1 < f.length; i += 2) {
    const meta = f[i] ?? "";
    const newMode = meta.split(" ")[1];
    if (newMode === "120000" || newMode === "160000") out.push(f[i + 1] as string);
  }
  return out;
}

/** Files git counts as binary (numstat shows "-" for their line counts). */
function binaryFilesOf(numstatZ: string): string[] {
  return numstatZ
    .split("\0")
    .filter((r) => r.startsWith("-\t-\t"))
    .map((r) => r.slice(4));
}

/** The patch from parent to commit as bytes (exports and propagation: never decoded as text). */
export async function patchBytes(mirror: string, parent: string, commit: string): Promise<Buffer> {
  needRepo(mirror, "diff");
  return gitPatch(
    [
      ...IDENTITY,
      "diff",
      "--binary",
      "--full-index",
      "--no-color",
      "--no-ext-diff",
      parent,
      commit,
    ],
    { cwd: mirror, maxBytes: MAX_BYTES },
  );
}

/** The patch from parent to commit, as text (for people and models to read). */
export async function patchBetween(
  mirror: string,
  parent: string,
  commit: string,
): Promise<string> {
  return git(mirror, [
    "diff",
    "--binary",
    "--full-index",
    "--no-color",
    "--no-ext-diff",
    parent,
    commit,
  ]);
}

export async function updateRef(mirror: string, ref: string, commit: string): Promise<void> {
  await git(mirror, ["update-ref", ref, commit]);
}

export async function deleteRef(mirror: string, ref: string): Promise<void> {
  await git(mirror, ["update-ref", "-d", ref]);
}

/**
 * The change between two commits as a person reads it (goal 081): a unified diff without binary
 * patches (a binary file shows as one line that it differs).
 */
export async function readableDiff(
  mirror: string,
  parent: string,
  commit: string,
): Promise<string> {
  for (const c of [parent, commit])
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(c)) throw new GitError(`not a commit id: ${c}`);
  return git(mirror, ["diff", "--no-color", "--no-ext-diff", "--no-renames", parent, commit]);
}

/** One file of a commit's tree: its path from the top and its size in bytes. */
export interface TreeFile {
  path: string;
  size: number;
}

/**
 * The files of a commit's tree, or of one folder of it (goal 081), with their sizes. Paths are
 * from the tree's top; nothing outside the tree can be named.
 */
export async function treeFiles(mirror: string, commit: string, folder = ""): Promise<TreeFile[]> {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit))
    throw new GitError(`not a commit id: ${commit}`);
  const out = await git(mirror, [
    "ls-tree",
    "-r",
    "-l",
    "-z",
    "--full-tree",
    commit,
    ...(folder ? ["--", folder] : []),
  ]);
  const files: TreeFile[] = [];
  for (const entry of out.split("\0")) {
    // "<mode> <type> <object> <size>\t<path>"; a submodule has no size.
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const [, type, , size] = entry.slice(0, tab).split(/\s+/);
    if (type !== "blob") continue;
    files.push({ path: entry.slice(tab + 1), size: Number(size) || 0 });
  }
  return files;
}

/**
 * One file of a commit's tree, as bytes (goal 081), or undefined when the tree has no file
 * there. Larger than `maxBytes`: its size alone.
 */
export async function treeFile(
  mirror: string,
  commit: string,
  path: string,
  maxBytes: number,
): Promise<{ size: number; bytes?: Buffer } | undefined> {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit))
    throw new GitError(`not a commit id: ${commit}`);
  needRepo(mirror, "cat-file");
  const spec = `${commit}:${path}`;
  const type = await git(mirror, ["cat-file", "-t", spec]).then(
    (t) => t.trim(),
    () => "",
  );
  if (type !== "blob") return undefined;
  const size = Number((await git(mirror, ["cat-file", "-s", spec])).trim());
  if (size > maxBytes) return { size };
  const bytes = await gitPatch([...IDENTITY, "cat-file", "blob", spec], {
    cwd: mirror,
    maxBytes: maxBytes + 1024,
  });
  return { size, bytes };
}

/** The id of a commit's tree: the same content gives the same tree in any repository. */
/** A file's content at a commit (for example a kit's kit.json). */
export async function showFile(mirror: string, commit: string, path: string): Promise<string> {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit))
    throw new GitError(`not a commit id: ${commit}`);
  return git(mirror, ["show", `${commit}:${path}`]);
}

export async function treeOf(mirror: string, commit: string): Promise<string> {
  return (await git(mirror, ["rev-parse", "--verify", `${commit}^{tree}`])).trim();
}

/** Writes the tree of `commit` into `dest` (which must not exist yet), without .git. */
export async function exportTree(mirror: string, commit: string, dest: string): Promise<void> {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit))
    throw new GitError(`not a commit id: ${commit}`);
  mkdirSync(dest, { recursive: true });
  const tar = join(dest, ".tree.tar");
  await git(mirror, ["archive", "--format=tar", `--output=${tar}`, commit]);
  try {
    await run("tar", ["-xf", tar, "-C", dest]);
  } finally {
    rmSync(tar, { force: true });
  }
}
