import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSha } from "../../src/core/canonical.ts";
import {
  type CommandKind,
  generateSigningKeys,
  type SignedCommand,
  signEnvelope,
} from "../../src/core/commands.ts";
import { parseContract } from "../../src/core/contract.ts";
import { Ledger } from "../../src/harness/ledger/index.ts";
import { HarnessService } from "../../src/harness/service/index.ts";
import { hillClimbFixture } from "./fixtures.ts";

/** A throwaway harness with a real git source repo bundled into its inbox. */
export interface HarnessEnv {
  root: string;
  service: HarnessService;
  keys: ReturnType<typeof generateSigningKeys>;
  seedCommit: string;
  sourceRepo: string;
  sign(
    kind: CommandKind,
    payload: unknown,
    over?: { rig?: string; expiresInMs?: number; issuedBy?: string },
  ): SignedCommand;
  assignPayload(over?: Record<string, unknown>): Record<string, unknown>;
  patchFrom(edit: (dir: string) => void): string;
}

function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
}

export function makeHarnessEnv(rig = "rig-a", clock?: () => Date): HarnessEnv {
  const root = mkdtempSync(join(tmpdir(), "thermite-harness-"));
  const paths = {
    stateDir: join(root, "state"),
    scratchDir: join(root, "scratch"),
    inboxDir: join(root, "inbox"),
    outboxDir: join(root, "outbox"),
  };
  for (const d of Object.values(paths)) mkdirSync(d, { recursive: true });
  const sourceRepo = join(root, "source");
  mkdirSync(join(sourceRepo, "src", "kernel"), { recursive: true });
  mkdirSync(join(sourceRepo, "bench"), { recursive: true });
  const git = (...args: string[]) =>
    sh(sourceRepo, "git", [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@localhost",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ]);
  git("init", "--quiet", "-b", "main");
  writeFileSync(join(sourceRepo, "src", "kernel", "k.c"), "int k(int x) { return x * 2; }\n");
  writeFileSync(join(sourceRepo, "bench", "timer.c"), "/* timer */\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "seed");
  const seedCommit = git("rev-parse", "HEAD").trim();
  mkdirSync(join(paths.inboxDir, "repos"), { recursive: true });
  git("bundle", "create", "--quiet", join(paths.inboxDir, "repos", "smoke.bundle"), "--all");

  const keys = generateSigningKeys();
  const ledger = Ledger.open(join(paths.stateDir, "ledger", "ledger.db"), clock);
  const service = new HarnessService({
    rig,
    ledger,
    paths,
    controlPublicKeyPem: keys.publicKeyPem,
    rigKeys: generateSigningKeys(),
    clock,
  });

  const sign = (
    kind: CommandKind,
    payload: unknown,
    over: { rig?: string; expiresInMs?: number; issuedBy?: string } = {},
  ) =>
    signEnvelope(
      {
        v: 1,
        id: randomUUID(),
        rig: over.rig ?? rig,
        kind,
        issued_by: over.issuedBy ?? "owner",
        issued_at: new Date(Date.now() - 1000).toISOString(),
        expires_at: new Date(Date.now() + (over.expiresInMs ?? 3_600_000)).toISOString(),
        payload,
      },
      keys.privateKeyPem,
    );

  const assignPayload = (over: Record<string, unknown> = {}) => {
    const contractInput = {
      ...hillClimbFixture,
      project: { repo: "smoke-kernels", commit: seedCommit },
    };
    const parsed = parseContract(contractInput);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    return {
      run: "smoke-1",
      contract: parsed.contract,
      contract_sha: parsed.sha,
      seed: { repo: "smoke-kernels", commit: seedCommit },
      imports: [
        {
          kind: "repo_bundle",
          path: "repos/smoke.bundle",
          repo: "smoke-kernels",
          commit: seedCommit,
        },
      ],
      ...over,
    };
  };

  const patchFrom = (edit: (dir: string) => void): string => {
    const wt = join(root, `wt-${randomUUID().slice(0, 8)}`);
    sh(root, "git", ["clone", "--quiet", sourceRepo, wt]);
    edit(wt);
    sh(wt, "git", ["add", "-A"]);
    const diff = execFileSync("git", ["diff", "--cached", "--binary"], { cwd: wt });
    return diff.toString("base64");
  };

  return { root, service, keys, seedCommit, sourceRepo, sign, assignPayload, patchFrom };
}

export { canonicalSha };
