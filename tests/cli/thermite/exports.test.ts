import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { uploadExportsOnce } from "../../../src/supervisor/export-upload.ts";
import { controlOnly } from "../../helpers/control-stack.ts";

const run = promisify(execFile);
const CLI = join(import.meta.dirname, "../../../src/cli/thermite/main.ts");
const OWNER = "owner-token-abcdef";
const RIG_A = "rig-a-token-abcdef";
const NAME = "20261101T010000Z-0123abcd";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("thermite exports", () => {
  test("delete removes exports control keeps, with the owner's token, and prints what went", async () => {
    const root = mkdtempSync(join(tmpdir(), "thermite-cli-exports-"));
    const kept = join(root, "control-exports");
    const { control: api, store } = await controlOnly({
      tokens: { admin: OWNER, rigs: { "rig-a": RIG_A } },
      options: { exportsDir: kept },
    });
    const server = serve({ fetch: api.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise((r) => server.once("listening", r));
    const control = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      // rig-a sends one export to control, as its supervisor does.
      const outbox = join(root, "outbox");
      const events = Buffer.from(`${JSON.stringify({ id: 1, kind: "run_created" })}\n`);
      mkdirSync(join(outbox, NAME), { recursive: true });
      writeFileSync(join(outbox, NAME, "events.jsonl"), events);
      writeFileSync(
        join(outbox, NAME, "manifest.json"),
        `${JSON.stringify({ rig: "rig-a", from_event: 0, through_event: 1, files: { "events.jsonl": sha(events) } })}\n`,
      );
      const sent = await uploadExportsOnce(
        { rig: "rig-a", outboxDir: outbox, controlUrl: control, controlToken: RIG_A },
        { queue: [NAME], uploaded: [] },
      );
      assert.deepEqual(sent.uploaded, [NAME]);

      const token = join(root, "owner-token");
      writeFileSync(token, `${OWNER}\n`, { mode: 0o600 });
      const as = (tokenFile: string, ...args: string[]) =>
        run(process.execPath, [
          "--experimental-strip-types",
          "--no-warnings",
          CLI,
          "exports",
          ...args,
          "--control",
          control,
          "--token-file",
          tokenFile,
        ]);
      const cli = (...args: string[]) => as(token, ...args);
      // A wrong token: refused, and nothing goes.
      const other = join(root, "other-token");
      writeFileSync(other, "not-the-owner-token\n", { mode: 0o600 });
      await assert.rejects(
        as(other, "delete", "rig-a", NAME),
        (err: { code?: number; stderr?: string }) => err.code === 2 && /401/.test(err.stderr ?? ""),
      );
      assert.ok(await store.exports.get("rig-a", NAME));

      const out = await cli("delete", "rig-a", NAME, "20261101T020000Z-89abcdef");
      assert.match(out.stdout, new RegExp(`^Deleted 1 export from control: rig-a · ${NAME} \\(`));
      assert.match(out.stdout, /Control did not have rig-a · 20261101T020000Z-89abcdef/);
      assert.equal(await store.exports.get("rig-a", NAME), undefined);
      assert.equal(existsSync(join(kept, "rig-a", NAME)), false);
      assert.ok((await store.auditLog.list(20)).some((a) => a.action === "export_deleted"));

      // Without a name: the usage, exit code 2.
      await assert.rejects(cli("delete", "rig-a"), (err: { code?: number }) => err.code === 2);
    } finally {
      server.close();
    }
  });
});
