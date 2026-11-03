import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { controlOnly } from "../../helpers/control-stack.ts";

/**
 * thermite retention: the owner's retention policies from the command line, with the owner's
 * token, as Settings › Retention policies has them; another token is refused.
 */

const run = promisify(execFile);
const CLI = join(import.meta.dirname, "../../../src/cli/thermite/main.ts");
const OWNER = "owner-token-abcdef";

describe("thermite retention", () => {
  test("create, list, preview, update, on, run, removals and delete, with the owner's token", async () => {
    const root = mkdtempSync(join(tmpdir(), "thermite-cli-retention-"));
    const { control: api, store } = controlOnly({ tokens: { admin: OWNER } });
    store.db
      .prepare(
        "insert into audit (at, actor, action, body) values (?, 'owner:api', 'old_thing', '{}')",
      )
      .run(new Date(Date.now() - 100 * 86_400_000).toISOString());
    const server = serve({ fetch: api.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise((r) => server.once("listening", r));
    const control = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const token = join(root, "owner-token");
      writeFileSync(token, `${OWNER}\n`, { mode: 0o600 });
      const as = (tokenFile: string, ...args: string[]) =>
        run(process.execPath, [
          "--experimental-strip-types",
          "--no-warnings",
          CLI,
          "retention",
          ...args,
          "--control",
          control,
          "--token-file",
          tokenFile,
        ]);
      const cli = (...args: string[]) => as(token, ...args);

      assert.equal(
        (await cli("list")).stdout,
        "no retention policy: Thermite keeps everything, everywhere\n",
      );
      const design = ["--name", "Old audit", "--kind", "audit", "--rule", "older", "--older", "30"];
      const preview = await cli("preview", ...design);
      assert.match(preview.stdout, /^It would remove 1 entry, /);
      const made = await cli("create", ...design);
      assert.match(
        made.stdout,
        /^Saved “Old audit”, off\.\n1 {2}off {2}Old audit {2}audit {2}control: removes older than 30 days, off/,
      );
      const changed = await cli(
        "update",
        "1",
        "--older",
        "60",
        "--when",
        "weekly",
        "--day",
        "monday",
      );
      assert.match(changed.stdout, /removes older than 60 days/);
      assert.equal(store.retention.get(1)?.day, "monday");
      assert.equal(store.retention.get(1)?.name, "Old audit", "what was not given stays");
      assert.match((await cli("on", "1")).stdout, /is on: it runs every Monday at 03:00 UTC/);
      assert.match((await cli("run", "1")).stdout, /^“Old audit” removed 1 entry, /);
      assert.match(
        (await cli("removals")).stdout,
        /Old audit {2}control {2}1 removed, .* {2}by Run now/,
      );
      assert.match((await cli("delete", "1")).stdout, /^Deleted “Old audit”/);
      assert.equal(store.retention.list().length, 0);

      // Another token: refused, and nothing is made.
      const other = join(root, "other-token");
      writeFileSync(other, "not-the-owner-token\n", { mode: 0o600 });
      await assert.rejects(
        as(other, "create", ...design),
        (err: { code?: number; stderr?: string }) => err.code === 2 && /401/.test(err.stderr ?? ""),
      );
      assert.equal(store.retention.list().length, 0);
      // Without a policy's id: the usage, exit code 2.
      await assert.rejects(cli("run"), (err: { code?: number }) => err.code === 2);
    } finally {
      server.close();
    }
  });
});
