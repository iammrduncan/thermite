import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GitAuth, gitHost } from "../common/git/index.ts";
import type { SecretBox } from "./secrets.ts";
import type { ControlStore } from "./store/index.ts";

/** A Git access as control's own fetches use it: its secret unsealed, and its pinned host keys. */
export interface GitAccessUse {
  auth: GitAuth;
  knownHostsFile: string;
}

/**
 * Git access for control's own fetch of `url` (a new campaign's project and kit, a Git access's
 * test, a kit from git): the access's secret unsealed, host keys pinned per access beside the
 * kits. Refused, in words, for an access control lacks, one bound to no host yet, and a URL on a
 * host other than the one the access is for. No name: none.
 */
export function gitAccessFor(
  store: ControlStore,
  secrets: SecretBox,
  kitsDir: string | undefined,
  name: string | undefined,
  url: string,
): GitAccessUse | undefined {
  if (!name) return undefined;
  const g = store.gitAccess.get(name);
  if (!g) throw new Error(`no Git access named ${name}`);
  if (!g.host)
    throw new Error(
      `the Git access ${name} is for no host yet: set the host it is for in Settings › Providers`,
    );
  const host = gitHost(url);
  if (host !== g.host)
    throw new Error(
      `the Git access ${name} is for ${g.host} only, and ${url} is on ${host ?? "no host"}`,
    );
  const secret = secrets.open(g.secret_sealed);
  return {
    auth:
      g.kind === "ssh"
        ? { kind: "ssh", privateKey: secret }
        : { kind: "token", token: secret, username: g.username ?? undefined },
    knownHostsFile: join(kitsDir ?? tmpdir(), "..", "known_hosts", name),
  };
}
