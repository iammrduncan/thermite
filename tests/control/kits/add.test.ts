import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { serve } from "@hono/node-server";
import { MCP_KIT_BASE64_MAX } from "../../../src/control/kits/add.ts";
import { KIT_BUNDLE_MAX, KitRefused, KitRepos } from "../../../src/control/kits/repos.ts";
import type { SignedCommand } from "../../../src/core/commands.ts";
import { type StageResult, stageCommand } from "../../../src/supervisor/staging.ts";
import { controlOnly, mcpClient } from "../../helpers/control-stack.ts";

/**
 * A kit written elsewhere, given to control as a git bundle of its repository (goal 096): kept
 * with its commits, served to rigs as a kit control keeps, with REST and MCP's token rules.
 */

const KIT_JSON = readFileSync(
  join(import.meta.dirname, "../../../kits/smoke-cpu/kit.json"),
  "utf8",
);

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/**
 * A kit repository with history: two commits on main, a third on a branch, a tag, and a branch
 * whose head has no kit.json. Returns the repository and its commits.
 */
function kitRepo() {
  const dir = join(mkdtempSync(join(tmpdir(), "thermite-kitsrc-")), "lab-kit");
  mkdirSync(dir);
  git(dir, "init", "--quiet", "-b", "main");
  writeFileSync(join(dir, "kit.json"), KIT_JSON);
  writeFileSync(join(dir, "check.mjs"), "console.log(JSON.stringify({ pass: true }));\n");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "the kit as a contract first named it");
  const c1 = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "README.md"), "notes\n");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "notes");
  const c2 = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "--quiet", "-b", "faster");
  writeFileSync(join(dir, "check.mjs"), "console.log(JSON.stringify({ pass: true, n: 2 }));\n");
  git(dir, "commit", "--quiet", "-am", "a faster check");
  const c3 = git(dir, "rev-parse", "HEAD");
  git(dir, "tag", "-a", "v1", "-m", "the first release");
  git(dir, "checkout", "--quiet", "--orphan", "bare");
  git(dir, "rm", "--quiet", "-rf", ".");
  writeFileSync(join(dir, "other.txt"), "no kit here\n");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "no kit.json");
  const orphan = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "--quiet", "main");
  /** A bundle of these refs, as bytes. */
  const bundle = (...refs: string[]) => {
    const file = join(mkdtempSync(join(tmpdir(), "thermite-bundle-")), "kit.bundle");
    git(dir, "bundle", "create", "--quiet", file, ...refs);
    return readFileSync(file);
  };
  return { dir, c1, c2, c3, orphan, bundle };
}

const has = (gitDir: string, commit: string) => {
  try {
    execFileSync("git", ["--git-dir", gitDir, "cat-file", "-e", `${commit}^{commit}`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
};

const refused = async (p: Promise<unknown>, status: number, words: RegExp) => {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof KitRefused, String(err));
    assert.equal(err.status, status);
    assert.match(err.message, words);
    return true;
  });
};

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

const TOKENS = {
  admin: "owner-token-abcdef",
  read: "read-token-abcdef",
  operator: "operator-token-abcdef",
  agent: "agent-token-abcdef",
  rigs: { "rig-a": "rig-token-abcdef" },
};

function control() {
  const kits = new KitRepos(mkdtempSync(join(tmpdir(), "thermite-kits-")));
  const { store, control: api } = controlOnly({ tokens: TOKENS, options: { kits } });
  return { store, kits, api };
}

const text = (r: unknown) =>
  JSON.parse(((r as { content: { text: string }[] }).content[0] as { text: string }).text);

