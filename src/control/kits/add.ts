import { ID_PATTERN } from "../../core/contract.ts";
import { KitSchema } from "../../core/kit.ts";
import type { GitAccessUse } from "../git-access.ts";
import type { ControlStore } from "../store/index.ts";
import { kitBundleFromGit } from "./from-git.ts";
import { type KitAdded, KitRefused, type KitRepos } from "./repos.ts";
import { kitSummary } from "./upload.ts";

/**
 * A kit written elsewhere, given to control as a git bundle of its repository (REST, MCP and the
 * command line), or as its repository's git address, which control reads itself (goal 182): control keeps it with its commits, as it keeps a kit written on the New campaign
 * page, and rigs fetch it from control by commit with `{"control": "kits/<name>"}` as its source.
 * Who may add one: the owner's token, and an operator's over MCP. A kit is an input, not a
 * secret: the reader may list the kits too.
 */

/** The largest bundle kit_add takes over MCP: MCP's requests are at most 4 MiB, as base64. */
export const MCP_KIT_BASE64_MAX = 4_000_000;
/** The bundle that base64 holds: three bytes for every four characters. */
export const MCP_KIT_BUNDLE_MAX = (MCP_KIT_BASE64_MAX / 4) * 3;

export type KitOutcome<T> =
  | { ok: true; answer: T; created: boolean }
  | { ok: false; error: string; status: 400 | 404 | 409 | 413 };

export interface KitAddAnswer {
  name: string;
  head: string;
  previous: string | null;
  commits: number;
  kit: { name: string; target: string };
  forced: boolean;
  refs: { ref: string; commit: string }[];
  size: number;
  said: string;
}

const short = (c: string) => c.slice(0, 12);

/** What control did with a bundle, in words. */
function said(a: KitAdded): string {
  const where = `kit ${a.name} at ${short(a.head)} (${a.commits} commit${a.commits === 1 ? "" : "s"})`;
  if (a.previous === null)
    return `Control keeps the ${where}. Rigs fetch it with the source {"control": "kits/${a.name}"}.`;
  if (a.previous === a.head) return `The ${where} is already its head: nothing changed.`;
  return a.forced
    ? `The ${where} replaces the head ${short(a.previous)}, which it does not descend from. Control keeps the old head's commits.`
    : `The ${where} follows the head ${short(a.previous)}.`;
}

/** Takes a kit bundle: kept, and in the audit log as kit_added; a refusal in words. */
export async function addKit(
  store: ControlStore,
  kits: KitRepos,
  input: {
    name: string;
    bundle: Buffer;
    ref?: string | undefined;
    force?: boolean | undefined;
    /** The repository control read it from, for the audit log. */
    from?: string | undefined;
  },
  by: string,
): Promise<KitOutcome<KitAddAnswer>> {
  let added: KitAdded;
  try {
    added = await kits.importBundle(input.name, input.bundle, {
      ref: input.ref,
      force: input.force,
    });
  } catch (err) {
    if (err instanceof KitRefused) return { ok: false, error: err.message, status: err.status };
    throw err;
  }
  store.auditLog.add(by, "kit_added", {
    name: added.name,
    head: added.head,
    previous: added.previous,
    commits: added.commits,
    forced: added.forced,
    size: added.size,
    ...(input.from ? { from: input.from } : {}),
    by,
  });
  return { ok: true, created: added.previous === null, answer: { ...added, said: said(added) } };
}

/**
 * A kit read from its repository's git address (from-git.ts): one branch, tag or commit's history,
 * kept as a bundle given to addKit is, its head that commit. `access`: a Git access control keeps,
 * for a private repository.
 */
export async function addKitFromGit(
  store: ControlStore,
  kits: KitRepos,
  input: { name: string; url: string; ref?: string | undefined; force?: boolean | undefined },
  access: GitAccessUse | undefined,
  by: string,
): Promise<KitOutcome<KitAddAnswer>> {
  let bundle: Buffer;
  try {
    bundle = await kitBundleFromGit({ url: input.url, ref: input.ref }, access);
  } catch (err) {
    if (err instanceof KitRefused) return { ok: false, error: err.message, status: err.status };
    throw err;
  }
  return addKit(store, kits, { name: input.name, bundle, force: input.force, from: input.url }, by);
}

/** A kept kit's kit.json at a commit, checked as the harness checks it. */
function manifestAt(kits: KitRepos, name: string, commit: string) {
  const raw = kits.manifest(name, commit);
  if (raw === undefined) return { error: `no readable kit.json at ${commit}` } as const;
  const parsed = KitSchema.safeParse(raw);
  return parsed.success
    ? ({ kit: parsed.data } as const)
    : ({
        error: `kit.json: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      } as const);
}

/** The kits control keeps: each one's head, its history's length, and its kit.json's name and target. */
export function kitsAnswer(kits: KitRepos) {
  return {
    kits: kits.list().map(({ name, head }) => {
      const m = manifestAt(kits, name, head);
      return {
        name,
        head,
        commits: kits.commitCount(name, head),
        kit: "kit" in m && m.kit ? { name: m.kit.name, target: m.kit.target } : null,
        ...("error" in m ? { kit_error: m.error } : {}),
      };
    }),
  };
}

/** One kit control keeps: its head, its kit.json at the head in short, and its newest commits. */
export function kitAnswer(kits: KitRepos, name: string): KitOutcome<unknown> {
  const head = ID_PATTERN.test(name) ? kits.head(name) : undefined;
  if (!head) return { ok: false, error: `control keeps no kit ${name}`, status: 404 };
  const m = manifestAt(kits, name, head);
  return {
    ok: true,
    created: false,
    answer: {
      name,
      head,
      commits: kits.commitCount(name, head),
      kit: "kit" in m && m.kit ? kitSummary(m.kit) : null,
      ...("error" in m ? { kit_error: m.error } : {}),
      history: kits.history(name),
    },
  };
}
