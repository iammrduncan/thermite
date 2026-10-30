import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serve } from "@hono/node-server";
import { rigView } from "../../../src/control/views/index.ts";
import { ADMIN, controlStack } from "../../helpers/control-stack.ts";
import { RUN, twoChampions } from "../../helpers/withdraw-env.ts";

/**
 * `thermite invalidate` without --yes (goal 174): it shows what withdrawing the evidence would
 * reach, from the rig's own preview, and withdraws nothing. Only the preview is sent; the rig's
 * record and control's views stay as they were.
 */

const CLI = join(import.meta.dirname, "../../../src/cli/thermite/main.ts");

test("without --yes it prints what it would reach, and withdraws nothing", async () => {
  const { env, a, b, d } = await twoChampions();
  const stack = controlStack({ env });
  await stack.relay();
  const server = serve({ fetch: stack.control.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const tokenFile = join(mkdtempSync(join(tmpdir(), "thermite-cli-")), "token");
  writeFileSync(tokenFile, ADMIN);
  let done = false;
  const child = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        CLI,
        "invalidate",
        "--control",
        url,
        "--token-file",
        tokenFile,
        "--run",
        RUN,
        "--attempt",
        a.attempt,
        "--reason",
        "the timer was wrong",
      ],
      (err, stdout, stderr) => {
        done = true;
        resolve({ code: (err as { code?: number } | null)?.code ?? 0, stdout, stderr });
      },
    );
  });
  // The supervisor's relay, meanwhile: the preview reaches the rig, and its answer control.
  while (!done) {
    await stack.relay();
    await new Promise((r) => setTimeout(r, 300));
  }
  const out = await child;
  server.close();
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /What withdrawing it reaches:/);
  assert.match(out.stdout, /are withdrawn for good/);
  for (const id of [a.attempt, b.attempt, d.attempt])
    assert.match(out.stdout, new RegExp(`${id} .*-> {2}withdrawn for good`), id);
  assert.match(out.stderr, /Nothing was withdrawn\. To withdraw it, run this again with --yes\./);
  assert.doesNotMatch(out.stdout, /Withdrawn: invalidation/);

  // Only the preview was sent.
  const sent = stack.store.commands
    .latest("rig-a", "invalidate_evidence")
    .map((c) => c.payload as { preview?: boolean; reach?: string });
  assert.deepEqual(
    sent.map((p) => [p.preview, p.reach]),
    [[true, undefined]],
  );
  // Nothing changed on the rig.
  const ledger = env.service.ledger;
  for (const id of [a.attempt, b.attempt]) {
    assert.equal(ledger.attempts.get(id)?.invalidated_by, null, id);
    assert.equal(ledger.verdicts.current(id)?.verdict, "win_confirmed", id);
  }
  assert.equal(ledger.champions.current(RUN).seq, 3);
  assert.equal(ledger.latestEventBody("invalidation", a.attempt), undefined);
  // Nor on control.
  await stack.relay();
  const run = rigView(stack.store, "rig-a")?.runs.find((r) => r.id === RUN);
  assert.ok(run, "control has the run");
  assert.deepEqual(run.invalidations, []);
});
