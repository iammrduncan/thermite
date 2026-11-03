import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { KitRepos } from "../../../src/control/kits/repos.ts";
import { controlOnly } from "../../helpers/control-stack.ts";

const run = promisify(execFile);
const CLI = join(import.meta.dirname, "../../../src/cli/thermite/main.ts");
const CONTRACT = join(import.meta.dirname, "../../../examples/contracts/smoke-cpu-goal.json");
const KIT_JSON = join(import.meta.dirname, "../../../kits/smoke-cpu/kit.json");

async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await run(process.execPath, [
      "--experimental-strip-types",
      "--no-warnings",
      CLI,
      ...args,
    ]);
    return { code: 0, ...r };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

describe("thermite kit (goal 096)", () => {
  test("kit add gives control a kit's bundle, kit list shows it, and assign --kit control:NAME fetches it from control", async () => {
    const root = mkdtempSync(join(tmpdir(), "thermite-cli-kit-"));
    const repo = join(root, "lab-kit");
    mkdirSync(repo);
    git(repo, "init", "--quiet", "-b", "main");
    writeFileSync(join(repo, "kit.json"), readFileSync(KIT_JSON));
    git(repo, "add", "-A");
    git(repo, "commit", "--quiet", "-m", "the kit");
    const head = git(repo, "rev-parse", "HEAD");
    const bundle = join(root, "kit.bundle");
    git(repo, "bundle", "create", "--quiet", bundle, "main");
    const tokenFile = join(root, "token");
    writeFileSync(tokenFile, "owner-token-abcdef\n");
    const readFile = join(root, "read");
    writeFileSync(readFile, "read-token-abcdef\n");

    const { control: api } = controlOnly({
      tokens: { admin: "owner-token-abcdef", read: "read-token-abcdef", rigs: {} },
      options: { kits: new KitRepos(join(root, "kits")) },
    });
    const server = serve({ fetch: api.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const added = await cli(
        "kit",
        "add",
        "lab-kit",
        bundle,
        "--control",
        url,
        "--token-file",
        tokenFile,
      );
      assert.equal(added.code, 0, added.stderr);
      assert.equal(JSON.parse(added.stdout).head, head);
      assert.match(added.stderr, /Control keeps the kit lab-kit at [0-9a-f]{12} \(1 commit\)/);
      // The reader's token reads, never adds.
      const list = await cli("kit", "list", "--control", url, "--token-file", readFile);
      assert.equal(list.code, 0, list.stderr);
      assert.equal(list.stdout, `lab-kit  ${head}  1 commit  smoke-cpu on cpu\n`);
      const no = await cli(
        "kit",
        "add",
        "lab-kit",
        bundle,
        "--control",
        url,
        "--token-file",
        readFile,
      );
      assert.equal(no.code, 2);
      assert.match(no.stderr, /control refused the kit \(401\)/);
      // A file that is not a bundle: control's words.
      const notBundle = join(root, "not.bundle");
      writeFileSync(notBundle, "hello\n");
      const bad = await cli(
        "kit",
        "add",
        "lab-kit",
        notBundle,
        "--control",
        url,
        "--token-file",
        tokenFile,
      );
      assert.equal(bad.code, 2);
      assert.match(bad.stderr, /control refused the kit \(400\): not a git bundle/);
    } finally {
      server.close();
    }

    // The assignment's kit import names control as its source.
    const printed = await cli(
      "assign",
      "--contract",
      CONTRACT,
      "--run",
      "r-1",
      "--seed-commit",
      "0123456789abcdef0123456789abcdef01234567",
      "--kit",
      "control:lab-kit",
      "--print",
    );
    assert.equal(printed.code, 0, printed.stderr);
    const kit = (JSON.parse(printed.stdout) as { imports: { kind: string; source: unknown }[] })
      .imports[0];
    assert.equal(kit?.kind, "kit_bundle");
    assert.deepEqual(kit?.source, { control: "kits/lab-kit" });
    const wrong = await cli(
      "assign",
      "--contract",
      CONTRACT,
      "--run",
      "r-1",
      "--seed-commit",
      "0123456789abcdef0123456789abcdef01234567",
      "--kit",
      "control:Lab Kit",
      "--print",
    );
    assert.equal(wrong.code, 2);
    assert.match(wrong.stderr, /--kit control:NAME names a kit control keeps/);
  });
});
