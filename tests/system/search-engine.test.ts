import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { answerKbAsk, KbFiles, KbText } from "../../src/control/kb/index.ts";
import { ControlStore } from "../../src/control/store/index.ts";
import type { SignedCommand } from "../../src/core/commands.ts";
import { parseContract } from "../../src/core/contract.ts";
import type { KbSearchAnswer } from "../../src/core/link/kb.ts";
import { SAVED_LANES_DIR } from "../../src/harness/research/folder.ts";
import { researchFixture } from "../helpers/fixtures.ts";
import { makeHarnessEnv } from "../helpers/harness-env.ts";

/**
 * One search engine for both (goal 175): a lane's documents, kept whole on control as their items'
 * files and on the rig in the run's own index, are ranked the same, with the same excerpts, by
 * control's kb_search and the rig's search_research.
 */

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const FILLER = "The kernel reads its inputs and writes its outputs in order. ";

/** Four documents of a lane: each says "tiling" and "banks" a different number of times. */
const DOCS: Record<string, string> = {
  "a.md": `${FILLER.repeat(4)}Tiling helps. Tiling again, and the banks.`,
  "b.md": `${FILLER.repeat(5)}Tiling, tiling and more tiling, tiling wins.`,
  "c.md": `${FILLER.repeat(3)}The banks conflict; banks again; tiling once.`,
  "d.md": `${FILLER.repeat(60)}Far down a long page, tiling meets the banks at last.`,
};

test("control and the rig rank the same text the same way, with the same excerpts", async () => {
  // The rig: run r-1, with the lane's files saved as the research folder saves them.
  const env = makeHarnessEnv("rig-a");
  const parsed = parseContract(researchFixture);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  await env.service.applyCommand(
    env.sign("assign_campaign", {
      run: "r-1",
      contract: parsed.contract,
      contract_sha: parsed.sha,
      imports: [],
    }),
  );
  // Control: the same run's documents, from the rig's events, each with its file.
  const store = new ControlStore(":memory:");
  store.commands.enqueue({
    envelope: {
      v: 1,
      id: "c-1",
      rig: "rig-a",
      kind: "assign_campaign",
      issued_by: "owner:api",
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      payload: { run: "r-1", contract: { campaign: parsed.contract.campaign } },
    },
    signature: "not checked by the store",
  } as unknown as SignedCommand);
  const rig = { rig: "rig-a", ledger: "ledger-a" };
  const at = "2026-10-31T10:00:00.000Z";
  const index = (kind: string, actor: string, body: Record<string, unknown>) =>
    store.kb().index(rig, { at, actor, kind, subject: "r-1", body });
  index("run_created", "harness", { campaign: parsed.contract.campaign, mode: "research" });
  const files = new KbFiles(mkdtempSync(join(tmpdir(), "thermite-kb-engine-")), store);
  for (const [path, text] of Object.entries(DOCS)) {
    const saved = join(env.service.paths.stateDir, SAVED_LANES_DIR, "r-1", "lane-1", path);
    mkdirSync(dirname(saved), { recursive: true });
    writeFileSync(saved, text);
    const file = { sha256: sha(text), name: path, type: "text/markdown", bytes: text.length };
    env.service.ledger.laneFiles.record("r-1", "lane-1", "t-1", [
      { path, change: "written", bytes: text.length, sha256: file.sha256 },
    ]);
    index("research_doc", "lane-1", {
      lane: "lane-1",
      trial: "t-1",
      path,
      change: "written",
      bytes: text.length,
      sha256: file.sha256,
      file,
    });
    const kept = files.path(file.sha256);
    mkdirSync(dirname(kept), { recursive: true });
    writeFileSync(kept, text);
    store.kb().files.kept(file.sha256, text.length);
  }
  await new KbText(store, files).look();

  for (const q of ["tiling", "banks", "tiling banks"]) {
    const onControl = answerKbAsk(store, "rig-a", "search", {
      run: "r-1",
      q,
      kinds: ["doc"],
    }) as KbSearchAnswer;
    const onRig = env.service.runResearch.search("r-1", q, { kinds: ["file"] }) as {
      items: { id: string; excerpt: string; passage: unknown }[];
    };
    const control = onControl.hits.map((h) => h.address.split("doc:lane-1/")[1]);
    const theRig = onRig.items.map((x) => x.id.replace("lanes/lane-1/", ""));
    assert.ok(control.length >= 2, q);
    assert.deepEqual(theRig, control, q);
    assert.deepEqual(
      onRig.items.map((x) => [x.excerpt, x.passage]),
      onControl.hits.map((h) => [h.excerpt.replace(/\s+/g, " ").trim(), h.passage]),
      q,
    );
  }
});