describe("a kit written elsewhere, given to control as a git bundle", () => {
  test("its commits keep their ids, its head is the bundle's, and a rig fetches an older commit from control", async () => {
    const src = kitRepo();
    const root = mkdtempSync(join(tmpdir(), "thermite-kitimport-"));
    const kits = new KitRepos(join(root, "kits"));
    const added = await kits.importBundle("lab-kit", src.bundle("--all"));
    // --all holds HEAD (main): that is the head; every branch and tag comes with it.
    assert.equal(added.head, src.c2);
    assert.equal(added.previous, null);
    assert.equal(added.commits, 2);
    assert.deepEqual(added.kit, { name: "smoke-cpu", target: "cpu" });
    assert.equal(added.forced, false);
    assert.equal(kits.head("lab-kit"), src.c2);
    for (const c of [src.c1, src.c2, src.c3, src.orphan]) assert.ok(has(kits.path("lab-kit"), c));
    assert.deepEqual(
      kits.history("lab-kit").map((h) => h.commit),
      [src.c2, src.c1],
    );
    assert.deepEqual(kits.list(), [{ name: "lab-kit", head: src.c2 }]);
    // The same bundle again changes nothing.
    const again = await kits.importBundle("lab-kit", src.bundle("--all"));
    assert.equal(again.previous, src.c2);
    assert.equal(again.head, src.c2);

    // A rig's supervisor fetches the commit a contract names (not the head) from control, over
    // the route that serves kept kits, with git itself.
    const { control: api } = controlOnly({
      tokens: { admin: "owner-token-abcdef", rigs: { "rig-a": "rig-token-abcdef" } },
      options: { kits },
    });
    const server = serve({ fetch: api.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise((r) => server.once("listening", r));
    try {
      const inboxDir = join(root, "inbox");
      mkdirSync(inboxDir);
      const cfg = {
        rig: "rig-a",
        inboxDir,
        resultsRepo: join(root, "home", "results.git"),
        sourcesDir: join(root, "home", "sources"),
        controlUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        controlToken: "rig-token-abcdef",
      };
      const imports = [
        {
          kind: "kit_bundle",
          path: "repos/kit-lab-kit.bundle",
          repo: "lab-kit",
          commit: src.c1,
          source: { control: "kits/lab-kit" },
        },
      ];
      let r: StageResult = "wait";
      for (let i = 0; i < 400 && r === "wait"; i++) {
        r = await stageCommand(cfg, assign("k-1", imports));
        if (r === "wait") await new Promise((res) => setTimeout(res, 50));
      }
      assert.equal(r, "ready", JSON.stringify(r));
      const heads = git(
        root,
        "bundle",
        "list-heads",
        join(inboxDir, "repos", "kit-lab-kit.bundle"),
      );
      assert.match(heads, new RegExp(`^${src.c1} `));
    } finally {
      server.close();
    }
  });

  test("refusals: names, sizes, bundles that are not, no kit.json, a bad kit.json, no head, a head that goes back", async () => {
    const src = kitRepo();
    const kits = new KitRepos(mkdtempSync(join(tmpdir(), "thermite-kits-")));
    const good = src.bundle("--all");
    await refused(kits.importBundle("Lab-Kit", good), 400, /not a kit name/);
    await refused(kits.importBundle("../x", good), 400, /not a kit name/);
    await refused(kits.importBundle("lab-kit", Buffer.alloc(0)), 400, /empty/);
    await refused(
      kits.importBundle("lab-kit", Buffer.alloc(KIT_BUNDLE_MAX + 1)),
      413,
      /above the 67108864 bytes/,
    );
    await refused(
      kits.importBundle("lab-kit", Buffer.from("not a bundle at all\n")),
      400,
      /^not a git bundle control can take: 'the bundle' does not look like a v2 or v3 bundle file$/,
    );
    // Branches without HEAD: the head is named with ref, which must be in the bundle.
    const two = src.bundle("main", "faster");
    await refused(
      kits.importBundle("lab-kit", two),
      400,
      /no HEAD and 2 branches \(main, faster\)/,
    );
    await refused(
      kits.importBundle("lab-kit", two, { ref: "slower" }),
      400,
      /has no ref slower: it has main, faster/,
    );
    await refused(
      kits.importBundle("lab-kit", src.bundle("bare")),
      400,
      new RegExp(`head ${src.orphan} has no kit.json at its top`),
    );
    // A kit.json the harness would refuse.
    const bad = join(mkdtempSync(join(tmpdir(), "thermite-badkit-")), "k");
    mkdirSync(bad);
    git(bad, "init", "--quiet", "-b", "main");
    writeFileSync(join(bad, "kit.json"), '{"name": "x"}\n');
    git(bad, "add", "-A");
    git(bad, "commit", "--quiet", "-m", "half a kit");
    const badFile = join(bad, "..", "bad.bundle");
    git(bad, "bundle", "create", "--quiet", badFile, "main");
    await refused(
      kits.importBundle("lab-kit", readFileSync(badFile)),
      400,
      /kit\.json at [0-9a-f]{40}: schema_version/,
    );
    // Nothing refused left a kit behind.
    assert.deepEqual(kits.list(), []);

    // A branch by its name, then a tag (peeled to its commit), then a head that goes back.
    const main = await kits.importBundle("lab-kit", two, { ref: "main" });
    assert.equal(main.head, src.c2);
    const tagged = await kits.importBundle("lab-kit", src.bundle("--all"), { ref: "v1" });
    assert.equal(tagged.head, src.c3);
    assert.equal(tagged.forced, false);
    await refused(
      kits.importBundle("lab-kit", src.bundle("main")),
      409,
      new RegExp(`head ${src.c2} does not descend from the kit's head ${src.c3}: give force`),
    );
    assert.equal(kits.head("lab-kit"), src.c3);
    const forced = await kits.importBundle("lab-kit", src.bundle("main"), { force: true });
    assert.equal(forced.head, src.c2);
    assert.equal(forced.forced, true);
    assert.equal(forced.previous, src.c3);
    // The old head's commits stay: a contract that names one still fetches.
    assert.ok(has(kits.path("lab-kit"), src.c3));
    // A commit by its id, in the bundle; one the bundle lacks is refused.
    const byId = await kits.importBundle("lab-kit", src.bundle("--all"), {
      ref: src.c3,
      force: true,
    });
    assert.equal(byId.head, src.c3);
    await refused(
      kits.importBundle("lab-kit", src.bundle("main"), { ref: src.c3, force: true }),
      400,
      new RegExp(`the bundle has no commit ${src.c3}`),
    );
  });

  test("a bundle that builds on the kit's commits is taken; one that needs commits control lacks is not", async () => {
    const src = kitRepo();
    const kits = new KitRepos(mkdtempSync(join(tmpdir(), "thermite-kits-")));
    const tail = src.bundle("main..faster");
    await refused(
      kits.importBundle("lab-kit", tail, { ref: "faster" }),
      400,
      new RegExp(
        `^not a git bundle control can take: Repository lacks these prerequisite commits: ${src.c2}`,
      ),
    );
    await kits.importBundle("lab-kit", src.bundle("main"));
    const on = await kits.importBundle("lab-kit", tail, { ref: "faster" });
    assert.equal(on.head, src.c3);
    assert.equal(on.previous, src.c2);
    assert.equal(on.commits, 3);
  });

  test("REST: the owner's token adds, the reader's reads, refusals in words, kit_added in the audit log", async () => {
    const src = kitRepo();
    const { store, api } = control();
    const post = (path: string, body: Uint8Array, token = TOKENS.admin) =>
      api.request(path, {
        method: "POST",
        body,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/octet-stream",
        },
      });
    const get = (path: string, token = TOKENS.admin) =>
      api.request(path, { headers: { authorization: `Bearer ${token}` } });
    const bundle = new Uint8Array(src.bundle("main"));
    for (const token of ["", TOKENS.read, TOKENS.operator, TOKENS.agent, "rig-token-abcdef"])
      assert.equal((await post("/v1/kits/lab-kit", bundle, token)).status, 401);
    const made = await post("/v1/kits/lab-kit", bundle);
    assert.equal(made.status, 201);
    const answer = (await made.json()) as Record<string, unknown>;
    assert.equal(answer.name, "lab-kit");
    assert.equal(answer.head, src.c2);
    assert.equal(answer.commits, 2);
    assert.deepEqual(answer.kit, { name: "smoke-cpu", target: "cpu" });
    assert.match(
      String(answer.said),
      /Control keeps the kit lab-kit at [0-9a-f]{12} \(2 commits\)/,
    );
    const audit = store.auditLog.list(50, { action: "kit_added" });
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.actor, "owner:api");
    assert.deepEqual(audit[0]?.body, {
      name: "lab-kit",
      head: src.c2,
      previous: null,
      commits: 2,
      forced: false,
      size: bundle.length,
      by: "owner:api",
    });
    // Again: 200, nothing changed.
    const same = await post("/v1/kits/lab-kit", bundle);
    assert.equal(same.status, 200);
    assert.match(String(((await same.json()) as { said: string }).said), /nothing changed/);
    // Forward with ?ref=, back only with ?force=true.
    const all = new Uint8Array(src.bundle("--all"));
    const fwd = await post("/v1/kits/lab-kit?ref=faster", all);
    assert.equal(fwd.status, 200);
    assert.equal(((await fwd.json()) as { head: string }).head, src.c3);
    const back = await post("/v1/kits/lab-kit", bundle);
    assert.equal(back.status, 409);
    assert.match(((await back.json()) as { error: string }).error, /give force/);
    assert.equal((await post("/v1/kits/lab-kit?force=maybe", bundle)).status, 400);
    const forced = await post("/v1/kits/lab-kit?force=true", bundle);
    assert.equal(forced.status, 200);
    assert.equal(((await forced.json()) as { forced: boolean }).forced, true);
    // Refusals in words, and in the audit log.
    const notBundle = await post("/v1/kits/lab-kit", new TextEncoder().encode("{}"));
    assert.equal(notBundle.status, 400);
    assert.match(((await notBundle.json()) as { error: string }).error, /not a git bundle/);
    assert.equal((await post("/v1/kits/Bad_Name", bundle)).status, 400);
    const big = await post("/v1/kits/lab-kit", new Uint8Array(KIT_BUNDLE_MAX + 1));
    assert.equal(big.status, 413);
    assert.match(((await big.json()) as { error: string }).error, /64 MiB/);
    const whys = store.auditLog
      .list(50, { action: "refused" })
      .map((e) => String((e.body as { why?: string }).why));
    for (const why of [/not a git bundle/, /not a kit name/, /64 MiB/, /give force/])
      assert.ok(
        whys.some((w) => why.test(w)),
        `${why} in the audit log`,
      );
    // Reads: the owner's and the reader's tokens; an operator's is MCP's.
    for (const token of [TOKENS.admin, TOKENS.read]) {
      const list = (await (await get("/v1/kits", token)).json()) as { kits: unknown[] };
      assert.deepEqual(list.kits, [
        {
          name: "lab-kit",
          head: src.c2,
          commits: 2,
          kit: { name: "smoke-cpu", target: "cpu" },
        },
      ]);
    }
    assert.equal((await get("/v1/kits", TOKENS.operator)).status, 401);
    const one = (await (await get("/v1/kits/lab-kit", TOKENS.read)).json()) as {
      head: string;
      kit: { cells: string[]; metrics: Record<string, unknown> };
      history: { commit: string; subject: string }[];
    };
    assert.equal(one.head, src.c2);
    assert.deepEqual(one.kit.cells, ["small", "large", "held"]);
    assert.deepEqual(
      one.history.map((h) => h.subject),
      ["notes", "the kit as a contract first named it"],
    );
    assert.equal((await get("/v1/kits/nope")).status, 404);
  });

  test("MCP: kit_add for the owner and an operator, kits for them and the reader, none for agents", async () => {
    const src = kitRepo();
    const { store, api } = control();
    const tools = async (token: string) =>
      (await (await mcpClient(api, token)).listTools()).tools.map((t) => t.name);
    const owner = await tools(TOKENS.admin);
    const operator = await tools(TOKENS.operator);
    const reader = await tools(TOKENS.read);
    const agent = await tools(TOKENS.agent);
    assert.ok(owner.includes("kit_add") && owner.includes("kits"));
    assert.ok(operator.includes("kit_add") && operator.includes("kits"));
    assert.ok(!reader.includes("kit_add") && reader.includes("kits"));
    assert.ok(!agent.includes("kit_add") && !agent.includes("kits"));

    const op = await mcpClient(api, TOKENS.operator);
    const b64 = src.bundle("--all").toString("base64");
    const added = text(
      await op.callTool({ name: "kit_add", arguments: { name: "lab-kit", bundle_base64: b64 } }),
    );
    assert.equal(added.head, src.c2);
    assert.deepEqual(added.kit, { name: "smoke-cpu", target: "cpu" });
    const entry = store.auditLog.list(50, { action: "kit_added" })[0];
    assert.ok(entry);
    assert.equal(entry.actor, "owner:operator");
    assert.equal((entry.body as { size: number }).size, Buffer.from(b64, "base64").length);
    // The call's own entry does not hold the bundle.
    const call = store.auditLog.list(50, { action: "mcp:kit_add" })[0];
    assert.ok(call);
    assert.match(String((call.body as { bundle_base64: string }).bundle_base64), /^given \(…/);

    const back = await op.callTool({
      name: "kit_add",
      arguments: { name: "lab-kit", bundle_base64: b64, ref: "bare" },
    });
    assert.equal(back.isError, true);
    assert.match(text(back).error, /has no kit\.json at its top/);
    const notB64 = await op.callTool({
      name: "kit_add",
      arguments: { name: "lab-kit", bundle_base64: "not base64!" },
    });
    assert.match(text(notB64).error, /not base64/);
    // Above what MCP takes: refused in words that point to REST, under MCP's 4 MiB request.
    const long = await op.callTool({
      name: "kit_add",
      arguments: { name: "lab-kit", bundle_base64: "A".repeat(MCP_KIT_BASE64_MAX + 4) },
    });
    assert.match(text(long).error, /above the 4000000 MCP takes: send the bundle over REST/);

    const rd = await mcpClient(api, TOKENS.read);
    const list = text(await rd.callTool({ name: "kits", arguments: {} }));
    assert.deepEqual(list.kits[0], {
      name: "lab-kit",
      head: src.c2,
      commits: 2,
      kit: { name: "smoke-cpu", target: "cpu" },
    });
    const one = text(await rd.callTool({ name: "kits", arguments: { name: "lab-kit" } }));
    assert.equal(one.history.length, 2);
    const none = await rd.callTool({ name: "kits", arguments: { name: "nope" } });
    assert.match(text(none).error, /control keeps no kit nope/);
  });
});
