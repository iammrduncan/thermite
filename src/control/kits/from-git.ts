import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorText } from "../../common/errors.ts";
import { gitText, withGitAuth } from "../../common/git/index.ts";
import type { GitAccessUse } from "../git-access.ts";
import { KIT_BUNDLE_MAX, KitRefused } from "./repos.ts";

/**
 * A kit's repository read from its git address (goal 182), as a bundle for addKit: the whole
 * history of one branch, tag or commit (HEAD when none is named), so a kit control keeps can move
 * on to it. Over https with no credentials, or with a Git access: a token over https, a deploy key
 * over ssh, as the new-campaign page reads a project. Five minutes at most, and a bundle of at most
 * KIT_BUNDLE_MAX bytes. Control removes what it fetched once the bundle is read. Refused in words.
 */
export async function kitBundleFromGit(
  src: { url: string; ref?: string | undefined },
  access?: GitAccessUse | undefined,
): Promise<Buffer> {
  const { url } = src;
  const ref = src.ref ?? "HEAD";
  const ssh = access?.auth.kind === "ssh";
  if (
    ssh
      ? !/^(?:ssh:\/\/[^\s]+|[\w.-]+@[\w.-]+:[^\s]+)$/.test(url)
      : !/^https:\/\/[^\s@]+$/.test(url)
  )
    throw new KitRefused(
      ssh
        ? "with an SSH deploy key, the kit's repository is an ssh:// or git@host:path address"
        : "the kit's repository must be an https:// URL, or name a Git access for a private one",
    );
  if (!/^[\w./-]{1,200}$/.test(ref) || ref.startsWith("-"))
    throw new KitRefused("the branch, tag or commit has characters git does not allow");
  return withGitAuth(access?.auth, access?.knownHostsFile, async (g) => {
    const git = (args: string[], cwd: string) =>
      gitText(args, {
        cwd,
        only: true,
        env: { ...(access ? g.env : {}), GIT_ALLOW_PROTOCOL: access ? g.protocols : "https" },
        timeoutMs: 300_000,
        maxBytes: 1024 * 1024,
      });
    const dir = mkdtempSync(join(tmpdir(), "thermite-kit-git-"));
    try {
      await git(["init", "--quiet", "--bare", dir], dir);
      try {
        await git(["fetch", "--quiet", "--no-tags", "--", url, ref], dir);
      } catch (err) {
        const msg = errorText(err);
        throw new KitRefused(
          /could not read Username|Authentication|403|401|Permission denied/.test(msg)
            ? "control cannot read the kit's repository: is it private? Name a Git access for it"
            : `control could not fetch ${ref} of the kit's repository: ${msg.split("\n").filter(Boolean).at(-1)?.slice(0, 200)}`,
        );
      }
      const commit = (await git(["rev-parse", "--verify", "FETCH_HEAD^{commit}"], dir)).trim();
      await git(["update-ref", "refs/heads/kit", commit], dir);
      const file = join(dir, "kit.bundle");
      await git(["bundle", "create", "--quiet", file, "refs/heads/kit"], dir);
      const size = statSync(file).size;
      if (size > KIT_BUNDLE_MAX)
        throw new KitRefused(
          `the kit's history is ${size} bytes as a bundle, above the ${KIT_BUNDLE_MAX} bytes (64 MiB) control takes`,
          413,
        );
      return readFileSync(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
