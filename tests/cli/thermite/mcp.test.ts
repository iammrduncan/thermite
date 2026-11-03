import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { SecretBox } from "../../../src/control/secrets.ts";
import { controlOnly } from "../../helpers/control-stack.ts";
import { startFakeMcp } from "../../helpers/fake-mcp.ts";

const run = promisify(execFile);
const CLI = join(import.meta.dirname, "../../../src/cli/thermite/main.ts");
/** Control's tokens: the owner's, as the token files below hold it, and no rigs. */
const TOKENS = { admin: "owner-token-abcdef", rigs: {} };
/** A made-up key, read from a file: never on the command line, never printed back. */
const KEY = "Bearer clikeyforthetestsonly";

describe("thermite mcp", () => {
  test("add reads the secret from a file and reads the tools; list shows the hint; delete forgets it", async () => {
    const fake = await startFakeMcp({ kind: "bearer", token: KEY.slice(7) });
    const { control: api } = controlOnly({
      tokens: TOKENS,
      options: { secrets: SecretBox.ephemeral() },
    });
    const server = serve({ fetch: api.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise((r) => server.once("listening", r));
    const control = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const dir = mkdtempSync(join(tmpdir(), "thermite-mcp-"));
      const owner = join(dir, "owner-token");
      writeFileSync(owner, "owner-token-abcdef\n", { mode: 0o600 });
      const secret = join(dir, "key");
      writeFileSync(secret, `${KEY}\n`, { mode: 0o600 });
      const cli = (...args: string[]) =>
        run(process.execPath, [
          "--experimental-strip-types",
          "--no-warnings",
          CLI,
          "mcp",
          ...args,
          "--control",
          control,
          "--token-file",
          owner,
        ]);
      const added = await cli(
        "add",
        "gbrain",
        "--url",
        fake.url,
        "--auth",
        "key",
        "--secret-file",
        secret,
      );
      assert.match(added.stdout, /^gbrain {2}key …only {2}ok {2}3 tools/);
      assert.match(added.stdout, /put_page \(writes\)/);
      const listed = await cli("list");
      assert.match(listed.stdout, /gbrain {2}key …only {2}ok/);
      assert.ok(!`${added.stdout}${listed.stdout}`.includes("clikeyforthetests"));
      const json = JSON.parse((await cli("list", "--json")).stdout) as { servers: unknown[] };
      assert.equal(json.servers.length, 1);
      const gone = await cli("delete", "gbrain");
      assert.match(gone.stdout, /gbrain is deleted/);
      assert.match((await cli("list")).stdout, /no MCP server in Settings/);
    } finally {
      server.close();
      await fake.close();
    }
  });

  test("the usage names every option change takes, --auth among them", async () => {
    const help = await run(process.execPath, [
      "--experimental-strip-types",
      "--no-warnings",
      CLI,
      "help",
    ]);
    const change = /\n {2}mcp change NAME ([^\n]*\n {10}[^\n]*)/.exec(help.stdout)?.[1] ?? "";
    for (const option of [
      "--url URL",
      "--auth oauth|key|client|none",
      "--header H",
      "--secret-file F",
      "--client-id ID",
      "--client-secret-file F",
      "--scope S",
    ])
      assert.ok(change.includes(`[${option}]`), `${option} in: ${change}`);
  });
});
