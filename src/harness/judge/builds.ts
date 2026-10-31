import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson, sha256Hex } from "../../core/canonical.ts";
import type { Kit } from "../../core/kit.ts";
import type { Role, Runner } from "../broker/index.ts";
import { exportTree } from "../git.ts";
import type { Ledger } from "../ledger/index.ts";

/**
 * The build store. The builder user builds each (commit, kit) pair once in a fresh scratch
 * directory; the judge hashes the outputs and moves them into the store, where they are
 * read-only to everyone else. Every timed run re-checks the hashes before launch, so a
 * candidate that overwrote a binary is caught (it cannot: the store is not writable by it).
 */

export interface BuildManifest {
  key: string;
  commit: string;
  kit_commit: string;
  files: Record<string, string>;
  build_ms: number;
}

export type BuildResult =
  | { ok: true; dir: string; manifest: BuildManifest; cached: boolean }
  | { ok: false; key: string; reason: string; log: string; transient: boolean };

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * What compiles a build (goal 135): the image's installed packages, the compilers and, for tools
 * installed another way, THERMITE_TOOLCHAIN_ID. A change to any of them never reuses old builds;
 * new images that change none of them keep the builds made before. The image's name is not in it.
 */
export function toolchainOf(env: NodeJS.ProcessEnv): string {
  const out = (cmd: string, args: string[]) => {
    try {
      const o = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 2 ** 26 };
      return (execFileSync(cmd, args, o as never) as unknown as string).trim();
    } catch {
      return undefined;
    }
  };
  const lines = (s: string | undefined) => s?.split("\n").filter(Boolean) ?? [];
  // biome-ignore lint/suspicious/noTemplateCurlyInString: dpkg-query's format fields, not a template
  const packages = out("dpkg-query", ["-W", "-f=${Package}=${Version}\n"]);
  return canonicalJson({
    packages: packages === undefined ? null : sha256Hex(lines(packages).sort().join("\n")),
    cc: lines(out("cc", ["--version"]))[0] ?? null,
    nvcc: lines(out("nvcc", ["--version"])).at(-1) ?? null,
    // Empty counts as not set.
    extra: env.THERMITE_TOOLCHAIN_ID || null,
  });
}

/** What a build is made from, and the builder user it is made as. */
export interface BuildInput {
  repo: string;
  mirror: string;
  commit: string;
  kit: Kit;
  kitDir: string;
  kitCommit: string;
  actor: string;
  role: Role;
}

/** Builds under way in this process, by their store path: one key is never built twice at once. */
const building = new Map<string, Promise<BuildResult>>();

export class BuildStore {
  readonly storeDir: string;
  private readonly workDir: string;
  private readonly runner: Runner;
  private readonly ledger: Ledger;
  private toolchain: string | undefined;

  constructor(stateDir: string, scratchDir: string, runner: Runner, ledger: Ledger) {
    this.runner = runner;
    this.ledger = ledger;
    this.storeDir = join(stateDir, "builds");
    this.workDir = join(scratchDir, "builds");
    mkdirSync(this.storeDir, { recursive: true });
    mkdirSync(this.workDir, { recursive: true });
    // Others may reach a build by its exact path, but not list the store or the work area.
    chmodSync(this.storeDir, 0o711);
    chmodSync(this.workDir, 0o711);
  }

  /** The build key: the sources, the kit's recipe and the toolchain that compiles them. */
  static keyFor(commit: string, kitCommit: string, kit: Kit, toolchain = ""): string {
    return sha256Hex(canonicalJson({ commit, kit_commit: kitCommit, build: kit.build, toolchain }));
  }

  private toolchainId(): string {
    this.toolchain ??= toolchainOf(process.env);
    return this.toolchain;
  }

  /** Verifies a stored build's files against its manifest. Returns the mismatches. */
  verify(dir: string, manifest: BuildManifest): string[] {
    const bad: string[] = [];
    for (const [rel, sha] of Object.entries(manifest.files)) {
      const p = join(dir, rel);
      if (!existsSync(p) || sha256File(p) !== sha) bad.push(rel);
    }
    return bad;
  }

  /**
   * A commit's build with a kit, made once for each key: from the store, or built as `role` (the
   * judge card's builder). While one executor builds a key, another that needs it waits for that
   * build instead of making it again (goal 135).
   */
  ensure(input: BuildInput): Promise<BuildResult> {
    const key = BuildStore.keyFor(input.commit, input.kitCommit, input.kit, this.toolchainId());
    const at = join(this.storeDir, key);
    const going = building.get(at);
    if (going) return going;
    const made = this.make(input, key).finally(() => building.delete(at));
    building.set(at, made);
    return made;
  }

