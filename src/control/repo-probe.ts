import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorText } from "../common/errors.ts";
import { type GitAuth, gitCause, gitText, withGitAuth } from "../common/git/index.ts";

/**
 * What the new-campaign page shows about a project before it starts: the commit a branch or tag
 * names now, how many files it has, and folders to suggest for the files agents may change.
 * For a project in one folder of its repository, the files and suggestions are that folder's,
 * from its own top, and a commit without that folder is refused.
 * Control reads the repository's tree, never its file contents (a shallow fetch without blobs),
 * over https only, with no credentials and a time limit.
 */
export interface Probe {
  commit: string;
  files: number;
  suggest: string[];
}

/** A probe's git: PATH alone of control's environment, over https only, a minute at most. */
const probe = (extra: Record<string, string>, maxBytes: number) => (args: string[], cwd?: string) =>
  gitText(args, {
    cwd,
    only: true,
    env: { GIT_ALLOW_PROTOCOL: "https", ...extra },
    timeoutMs: 60_000,
    maxBytes,
  });

export async function probeRepository(
  url: string,
  ref: string,
  access?: { auth: GitAuth; knownHostsFile: string },
  folder?: string,
): Promise<Probe> {
  const ssh = access?.auth.kind === "ssh";
  if (
    ssh
      ? !/^(?:ssh:\/\/[^\s]+|[\w.-]+@[\w.-]+:[^\s]+)$/.test(url)
      : !/^https:\/\/[^\s@]+$/.test(url)
  )
    throw new Error(
      ssh
        ? "with an SSH deploy key, the repository is an ssh:// or git@host:path address"
        : "the repository must be an https:// URL, or choose Git access for a private one",
    );
  return withGitAuth(access?.auth, access?.knownHostsFile, (g) =>
    probeWith(url, ref, access ? { ...g.env, GIT_ALLOW_PROTOCOL: g.protocols } : {}, folder),
  );
}

