import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { serve } from "@hono/node-server";
import { KitRepos } from "../../src/control/kits/repos.ts";
import type { SignedCommand } from "../../src/core/commands.ts";
import { relayOnce } from "../../src/supervisor/relay/index.ts";
import { type StageResult, stageCommand } from "../../src/supervisor/staging.ts";
import { controlOnly, controlStack } from "../helpers/control-stack.ts";
import { makeJudgeEnv } from "../helpers/judge-env.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

/** An assign command as the relay sees it (staging reads the envelope, not the signature). */
const assign = (id: string, imports: unknown[]): SignedCommand =>
  ({
    envelope: {
      v: 1,
      id,
      rig: "rig-a",
      kind: "assign_campaign",
      issued_by: "owner:api",
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      payload: { run: "r-1", imports },
    },
    signature: "",
  }) as unknown as SignedCommand;

/** Asks again, as the relay does on each poll, until staging stops waiting. */
async function staged(cfg: Parameters<typeof stageCommand>[0], cmd: SignedCommand) {
  for (let i = 0; i < 200; i++) {
    const r: StageResult = await stageCommand(cfg, cmd);
    if (r !== "wait") return r;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("staging never finished");
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "thermite-stage-"));
  const inboxDir = join(root, "inbox");
  mkdirSync(inboxDir);
  const cfg = {
    rig: "rig-a",
    inboxDir,
    resultsRepo: join(root, "home", "results.git"),
    sourcesDir: join(root, "home", "sources"),
  };
  return { root, inboxDir, cfg };
}