  private async make(input: BuildInput, key: string): Promise<BuildResult> {
    const dir = join(this.storeDir, key);
    const known = this.ledger.builds.get(key);
    if (known?.ok && existsSync(dir)) {
      const manifest = known.manifest as BuildManifest;
      const bad = this.verify(dir, manifest);
      if (bad.length) throw new Error(`build store tampered: ${key} ${bad.join(", ")}`);
      return { ok: true, dir, manifest, cached: true };
    }
    if (known && !known.ok) {
      const m = known.manifest as { reason: string; log: string };
      return { ok: false, key, reason: m.reason, log: m.log, transient: false };
    }

    const work = join(this.workDir, `${key.slice(0, 16)}-${randomUUID().slice(0, 8)}`);
    const src = join(work, "src");
    // Private from the start: the tree and the kit's files are copied in before the hand-over.
    mkdirSync(work, { mode: 0o700 });
    try {
      await exportTree(input.mirror, input.commit, src);
      for (const rel of input.kit.build.copy) {
        cpSync(join(input.kitDir, rel), join(src, ".kit", rel), { recursive: true });
      }
      await this.runner.handOver(work, input.role);
      const started = Date.now();
      const r = await this.runner.run({
        role: input.role,
        argv: input.kit.build.command,
        cwd: src,
        env: {},
        timeoutMs: input.kit.build.timeout_s * 1000,
        rssLimitBytes: input.kit.build.rss_mib * 1024 * 1024,
        disk: { path: work, limitBytes: input.kit.build.disk_mib * 1024 * 1024 },
      });
      await this.runner.reclaim(work);
      const log = `${r.stdout}\n${r.stderr}`.slice(-8000);
      const missing = input.kit.build.outputs.filter((o) => !existsSync(join(src, o)));
      if (r.killedFor) {
        // Killed for time, memory or disk: possibly transient (a loaded host), never cached.
        return { ok: false, key, reason: `build killed (${r.killedFor})`, log, transient: true };
      }
      if (r.exitCode !== 0 || missing.length) {
        const reason = r.killedFor
          ? `build killed (${r.killedFor})`
          : r.exitCode !== 0
            ? `build failed (exit ${r.exitCode ?? r.signal})`
            : `build outputs missing: ${missing.join(", ")}`;
        this.ledger.builds.record({
          key,
          repo: input.repo,
          commit: input.commit,
          kitCommit: input.kitCommit,
          ok: false,
          manifest: { reason, log },
          actor: input.actor,
        });
        return { ok: false, key, reason, log, transient: false };
      }

      const staging = join(this.storeDir, `.tmp-${randomUUID()}`);
      const files: Record<string, string> = {};
      const refused: string[] = [];
      const budget = { entries: 0 };
      for (const rel of input.kit.build.outputs) {
        refused.push(...copyOutput(join(src, rel), join(staging, rel), rel, files, budget, 0));
      }
      if (refused.length) {
        rmSync(staging, { recursive: true, force: true });
        const reason = `build outputs refused: ${refused.slice(0, 5).join("; ")}`;
        this.ledger.builds.record({
          key,
          repo: input.repo,
          commit: input.commit,
          kitCommit: input.kitCommit,
          ok: false,
          manifest: { reason, log },
          actor: input.actor,
        });
        return { ok: false, key, reason, log, transient: false };
      }
      const manifest: BuildManifest = {
        key,
        commit: input.commit,
        kit_commit: input.kitCommit,
        files,
        build_ms: Date.now() - started,
      };
      writeFileSync(join(staging, "manifest.json"), `${canonicalJson(manifest)}\n`, {
        mode: 0o444,
      });
      if (existsSync(dir)) {
        unlock(dir);
        rmSync(dir, { recursive: true, force: true });
      }
      renameSync(staging, dir);
      lockDown(dir);
      this.ledger.builds.record({
        key,
        repo: input.repo,
        commit: input.commit,
        kitCommit: input.kitCommit,
        ok: true,
        manifest,
        actor: input.actor,
      });
      return { ok: true, dir, manifest, cached: false };
    } finally {
      await this.runner.remove(work).catch(() => rmSync(work, { recursive: true, force: true }));
    }
  }
}

/**
 * Copies one build output into the store: regular files and directories only. A symlink, hard
 * link or special file is refused, never followed, so a build cannot point the store (or its
 * chmods) at private files. Every file is hashed and made read-only.
 */
function copyOutput(
  from: string,
  to: string,
  rel: string,
  files: Record<string, string>,
  budget: { entries: number },
  depth: number,
): string[] {
  if (++budget.entries > 20_000) return ["more than 20000 output entries"];
  if (depth > 32) return [`${rel}: deeper than 32 levels`];
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(from);
  } catch {
    return [`${rel}: missing`];
  }
  if (st.isDirectory()) {
    mkdirSync(to, { recursive: true });
    const problems: string[] = [];
    for (const e of readdirSync(from)) {
      problems.push(
        ...copyOutput(join(from, e), join(to, e), `${rel}/${e}`, files, budget, depth + 1),
      );
    }
    return problems;
  }
  if (!st.isFile()) return [`${rel}: not a regular file`];
  if (st.nlink > 1) return [`${rel}: hard link`];
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  files[rel] = sha256File(to);
  chmodSync(to, st.mode & 0o111 ? 0o555 : 0o444);
  return [];
}

function dirsOf(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const d = stack.pop() as string;
    out.push(d);
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (lstatSync(p).isDirectory()) stack.push(p);
    }
  }
  return out;
}

/** Directories become 0555, so nothing inside a build can be added, removed or renamed. */
function lockDown(dir: string): void {
  for (const d of dirsOf(dir).reverse()) chmodSync(d, 0o555);
}

function unlock(dir: string): void {
  chmodSync(dir, 0o755);
  for (const d of dirsOf(dir)) chmodSync(d, 0o755);
}
