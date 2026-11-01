import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { KbFiles, KbText, ownerKbRead } from "../../src/control/kb/index.ts";
import { KB_OUTBOX_FILES, type KbItemFile } from "../../src/core/kb/index.ts";
import { Registry } from "../../src/harness/agents/registry.ts";
import { createHarnessApi } from "../../src/harness/api/index.ts";
import { LocalRunner } from "../../src/harness/broker/runner.ts";
import { Compactions } from "../../src/harness/compactions.ts";
import { ResearchFolder } from "../../src/harness/research/folder.ts";
import { controlStore, ingestReport } from "../helpers/control-store.ts";
import { makeHarnessEnv } from "../helpers/harness-env.ts";

/**
 * A kept conversation leaves the rig scrubbed, and whole (goal 175): before the harness keeps it,
 * every value it gave the agent is blanked out exactly, and so is anything shaped like a key, a
 * token or a password; then it reaches control as its item's file, searched past its 20,000th
 * character.
 */

const RUN = "smoke-1";
const TRIAL = "t-0123456789abcdef";

test("a kept conversation reaches control scrubbed of its credentials, and whole", async () => {
  // The rig: a trial with its own token, as the scheduler starts one.
  const env = makeHarnessEnv();
  await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
  const folder = new ResearchFolder({
    ledger: env.service.ledger,
    outboxDir: env.service.paths.outboxDir,
    scratchRoot: join(env.service.paths.scratchDir, "research"),
    stateRoot: join(env.service.paths.stateDir, "research-work"),
    runner: new LocalRunner(env.service.paths.scratchDir),
  });
  env.service.compactions = new Compactions({
    ledger: env.service.ledger,
    live: env.service.live,
    folder,
  });
  const token = randomBytes(32).toString("hex");
  new Registry(env.service.ledger).startTrial({
    id: TRIAL,
    run: RUN,
    lane: "lane-1",
    epoch: 1,
    direction: "f",
    parent: env.seedCommit,
    token,
  });
  const api = createHarnessApi(env.service, { supervisor: "sup", proposer: "prop" });
  const post = (path: string, body: unknown) =>
    api.request(path, {
      method: "POST",
      headers: { authorization: `Bearer trial.${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  // What an agent's tools printed: its environment, a request with a bearer token, a key and a
  // repository's address with its password; then a long session, and a word past it.
  const secrets = {
    bearer: "abcdef0123456789abcdef",
    key: ["sk", "proj", "AbCdEf0123456789GhIjKl"].join("-"),
    password: "hunter2-not-for-you",
  };
  const markdown = [
    `# Trial ${TRIAL}: the conversation before compaction 1`,
    "",
    "## 3. Tool result: run",
    "",
    "```text",
    `HOME=/home/lane-1\nTHERMITE_TRIAL_AUTH=trial.${token}\nPATH=/usr/bin`,
    "```",
    "",
    "## 4. Tool result: run",
    "",
    "```text",
    `curl -H "Authorization: Bearer ${secrets.bearer}" https://api.example.com`,
    `export OPENAI_API_KEY=${secrets.key}`,
    `git clone https://deploy:${secrets.password}@git.example.com/kernels.git`,
    "```",
    "",
    ...Array.from({ length: 900 }, (_, i) => `Step ${i}: the kernel reads its inputs in order.`),
    "",
    "The zirconium layout wins.",
  ].join("\n");
  assert.ok(markdown.indexOf("zirconium") > 20_000);
  assert.equal((await post("/v1/trial/snapshot", { number: 1, markdown })).status, 201);
  const done = await post("/v1/trial/compacted", {
    number: 1,
    tokens_before: 41_000,
    tokens_after: 4_000,
    how: "summary",
    kept: true,
    summary: `Next: retry with trial.${token}.`,
  });
  assert.equal(done.status, 201);
  const events = env.service.ledger.eventsAfter(0, 100_000).events;
  const compacted = events.find((e) => e.kind === "context_compacted")?.body as {
    file: KbItemFile;
    summary: string;
  };
  // Every copy is the scrubbed one: the outbox's, the run's folder's and the event's summary.
  const sent = readFileSync(
    join(env.service.paths.outboxDir, KB_OUTBOX_FILES, compacted.file.sha256),
    "utf8",
  );
  const shown = readFileSync(join(folder.root(RUN), "compactions", `${TRIAL}-1.md`), "utf8");
  for (const text of [sent, shown, compacted.summary]) {
    assert.ok(!text.includes(token), "the trial's credential");
    for (const [what, value] of Object.entries(secrets)) assert.ok(!text.includes(value), what);
  }
  assert.equal(sent, shown);
  assert.match(sent, /THERMITE_TRIAL_AUTH=\*\*\*/);
  assert.match(sent, /git clone https:\/\/\*\*\*@git\.example\.com\/kernels\.git/);
  assert.match(sent, /The zirconium layout wins\./);

  // Control: the rig's report, then the file, as the supervisor puts it on the bus.
  const store = controlStore();
  await ingestReport(store, {
    rig: env.service.rig,
    ledger_id: "l-1",
    cursor: 0,
    next: events.length,
    generated_at: new Date().toISOString(),
    events,
    summary: {},
  });
  const files = new KbFiles(mkdtempSync(join(tmpdir(), "thermite-kb-kept-")), store);
  const at = files.path(compacted.file.sha256);
  mkdirSync(dirname(at), { recursive: true });
  writeFileSync(at, sent);
  store.kb().files.kept(compacted.file.sha256, compacted.file.bytes);
  assert.equal(await new KbText(store, files).look(), 1);
  const campaign = String(env.service.ledger.runs.get(RUN)?.campaign);
  const [hit] = store.kb().find("zirconium", [{ campaign }]).hits;
  assert.equal(hit?.kind, "doc");
  assert.equal(hit?.ref, `compactions/${TRIAL}-1.md`);
  const address = `${campaign}/${RUN}/records/doc:compactions/${TRIAL}-1.md`;
  const read = ownerKbRead(store, [], { address, offset: hit?.passage?.from });
  assert.ok(!("error" in read), JSON.stringify(read));
  assert.match(read.item.text, /zirconium/);
  assert.equal(read.item.head, "Kept before compaction 1, at about 41,000 tokens.");
  assert.equal(read.item.chars, read.item.head.length + 2 + sent.length, "whole");
  for (let offset = 0; offset < read.item.chars; offset += 10_000) {
    const page = ownerKbRead(store, [], { address, offset });
    assert.ok(!("error" in page));
    assert.ok(!page.item.text.includes(token));
    for (const value of Object.values(secrets)) assert.ok(!page.item.text.includes(value));
  }
});
