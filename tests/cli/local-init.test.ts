import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import {
  chooseOwner,
  LOCAL_TOKEN_FILES,
  localInit,
  readStackCompose,
  writeGpuOverride,
} from "../../src/cli/local-init.ts";
import { GPU_OVERRIDE } from "../../src/cli/machine.ts";

const run = promisify(execFile);
const CLI = join(import.meta.dirname, "../../src/cli/thermite/main.ts");
const DEV_INIT = join(import.meta.dirname, "..", "..", "scripts", "dev", "init.mjs");

/** Every path under `root`, relative, with its type and permission bits. */
function tree(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, rel)).sort()) {
    const path = rel ? `${rel}/${name}` : name;
    const s = statSync(join(root, path));
    out.push(`${s.isDirectory() ? "d" : "f"} ${(s.mode & 0o777).toString(8)} ${path}`);
    if (s.isDirectory()) out.push(...tree(root, path));
  }
  return out;
}

const fresh = () => join(mkdtempSync(join(tmpdir(), "thermite-local-")), ".dev");
const secret = (root: string, name: string) =>
  readFileSync(join(root, "secrets", name), "utf8").trim();

describe("thermite local init", () => {
  test("makes every token, folder and the rig tokens map", () => {
    const root = fresh();
    const { made, kept } = localInit(root);
    assert.deepEqual(kept, []);
    assert.ok(made.includes("secrets/control-admin-token"));
    const tokens = LOCAL_TOKEN_FILES.map((name) => secret(root, name));
    for (const t of tokens) assert.match(t, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(new Set(tokens).size, tokens.length, "every token is its own");
    assert.equal(secret(root, "model-api-key"), "local-placeholder");
    assert.deepEqual(JSON.parse(secret(root, "control-rig-tokens.json")), {
      "local-1": secret(root, "control-rig-token"),
      "local-2": secret(root, "control-rig-token-2"),
    });
    // .dev/ is its owner's alone: no other user of the computer reaches what is in it.
    assert.equal(statSync(root).mode & 0o777, 0o700);
    // Below it, the containers' own users read the tokens, and the supervisor's writes the inbox.
    const fileMode = 0o644 & ~process.umask();
    assert.equal(statSync(join(root, "secrets/control-admin-token")).mode & 0o777, fileMode);
    for (const dir of ["inbox", "inbox/repos", "inbox/models"])
      assert.equal(statSync(join(root, dir)).mode & 0o777, 0o777, dir);
    for (const dir of ["outbox", "advisors", "backups"])
      assert.ok(statSync(join(root, dir)).isDirectory());
  });

  test("keeps every file that exists and writes the rig tokens map again", () => {
    const root = fresh();
    localInit(root);
    // A .dev/ that others could enter is closed again.
    chmodSync(root, 0o755);
    const admin = secret(root, "control-admin-token");
    writeFileSync(join(root, "secrets/control-rig-token"), "changed-by-hand\n");
    writeFileSync(join(root, "secrets/model-api-key"), "sk-real-key\n");
    const again = localInit(root);
    assert.deepEqual(again.made, []);
    assert.equal(again.kept.length, LOCAL_TOKEN_FILES.length + 1);
    assert.equal(secret(root, "control-admin-token"), admin);
    assert.equal(secret(root, "model-api-key"), "sk-real-key");
    assert.equal(JSON.parse(secret(root, "control-rig-tokens.json"))["local-1"], "changed-by-hand");
    assert.equal(statSync(root).mode & 0o777, 0o700);
  });

  test("writes the model key's placeholder whatever other key files the folder has", () => {
    const root = fresh();
    mkdirSync(join(root, "secrets"), { recursive: true });
    // The file name Thermite's first deployment used: no longer read.
    writeFileSync(join(root, "secrets/qwen-api-key"), "sk-old-name");
    localInit(root);
    assert.equal(secret(root, "model-api-key"), "local-placeholder");
  });

  test("makes the same layout as npm run dev:init", async () => {
    const checkout = mkdtempSync(join(tmpdir(), "thermite-devinit-"));
    await run(process.execPath, [DEV_INIT], { cwd: checkout });
    const root = fresh();
    localInit(root);
    assert.deepEqual(tree(root), tree(join(checkout, ".dev")));
    assert.equal(statSync(join(checkout, ".dev")).mode & 0o777, 0o700);
  });

  test("chooses the folder's owner only when it runs as root for someone else", () => {
    const user = { uid: 1000, gid: 1000 };
    assert.deepEqual(chooseOwner(0, user), user);
    assert.equal(chooseOwner(0, { uid: 0, gid: 0 }), undefined);
    assert.equal(chooseOwner(1000, user), undefined);
    assert.equal(chooseOwner(undefined, user), undefined);
    assert.equal(chooseOwner(0, undefined), undefined);
  });

  test("gives what it makes, and only that, to the owner", (t) => {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    const other = process.getgroups?.().find((g) => g !== gid);
    if (uid === undefined || other === undefined) {
      t.skip("needs a second group of this user to give files to");
      return;
    }
    const root = fresh();
    mkdirSync(join(root, "secrets"), { recursive: true });
    writeFileSync(join(root, "secrets/control-admin-token"), "kept\n");
    // A new file takes its folder's group on some systems, so compare with what it had.
    const keptGid = statSync(join(root, "secrets/control-admin-token")).gid;
    assert.notEqual(keptGid, other);
    const { made } = localInit(root, { uid, gid: other });
    assert.equal(made.length, 15);
    for (const rel of made) assert.equal(statSync(join(root, rel)).gid, other, rel);
    assert.equal(statSync(join(root, "secrets/control-admin-token")).gid, keptGid);
  });

  test("the command prints what it made, never a token", async () => {
    const root = fresh();
    const cli = (...args: string[]) =>
      run(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args]);
    const first = await cli("local", "init", root);
    assert.match(first.stdout, /^made \.dev\nmade \.dev\/secrets\n/);
    assert.match(first.stdout, /made \.dev\/secrets\/control-admin-token\n/);
    assert.match(first.stdout, /local init: \.dev ready \(18 made, 0 kept\)\n$/);
    for (const name of LOCAL_TOKEN_FILES) assert.ok(!first.stdout.includes(secret(root, name)));
    const second = await cli("local", "init", root);
    // Before its last line, it says what the rig gets on the machine that runs the test.
    const lines = second.stdout.trimEnd().split("\n");
    assert.equal(lines.at(-1), "local init: .dev ready (0 made, 9 kept)");
    assert.ok(lines.length >= 2, "it says what the rig gets");
    for (const line of lines.slice(0, -1))
      assert.match(line, new RegExp(`^(rig: [A-Z]|wrote ${GPU_OVERRIDE}: start Thermite with )`));
    await assert.rejects(cli("local", "init"), (e: { code?: number }) => e.code === 2);
    await assert.rejects(
      cli("local", "init", root, "--engine", "lxc"),
      (e: { code?: number; stderr?: string }) =>
        e.code === 2 && /--engine is docker or podman/.test(e.stderr ?? ""),
    );
  });

  test("compose.gpu.yaml goes next to .dev, through a link to it, and is written again", () => {
    const root = fresh();
    localInit(root);
    const stack = dirname(root);
    writeFileSync(join(stack, "compose.yaml"), "name: thermite\n");
    // A source checkout links the release's .dev folder as its own.
    const source = mkdtempSync(join(tmpdir(), "thermite-source-"));
    symlinkSync(root, join(source, ".dev"));
    assert.equal(readStackCompose(join(source, ".dev")), "name: thermite\n");
    const path = writeGpuOverride(join(source, ".dev"), "services: {}\n");
    // macOS's temporary folder is behind a link: the path is the resolved one.
    assert.equal(path, join(realpathSync(stack), GPU_OVERRIDE));
    assert.equal(readFileSync(path, "utf8"), "services: {}\n");
    assert.equal(statSync(path).mode & 0o777, 0o644);
    writeGpuOverride(root, "services:\n  harness: {}\n");
    assert.equal(readFileSync(path, "utf8"), "services:\n  harness: {}\n");
    assert.equal(readStackCompose(join(source, "missing")), undefined);
  });
});
