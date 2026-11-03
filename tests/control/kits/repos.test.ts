import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import { KitRepos } from "../../../src/control/kits/repos.ts";

describe("kits control writes", () => {
  test("a kit becomes a commit, unchanged files make no new one, and git fetches it over plain HTTP", async () => {
    const repos = new KitRepos(mkdtempSync(join(tmpdir(), "thermite-kits-")));
    const files = {
      "kit.json": Buffer.from('{"name":"demo-kit"}\n'),
      "run/run.sh": Buffer.from("#!/bin/sh\necho run\n"),
      "check/check.sh": Buffer.from("#!/bin/sh\necho check\n"),
    };
    const first = repos.commit("demo-kit", files, "the kit as written on the page");
    assert.match(first, /^[0-9a-f]{40}$/);
    assert.equal(repos.commit("demo-kit", files, "again"), first);
    const second = repos.commit(
      "demo-kit",
      { ...files, "check/expected.txt": Buffer.from("42\n") },
      "a reference added",
    );
    assert.notEqual(second, first);
    assert.equal(repos.head("demo-kit"), second);
    // Only the files a fetch needs are served: never config, hooks or paths outside.
    assert.ok(repos.file("demo-kit", "info/refs"));
    assert.equal(repos.file("demo-kit", "config"), undefined);
    assert.equal(repos.file("demo-kit", "../demo-kit.git/config"), undefined);
    assert.equal(repos.file("../x", "HEAD"), undefined);
    const server = createServer((req, res) => {
      // The path only: git's first request asks for info/refs?service=..., and a plain
      // answer tells it to fetch the plain way.
      const m = /^\/kits\/([^/]+)\.git\/(.+)$/.exec(String(req.url).split("?")[0] ?? "");
      const body = m ? repos.file(m[1] as string, m[2] as string) : undefined;
      if (!body) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/kits/demo-kit.git`;
      const out = join(mkdtempSync(join(tmpdir(), "thermite-clone-")), "kit");
      // Asynchronously: this process serves the requests.
      const run = promisify(execFile);
      await run("git", ["clone", "--quiet", url, out], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        timeout: 60_000,
      });
      assert.equal(readFileSync(join(out, "check/expected.txt"), "utf8"), "42\n");
      assert.equal((await run("git", ["-C", out, "rev-parse", "HEAD"])).stdout.trim(), second);
    } finally {
      server.close();
    }
  });
});