async function probeWith(
  url: string,
  ref: string,
  extra: Record<string, string>,
  folder: string | undefined,
): Promise<Probe> {
  if (!/^[\w./-]{1,200}$/.test(ref) || ref.startsWith("-"))
    throw new Error("the branch, tag or commit has characters git does not allow");
  const git = probe(extra, 64 * 1024 * 1024);
  let commit: string | undefined;
  if (/^[0-9a-f]{40}$/.test(ref)) commit = ref;
  else {
    let out: string;
    try {
      out = await git(["ls-remote", "--", url, ref, `${ref}^{}`]);
    } catch (err) {
      const msg = errorText(err);
      throw new Error(
        /could not read Username|Authentication|403|401/.test(msg)
          ? "control cannot read it without a key: is the repository private?"
          : `control could not read it: ${gitCause(msg)}`,
      );
    }
    const refs = out
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t") as [string, string]);
    const pick = (name: string) => refs.find(([, r]) => r === name)?.[0];
    commit =
      pick(`refs/tags/${ref}^{}`) ??
      pick(`refs/heads/${ref}`) ??
      pick(`refs/tags/${ref}`) ??
      pick(ref) ??
      (ref === "HEAD" ? pick("HEAD") : undefined);
    if (!commit) throw new Error(`the repository has no branch or tag named ${ref}`);
  }
  const dir = mkdtempSync(join(tmpdir(), "thermite-probe-"));
  try {
    await git(["init", "--quiet", "--bare", dir]);
    await git(["fetch", "--quiet", "--depth", "1", "--filter=blob:none", "--", url, commit], dir);
    const all = (await git(["ls-tree", "-r", "--name-only", commit], dir))
      .split("\n")
      .filter(Boolean);
    const paths = folder ? inFolder(all, folder) : all;
    if (!paths.length)
      throw new Error(`${ref} has no folder ${folder}, or the folder has no files`);
    return { commit, files: paths.length, suggest: suggestions(paths) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A kit's kit.json at one commit of its repository, for the new-campaign page (goal 068: the
 * MCP servers a kit in a repository names). Control fetches that commit alone, with no file
 * bigger than 1 MiB, reads kit.json and nothing else, and removes what it fetched.
 */
export async function readKitManifest(
  url: string,
  commit: string,
  access?: { auth: GitAuth; knownHostsFile: string },
): Promise<unknown> {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit))
    throw new Error("the kit's commit is its full id: 40 hexadecimal characters");
  const ssh = access?.auth.kind === "ssh";
  if (
    ssh
      ? !/^(?:ssh:\/\/[^\s]+|[\w.-]+@[\w.-]+:[^\s]+)$/.test(url)
      : !/^https:\/\/[^\s@]+$/.test(url)
  )
    throw new Error(
      ssh
        ? "with an SSH deploy key, the kit's repository is an ssh:// or git@host:path address"
        : "the kit's repository must be an https:// URL, or choose Git access for a private one",
    );
  return withGitAuth(access?.auth, access?.knownHostsFile, async (g) => {
    const git = probe(access ? { ...g.env, GIT_ALLOW_PROTOCOL: g.protocols } : {}, 4 * 1024 * 1024);
    const dir = mkdtempSync(join(tmpdir(), "thermite-kit-probe-"));
    try {
      await git(["init", "--quiet", "--bare", dir]);
      try {
        await git(
          ["fetch", "--quiet", "--depth", "1", "--filter=blob:limit=1m", "--", url, commit],
          dir,
        );
      } catch (err) {
        const msg = errorText(err);
        throw new Error(
          /could not read Username|Authentication|403|401/.test(msg)
            ? "control cannot read the kit's repository without a key: is it private?"
            : `control could not fetch the kit's commit: ${gitCause(msg)}`,
        );
      }
      let text: string;
      try {
        text = await git(["show", `${commit}:kit.json`], dir);
      } catch {
        throw new Error("the kit's commit has no kit.json at its top");
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new Error("the kit's kit.json is not JSON");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

/** The paths inside a folder, from the folder's own top. */
export function inFolder(paths: string[], folder: string): string[] {
  const at = `${folder}/`;
  return paths.filter((p) => p.startsWith(at)).map((p) => p.slice(at.length));
}

/** Folders worth offering as editable paths: the busiest top folders and their source folders. */
export function suggestions(paths: string[]): string[] {
  const count = new Map<string, number>();
  for (const p of paths) {
    const parts = p.split("/");
    if (parts.length < 2) continue;
    const top = parts[0] as string;
    if (top.startsWith(".") || /^(docs?|tests?|examples?|third[_-]?party|vendor)$/i.test(top))
      continue;
    count.set(`${top}/**`, (count.get(`${top}/**`) ?? 0) + 1);
    if (parts.length > 2) {
      const two = `${top}/${parts[1]}/**`;
      count.set(two, (count.get(two) ?? 0) + 1);
    }
  }
  return [...count]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([p]) => p);
}

/**
 * Whether a Git access may push to a repository (goal 185), for the page's **Check it can push**:
 * a `git push --dry-run` of a commit made here to a `thermite/` branch. The host checks the right
 * to push when the push begins, and a dry run sends nothing, so nothing is written there. Undefined
 * when it may; else why not, in words.
 */
export async function pushCheck(
  url: string,
  access?: { auth: GitAuth; knownHostsFile: string },
): Promise<string | undefined> {
  if (!access)
    return "a push needs a Git access: a public repository can be read without one, but not pushed to";
  const ssh = access.auth.kind === "ssh";
  if (
    ssh
      ? !/^(?:ssh:\/\/[^\s]+|[\w.-]+@[\w.-]+:[^\s]+)$/.test(url)
      : !/^https:\/\/[^\s@]+$/.test(url)
  )
    return ssh
      ? "with an SSH deploy key, the repository is an ssh:// or git@host:path address"
      : "with a token, the repository is an https:// address";
  const dir = mkdtempSync(join(tmpdir(), "thermite-push-check-"));
  try {
    return await withGitAuth(access.auth, access.knownHostsFile, async (g) => {
      const git = probe({ ...g.env, GIT_ALLOW_PROTOCOL: g.protocols }, 1024 * 1024);
      await git(["init", "--quiet", "--bare", dir]);
      const tree = await git(["-C", dir, "mktree"]).catch(() => "");
      const empty = tree.trim() || "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
      const commit = (
        await gitText(["-C", dir, "commit-tree", empty, "-m", "Thermite's push check"], {
          only: true,
          env: {
            GIT_AUTHOR_NAME: "thermite",
            GIT_AUTHOR_EMAIL: "thermite@localhost",
            GIT_COMMITTER_NAME: "thermite",
            GIT_COMMITTER_EMAIL: "thermite@localhost",
          },
        })
      ).trim();
      try {
        await git([
          "-C",
          dir,
          "push",
          "--dry-run",
          "--quiet",
          url,
          `${commit}:refs/heads/thermite/push-check`,
        ]);
        return undefined;
      } catch (err) {
        const msg = errorText(err);
        return /read.only|denied|403|401|not allowed|Authentication|could not read/i.test(msg)
          ? "the repository refused a push with this access: give it write access on the code host, or choose another"
          : `control could not push there: ${gitCause(msg)}`;
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