describe("staging sources by reference", () => {
  test("a kit control keeps is fetched from control, as this rig and with its token only", async () => {
    const { root, inboxDir, cfg } = setup();
    const kits = new KitRepos(join(root, "control-kits"));
    const commit = kits.commit(
      "demo-kit",
      { "kit.json": Buffer.from("{}\n"), "run/run.sh": Buffer.from("echo run\n") },
      "written on the page",
    );
    const { control } = controlOnly({
      tokens: { admin: "owner-token-abcdef", rigs: { "rig-a": "rig-token-abcdef" } },
      options: { kits },
    });
    const server = serve({ fetch: control.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise((r) => server.once("listening", r));
    const controlUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const imports = [
        {
          kind: "kit_bundle",
          path: "repos/kit-demo.bundle",
          repo: "demo-kit",
          commit,
          source: { control: "kits/demo-kit" },
        },
      ];
      // Without the rig's token, control serves nothing.
      const refused = await staged(
        { ...cfg, controlUrl, controlToken: "wrong-token-abcdef" },
        assign("k-1", imports),
      );
      assert.equal(typeof refused, "object");
      assert.ok(!existsSync(join(inboxDir, "repos", "kit-demo.bundle")));
      const ok = await staged(
        { ...cfg, controlUrl, controlToken: "rig-token-abcdef" },
        assign("k-2", imports),
      );
      assert.equal(ok, "ready");
      const heads = git(root, "bundle", "list-heads", join(inboxDir, "repos", "kit-demo.bundle"));
      assert.match(heads, new RegExp(`^${commit} `));
      // A supervisor with no control to ask says so, rather than fetching from anywhere else.
      const none = await staged(cfg, assign("k-3", [{ ...imports[0], path: "repos/k3.bundle" }]));
      assert.match(JSON.stringify(none), /no control to ask/);
    } finally {
      server.close();
    }
  });

  test("a project's commit is fetched from its repository and lands in the inbox as a bundle", async () => {
    const { root, inboxDir, cfg } = setup();
    chmodSync(inboxDir, 0o755);
    const repo = join(root, "project");
    mkdirSync(repo);
    git(repo, "init", "--quiet", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, "add", "-A");
    git(repo, "commit", "--quiet", "-m", "one");
    const first = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "a.txt"), "two\n");
    git(repo, "commit", "--quiet", "-am", "two");
    const imports = [
      {
        kind: "repo_bundle",
        path: "repos/project-first.bundle",
        repo: "project",
        commit: first,
        source: { git: `file://${repo}` },
      },
    ];
    assert.equal(await stageCommand(cfg, assign("c-1", imports)), "wait");
    assert.equal(await staged(cfg, assign("c-1", imports)), "ready");
    const bundle = join(inboxDir, "repos", "project-first.bundle");
    // The bundle holds the named commit (not just the branch tip), with its history.
    const heads = git(root, "bundle", "list-heads", bundle);
    assert.match(heads, new RegExp(`^${first} refs/thermite/stage/${first}$`));
    // Already there: the next command naming it relays at once, without fetching.
    assert.equal(await stageCommand(cfg, assign("c-2", imports)), "ready");
    // Under compose and on a machine the inbox lets other users in (the harness's controller is
    // one of them): the bundle does too.
    assert.equal(statSync(bundle).mode & 0o777, 0o644);
  });

  test("a bundle in an inbox closed to other users is read by the inbox's group only", async () => {
    const { root, inboxDir, cfg } = setup();
    // As the one-container image and a cluster's volume have it: the supervisor's, with the
    // controller's group, closed to everyone else.
    chmodSync(inboxDir, 0o2750);
    const repo = join(root, "kit");
    mkdirSync(repo);
    git(repo, "init", "--quiet", "-b", "main");
    writeFileSync(join(repo, "kit.json"), "{}\n");
    git(repo, "add", "-A");
    git(repo, "commit", "--quiet", "-m", "kit");
    const commit = git(repo, "rev-parse", "HEAD");
    const imports = [
      {
        kind: "kit_bundle",
        path: "repos/kit.bundle",
        repo: "kit",
        commit,
        source: { git: `file://${repo}` },
      },
    ];
    assert.equal(await staged(cfg, assign("k-closed", imports)), "ready");
    assert.equal(statSync(join(inboxDir, "repos", "kit.bundle")).mode & 0o777, 0o640);
  });

  test("a model is downloaded and kept only with the signed hash; a missing commit fails", async () => {
    const { root, inboxDir, cfg } = setup();
    const bytes = Buffer.from("weights ".repeat(1000));
    const server = createServer((req, res) => {
      if (req.url === "/model.bin") res.end(bytes);
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const sha = createHash("sha256").update(bytes).digest("hex");
    try {
      const model = (sha256: string, path: string) => ({
        kind: "model",
        path,
        name: "m",
        sha256,
        source: { url: `${base}/model.bin` },
      });
      assert.equal(await staged(cfg, assign("m-1", [model(sha, "models/m.bin")])), "ready");
      assert.deepEqual(readFileSync(join(inboxDir, "models", "m.bin")), bytes);
      const wrong = await staged(cfg, assign("m-2", [model("0".repeat(64), "models/w.bin")]));
      assert.match(JSON.stringify(wrong), /staging: model m from .* refused: its SHA-256 is /);
      assert.ok(!existsSync(join(inboxDir, "models", "w.bin")), "a wrong file never lands");
      const repo = join(root, "empty");
      mkdirSync(repo);
      git(repo, "init", "--quiet", "--bare");
      const missing = await staged(
        cfg,
        assign("g-1", [
          {
            kind: "kit_bundle",
            path: "repos/kit.bundle",
            repo: "kit",
            commit: "b".repeat(40),
            source: { git: `file://${repo}` },
          },
        ]),
      );
      assert.match(JSON.stringify(missing), /has no commit b{40}/);
    } finally {
      server.close();
    }
  });

  test("a command transport is never run, whatever the URL says", async () => {
    const { root, cfg } = setup();
    const marker = join(root, "ran");
    const r = await staged(
      cfg,
      assign("x-1", [
        {
          kind: "repo_bundle",
          path: "repos/x.bundle",
          repo: "x",
          commit: "c".repeat(40),
          source: { git: `ext::sh -c touch% ${marker}` },
        },
      ]),
    );
    assert.notEqual(r, "ready");
    assert.ok(!existsSync(marker));
  });

  test("a project in a folder of its repository: the rig fetches the repository and starts from the folder", async () => {
    const s = controlStack({ env: makeJudgeEnv({ folder: "examples/sum" }) });
    const { env, store } = s;
    const payload = (env.assign as unknown as SignedCommand).envelope.payload as Record<
      string,
      unknown
    >;
    assert.equal(
      (payload.contract as { project: { folder?: string } }).project.folder,
      "examples/sum",
    );
    const r = await s.api("POST", "/v1/commands", {
      rig: "rig-a",
      kind: "assign_campaign",
      payload: {
        ...payload,
        imports: [
          {
            kind: "repo_bundle",
            path: "repos/folder-project.bundle",
            repo: "proj",
            commit: env.seed,
            source: { git: `file://${join(env.root, "project")}` },
          },
          {
            kind: "kit_bundle",
            path: "repos/folder-kit.bundle",
            repo: "js-kit",
            commit: env.kitCommit,
            source: { git: `file://${join(env.root, "kit")}` },
          },
        ],
      },
    });
    assert.equal(r.status, 201, await r.clone().text());
    const id = ((await r.json()) as { id: string }).id;
    const stagingCfg = {
      rig: "rig-a",
      inboxDir: env.paths.inboxDir,
      resultsRepo: join(env.root, "supervisor", "results.git"),
      sourcesDir: join(env.root, "supervisor", "sources"),
    };
    const cfg = { ...s.cfg, stage: (cmd: SignedCommand) => stageCommand(stagingCfg, cmd) };
    let state = { cursor: 0 };
    for (let i = 0; i < 200 && store.commands.get(id)?.status === "pending"; i++) {
      state = await relayOnce(cfg, state);
      await new Promise((res) => setTimeout(res, 25));
    }
    assert.equal(
      store.commands.get(id)?.status,
      "delivered",
      JSON.stringify(store.commands.get(id)),
    );
    // The supervisor fetched the whole repository's commit, which the harness checked.
    const bundle = join(env.paths.inboxDir, "repos", "folder-project.bundle");
    assert.match(git(env.root, "bundle", "list-heads", bundle), new RegExp(`^${env.seed} `));
    // The run starts from the folder: its tree, and none of the repository's other files.
    const start = env.ledger.runs.get("js-1")?.seed_commit ?? "";
    const mirror = env.service.mirrorFor("proj");
    assert.equal(
      git(mirror, "rev-parse", `${start}^{tree}`),
      git(mirror, "rev-parse", `${env.seed}:examples/sum`),
    );
    assert.deepEqual(git(mirror, "ls-tree", "--name-only", start).split("\n"), [
      "README.md",
      "src",
    ]);
    // The rig's answer names where the run starts.
    const outcome = store.commands.get(id)?.outcome as { result?: { start?: unknown } };
    assert.deepEqual(outcome.result?.start, { folder: "examples/sum", commit: start });
  });

  test("an assignment that names its project and kit by URL starts a run, with nothing put in the inbox by hand", async () => {
    const s = controlStack();
    const { env, store } = s;
    const payload = (env.assign as unknown as SignedCommand).envelope.payload as Record<
      string,
      unknown
    >;
    const issue = async (body: Record<string, unknown>) => {
      const r = await s.api("POST", "/v1/commands", {
        rig: "rig-a",
        kind: "assign_campaign",
        payload: body,
      });
      assert.equal(r.status, 201, await r.clone().text());
      return ((await r.json()) as { id: string }).id;
    };
    const sources = {
      ...payload,
      imports: [
        {
          kind: "repo_bundle",
          path: "repos/fetched-project.bundle",
          repo: "proj",
          commit: env.seed,
          source: { git: `file://${join(env.root, "project")}` },
        },
        {
          kind: "kit_bundle",
          path: "repos/fetched-kit.bundle",
          repo: "js-kit",
          commit: env.kitCommit,
          source: { git: `file://${join(env.root, "kit")}` },
        },
      ],
    };
    const id = await issue(sources);
    const stagingCfg = {
      rig: "rig-a",
      inboxDir: env.paths.inboxDir,
      resultsRepo: join(env.root, "supervisor", "results.git"),
      sourcesDir: join(env.root, "supervisor", "sources"),
    };
    const cfg = { ...s.cfg, stage: (cmd: SignedCommand) => stageCommand(stagingCfg, cmd) };
    let state = { cursor: 0 };
    for (let i = 0; i < 200 && store.commands.get(id)?.status === "pending"; i++) {
      state = await relayOnce(cfg, state);
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(
      store.commands.get(id)?.status,
      "delivered",
      JSON.stringify(store.commands.get(id)),
    );
    assert.equal(env.ledger.runs.get("js-1")?.status, "running");
    assert.ok(existsSync(join(env.paths.inboxDir, "repos", "fetched-project.bundle")));
    assert.ok(existsSync(join(env.paths.inboxDir, "repos", "fetched-kit.bundle")));
  });
});
