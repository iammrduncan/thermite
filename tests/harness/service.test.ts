import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { parseContract } from "../../src/core/contract.ts";
import { ModelSource } from "../../src/harness/agents/model/source.ts";
import { Registry } from "../../src/harness/agents/registry.ts";
import { createHarnessApi } from "../../src/harness/api/index.ts";
import { resolveInbox } from "../../src/harness/imports.ts";
import { knowledgePart } from "../../src/harness/kb-part.ts";
import { NOISY_TIMING_NOTE, smokeReport } from "../../src/harness/smoke-check.ts";
import { shownViolations, violationsText } from "../../src/harness/v0.ts";
import { makeHarnessEnv } from "../helpers/harness-env.ts";

const tokens = { supervisor: "sup-token-123456", proposer: "prop-token-123456" };
const auth = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });

describe("harness service and API", () => {
  test("assign_campaign imports the repo bundle, verifies the seed and creates the run", async () => {
    const env = makeHarnessEnv();
    const out = await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
    assert.equal(out.status, "applied");
    assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
    const champ = env.service.ledger.champions.current("smoke-1");
    assert.deepEqual([champ.seq, champ.commit_sha], [1, env.seedCommit]);
  });

  test("a bundle without the named commit is refused and creates nothing", async () => {
    const env = makeHarnessEnv();
    const bad = env.assignPayload({
      seed: { repo: "smoke-kernels", commit: "f".repeat(40) },
      imports: [
        {
          kind: "repo_bundle",
          path: "repos/smoke.bundle",
          repo: "smoke-kernels",
          commit: "f".repeat(40),
        },
      ],
    });
    const out = await env.service.applyCommand(env.sign("assign_campaign", bad));
    assert.ok(out.status === "applied" && !out.accepted);
    assert.match(JSON.stringify(out.result), /does not contain commit/);
    assert.equal(env.service.ledger.runs.get("smoke-1"), undefined);
  });

  test("a model whose sha256 differs from the signed command is refused", async () => {
    const env = makeHarnessEnv();
    mkdirSync(join(env.service.paths.inboxDir, "models"), { recursive: true });
    writeFileSync(join(env.service.paths.inboxDir, "models", "m.bin"), "weights-v1");
    const good = createHash("sha256").update("weights-v1").digest("hex");
    const wrong = "0".repeat(64);
    const base = env.assignPayload();
    const contract = { ...(base.contract as object), models: [{ name: "m.bin", sha256: wrong }] };
    const { parseContract } = await import("../../src/core/contract.ts");
    const parsedWrong = parseContract(contract);
    assert.ok(parsedWrong.ok);
    const payload = {
      ...base,
      contract: parsedWrong.ok ? parsedWrong.contract : null,
      contract_sha: parsedWrong.ok ? parsedWrong.sha : "",
      imports: [
        ...(base.imports as object[]),
        { kind: "model", path: "models/m.bin", name: "m.bin", sha256: wrong },
      ],
    };
    const out = await env.service.applyCommand(env.sign("assign_campaign", payload));
    assert.ok(out.status === "applied" && !out.accepted);
    assert.match(JSON.stringify(out.result), /sha256 mismatch/);

    const parsedGood = parseContract({ ...contract, models: [{ name: "m.bin", sha256: good }] });
    assert.ok(parsedGood.ok);
    const ok = await env.service.applyCommand(
      env.sign("assign_campaign", {
        ...payload,
        contract: parsedGood.ok ? parsedGood.contract : null,
        contract_sha: parsedGood.ok ? parsedGood.sha : "",
        imports: [
          ...(base.imports as object[]),
          { kind: "model", path: "models/m.bin", name: "m.bin", sha256: good },
        ],
      }),
    );
    assert.ok(ok.status === "applied" && ok.accepted, JSON.stringify(ok));
    writeFileSync(join(env.service.paths.inboxDir, "models", "m.bin"), "tampered after import");
    const stored = env.service.ledger.imports.find("model", { sha256: good }) as string;
    assert.equal(readFileSync(stored, "utf8"), "weights-v1");
  });

  test("a run on the harness's own content takes its model from that content, not the inbox (goal 163)", async () => {
    const env = makeHarnessEnv();
    const own = mkdtempSync(join(tmpdir(), "thermite-own-"));
    cpSync(join(env.service.paths.inboxDir, "repos"), join(own, "repos"), { recursive: true });
    mkdirSync(join(own, "models"));
    writeFileSync(join(own, "models", "m.bin"), "own weights");
    const sha = createHash("sha256").update("own weights").digest("hex");
    const base = env.assignPayload();
    const contract = { ...(base.contract as object), models: [{ name: "m.bin", sha256: sha }] };
    await env.service.assignLocal(
      {
        run: "own-1",
        contract,
        seed: base.seed as { repo: string; commit: string },
        bundles: [
          ...(base.imports as never[]),
          { kind: "model", path: "models/m.bin", name: "m.bin", sha256: sha },
        ],
        dir: own,
      },
      "rig-check",
    );
    const stored = env.service.ledger.imports.find("model", { sha256: sha }) as string;
    assert.equal(readFileSync(stored, "utf8"), "own weights");
  });

  test("a refused command's event names its id, so control can match it (goal 163)", async () => {
    const env = makeHarnessEnv();
    const signed = env.sign("pause_run", { run: "smoke-1", reason: "x" });
    const forged = { ...signed, signature: "AAAA" };
    const out = await env.service.applyCommand(forged);
    assert.equal(out.status, "rejected");
    const [rejected] = env.service.ledger
      .eventsAfter(0, 100)
      .events.filter((e) => e.kind === "command_rejected");
    assert.ok(rejected);
    assert.equal((rejected.body as { id?: string }).id, signed.envelope.id);
  });

  test("forged, replayed and misdirected commands are handled safely", async () => {
    const env = makeHarnessEnv();
    const api = createHarnessApi(env.service, tokens);
    const forged = env.sign("assign_campaign", env.assignPayload());
    forged.envelope.payload = { ...(forged.envelope.payload as object), run: "evil" };
    const r1 = await api.request("/v1/commands", {
      method: "POST",
      headers: auth(tokens.supervisor),
      body: JSON.stringify(forged),
    });
    assert.equal(r1.status, 403);
    const r2 = await api.request("/v1/commands", {
      method: "POST",
      headers: auth(tokens.supervisor),
      body: JSON.stringify({ envelope: forged.envelope }),
    });
    assert.equal(r2.status, 403);
    const other = await env.service.applyCommand(env.sign("export_now", {}, { rig: "rig-b" }));
    assert.equal(other.status, "rejected");
    const rejected = env.service.ledger
      .eventsAfter(0, 1000)
      .events.filter((e) => e.kind === "command_rejected");
    assert.equal(rejected.length, 3);

    const good = env.sign("assign_campaign", env.assignPayload());
    const first = await env.service.applyCommand(good);
    const again = await env.service.applyCommand(good);
    assert.equal(first.status, "applied");
    assert.equal(again.status, "replayed");
  });

  test("a command is checked for the supervisor without being applied: control's signature, its rig, its time", async () => {
    const env = makeHarnessEnv();
    const api = createHarnessApi(env.service, tokens);
    const check = async (body: unknown, token = tokens.supervisor) =>
      await api.request("/v1/commands/check", {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify(body),
      });
    const good = env.sign("assign_campaign", env.assignPayload());
    assert.deepEqual(await (await check(good)).json(), { ok: true });
    const forged = env.sign("assign_campaign", env.assignPayload());
    forged.envelope.payload = { ...(forged.envelope.payload as object), run: "evil" };
    assert.deepEqual(await (await check(forged)).json(), { ok: false, reason: "bad signature" });
    const other = env.sign("export_now", {}, { rig: "rig-b" });
    assert.deepEqual(await (await check(other)).json(), {
      ok: false,
      reason: "command is for rig rig-b",
    });
    // Only the supervisor asks; nothing is applied or recorded.
    assert.equal((await check(good, tokens.proposer)).status, 401);
    assert.equal(env.service.ledger.runs.list().length, 0);
    assert.equal(env.service.ledger.eventsAfter(0, 1000).events.length, 0);
  });

  test("submissions are preserved first, then checked by V0 and for duplicates", async () => {
    const env = makeHarnessEnv();
    await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
    const api = createHarnessApi(env.service, tokens);
    const submit = (patch: string, hypothesis: string) =>
      api.request("/v1/attempts", {
        method: "POST",
        headers: auth(tokens.proposer),
        body: JSON.stringify({ run: "smoke-1", patch_base64: patch, hypothesis }),
      });
    const good = env.patchFrom((d) =>
      writeFileSync(join(d, "src", "kernel", "k.c"), "int k(int x) { return x << 1; }\n"),
    );
    const r1 = await submit(good, "shift instead of multiply");
    assert.equal(r1.status, 201);
    const a1 = (await r1.json()) as { attempt: string; lifecycle: string };
    assert.equal(a1.lifecycle, "queued");

    const dup = (await (await submit(good, "same change again")).json()) as {
      lifecycle: string;
      duplicate_of: string;
    };
    assert.equal(dup.lifecycle, "duplicate");
    assert.equal(dup.duplicate_of, a1.attempt);

    const timer = env.patchFrom((d) =>
      writeFileSync(join(d, "bench", "timer.c"), "/* faster timer */\n"),
    );
    const t = (await (await submit(timer, "edit the timer")).json()) as {
      lifecycle: string;
      violations: string[];
    };
    assert.equal(t.lifecycle, "rejected_v0");
    assert.match(t.violations.join(), /path not editable: bench\/timer.c/);

    const forbidden = env.patchFrom((d) =>
      writeFileSync(
        join(d, "src", "kernel", "k.c"),
        "int k(int x) { clock_gettime(0,0); return x; }\n",
      ),
    );
    const f = (await (await submit(forbidden, "sneaky timing")).json()) as {
      lifecycle: string;
      violations: string[];
    };
    assert.equal(f.lifecycle, "rejected_v0");
    assert.match(f.violations.join(), /forbidden pattern/);

    const lc = env.service.ledger.db
      .prepare("select lifecycle, ref from attempt order by created_at")
      .all();
    assert.equal(lc.length, 4);
    const jobs = env.service.ledger.db.prepare("select kind, state from job").all();
    assert.deepEqual(
      jobs.map((j) => [j.kind, j.state]),
      [["evaluate", "queued"]],
    );

    const status = await api.request(`/v1/attempts/${a1.attempt}`, {
      headers: auth(tokens.proposer),
    });
    assert.equal(((await status.json()) as { lifecycle: string }).lifecycle, "queued");
  });

  test("a refused change's violations reach its event, the evidence, the knowledge base and every lane of its campaign (goal 082)", async () => {
    const env = makeHarnessEnv();
    await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
    const api = createHarnessApi(env.service, tokens);
    const registry = new Registry(env.service.ledger);
    const trial = (id: string, run: string, lane: string) => {
      registry.startTrial({
        id,
        run,
        lane,
        epoch: 1,
        family: "f",
        parent: env.seedCommit,
        token: `tok-${id}`,
      });
      return { authorization: `Bearer trial.tok-${id}`, "content-type": "application/json" };
    };
    const lane1 = trial("t1", "smoke-1", "lane-1");
    const timer = env.patchFrom((d) =>
      writeFileSync(join(d, "bench", "timer.c"), "/* faster timer */\n"),
    );
    const r = await api.request("/v1/attempts", {
      method: "POST",
      headers: lane1,
      body: JSON.stringify({ patch_base64: timer, hypothesis: "edit the timer" }),
    });
    assert.equal(r.status, 201);
    const a = (await r.json()) as { attempt: string; lifecycle: string };
    assert.equal(a.lifecycle, "rejected_v0");

    // The attempt's event carries the violations, as control and the knowledge base read them.
    const ev = env.service.ledger
      .eventsAfter(0, 1000)
      .events.find((e) => e.kind === "attempt_recorded" && e.subject === a.attempt);
    const body = ev?.body as { violations?: string[]; violations_total?: number };
    assert.deepEqual(body.violations, ["path not editable: bench/timer.c"]);
    assert.equal(body.violations_total, 1);
    const kb = knowledgePart(env.service.ledger, "rig-a", 0, Number.MAX_SAFE_INTEGER).find(
      (i) => i.kind === "attempt" && i.ref === a.attempt,
    );
    assert.match(String(kb?.body), /Refused before building: path not editable: bench\/timer\.c/);

    // The planner's evidence and the teachers' brief say why it was refused.
    const refused = { violations: ["path not editable: bench/timer.c"], total: 1 };
    assert.deepEqual(registry.evidence("smoke-1")[0]?.refused, refused);
    const brief = env.service.brief("smoke-1") as { evidence: { refused?: unknown }[] };
    assert.deepEqual(brief.evidence[0]?.refused, refused);

    const status = async (headers: Record<string, string>) => {
      const s = await api.request(`/v1/attempts/${a.attempt}`, { headers });
      return { code: s.status, body: (await s.json()) as Record<string, unknown> };
    };
    // Its own lane, another lane, and a later run of the same campaign read it, with why.
    for (const h of [lane1, trial("t2", "smoke-1", "lane-2")]) {
      const s = await status(h);
      assert.equal(s.code, 200, JSON.stringify(s.body));
      assert.deepEqual(s.body.violations, ["path not editable: bench/timer.c"]);
      assert.equal(s.body.lane, "lane-1");
    }
    await env.service.applyCommand(
      env.sign("assign_campaign", env.assignPayload({ run: "smoke-2" })),
    );
    assert.equal((await status(trial("t3", "smoke-2", "lane-1"))).code, 200);
    // Another campaign's lane does not.
    const base = env.assignPayload();
    const other = parseContract({ ...(base.contract as object), campaign: "other-campaign" });
    assert.ok(other.ok);
    const o = await env.service.applyCommand(
      env.sign(
        "assign_campaign",
        env.assignPayload({ run: "other-1", contract: other.contract, contract_sha: other.sha }),
      ),
    );
    assert.ok(o.status === "applied" && o.accepted, JSON.stringify(o));
    const refusedHere = await status(trial("t4", "other-1", "lane-1"));
    assert.equal(refusedHere.code, 404);
    assert.match(String(refusedHere.body.error), /no attempt a-[0-9a-f]+ in this campaign/);

    // A long list is bounded where it is passed on, and says how many more there were.
    const many = Array.from(
      { length: 30 },
      (_, i) => `path not editable: f${i}${"x".repeat(i * 20)}`,
    );
    const shown = shownViolations(many);
    assert.equal(shown.violations.length, 20);
    assert.equal(shown.total, 30);
    assert.ok(shown.violations.every((v) => v.length <= 300));
    assert.match(
      violationsText(many, 3),
      /^path not editable: f0; path not editable: f1x+; path not editable: f2x+; and 27 more$/,
    );
  });

  test("tokens are scoped: proposers cannot read snapshots, nobody without a token gets in", async () => {
    const env = makeHarnessEnv();
    const api = createHarnessApi(env.service, tokens);
    assert.equal((await api.request("/v1/health")).status, 200);
    assert.equal((await api.request("/v1/snapshot")).status, 401);
    assert.equal(
      (await api.request("/v1/snapshot", { headers: auth(tokens.proposer) })).status,
      401,
    );
    assert.equal(
      (await api.request("/v1/snapshot", { headers: auth(tokens.supervisor) })).status,
      200,
    );
  });

  test("snapshot paging and export carry every event once", async () => {
    const env = makeHarnessEnv();
    await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
    const api = createHarnessApi(env.service, tokens);
    const patch = env.patchFrom((d) =>
      writeFileSync(join(d, "src", "kernel", "k.c"), "int k(int x) { return x + x; }\n"),
    );
    await api.request("/v1/attempts", {
      method: "POST",
      headers: auth(tokens.proposer),
      body: JSON.stringify({ run: "smoke-1", patch_base64: patch, hypothesis: "add" }),
    });
    let cursor = 0;
    const ids: number[] = [];
    for (;;) {
      const page = (await (
        await api.request(`/v1/snapshot?cursor=${cursor}&limit=2`, {
          headers: auth(tokens.supervisor),
        })
      ).json()) as { next: number; events: { id: number }[] };
      if (!page.events.length) break;
      ids.push(...page.events.map((e) => e.id));
      cursor = page.next;
    }
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.length, env.service.ledger.latestEventId());

    const exp = (await (
      await api.request("/v1/export", { method: "POST", headers: auth(tokens.supervisor) })
    ).json()) as { dir: string; attempts: number };
    assert.equal(exp.attempts, 1);
    const dir = join(env.service.paths.outboxDir, exp.dir);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
      files: Record<string, string>;
    };
    for (const [f, sha] of Object.entries(manifest.files)) {
      assert.equal(
        createHash("sha256")
          .update(readFileSync(join(dir, f)))
          .digest("hex"),
        sha,
        f,
      );
    }
    assert.ok(readdirSync(join(dir, "attempts")).some((f) => f.endsWith(".patch")));
    const second = (await (
      await api.request("/v1/export", { method: "POST", headers: auth(tokens.supervisor) })
    ).json()) as { attempts: number };
    assert.equal(second.attempts, 0);
  });

  test("an applied command re-sent after it expired is still reported as replayed", async () => {
    let now = new Date();
    const env = makeHarnessEnv("rig-a", () => now);
    const cmd = env.sign("assign_campaign", env.assignPayload(), { expiresInMs: 60_000 });
    assert.equal((await env.service.applyCommand(cmd)).status, "applied");
    now = new Date(now.getTime() + 3_600_000);
    const again = await env.service.applyCommand(cmd);
    assert.equal(again.status, "replayed");
    const fresh = env.sign("export_now", {}, { expiresInMs: 60_000 });
    assert.deepEqual(await env.service.applyCommand(fresh), {
      status: "rejected",
      reason: "expired",
    });
  });

  test("the same command applied concurrently runs once", async () => {
    const env = makeHarnessEnv();
    await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
    const redirect = env.sign("redirect", {
      run: "smoke-1",
      directives: [{ kind: "avoid", family: "loop-unrolling", rationale: "tried", citations: [] }],
    });
    const outcomes = await Promise.all([
      env.service.applyCommand(redirect),
      env.service.applyCommand(redirect),
    ]);
    assert.deepEqual(outcomes.map((o) => o.status).sort(), ["applied", "in_progress"]);
    assert.equal((await env.service.applyCommand(redirect)).status, "replayed");
    assert.equal(env.service.ledger.directives.active("smoke-1").length, 1);
  });

  test("a refused assign changes nothing, and resume keeps one run running", async () => {
    const env = makeHarnessEnv();
    const ledger = env.service.ledger;
    await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
    const reuse = await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
    assert.ok(reuse.status === "applied" && !reuse.accepted);
    assert.match(JSON.stringify(reuse.result), /already exists/);
    assert.equal(ledger.runs.get("smoke-1")?.status, "running");

    await env.service.applyCommand(
      env.sign("assign_campaign", env.assignPayload({ run: "smoke-2" })),
    );
    assert.equal(ledger.runs.get("smoke-1")?.status, "paused");
    await env.service.applyCommand(env.sign("resume_run", { run: "smoke-1" }));
    const running = ledger.runs.list().filter((i) => i.status === "running");
    assert.deepEqual(
      running.map((i) => i.id),
      ["smoke-1"],
    );
  });

  test("signed commands need full commit ids, and a bundle hash, when given, must match", async () => {
    const env = makeHarnessEnv();
    const short = env.seedCommit.slice(0, 7);
    const abbreviated = await env.service.applyCommand(
      env.sign(
        "assign_campaign",
        env.assignPayload({
          seed: { repo: "smoke-kernels", commit: short },
          imports: [
            {
              kind: "repo_bundle",
              path: "repos/smoke.bundle",
              repo: "smoke-kernels",
              commit: short,
            },
          ],
        }),
      ),
    );
    assert.equal(abbreviated.status, "rejected");
    const wrongHash = await env.service.applyCommand(
      env.sign(
        "assign_campaign",
        env.assignPayload({
          imports: [
            {
              kind: "repo_bundle",
              path: "repos/smoke.bundle",
              repo: "smoke-kernels",
              commit: env.seedCommit,
              sha256: "0".repeat(64),
            },
          ],
        }),
      ),
    );
    assert.ok(wrongHash.status === "applied" && !wrongHash.accepted);
    assert.match(JSON.stringify(wrongHash.result), /sha256 mismatch/);
  });

  test("V0 sees added lines that start with ++, NUL-byte files and refused patches", async () => {
    const env = makeHarnessEnv();
    await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
    const submit = (patch: string) =>
      env.service.submitAttempt(
        { run: "smoke-1", patch_base64: patch, hypothesis: "h", known_flaws: [] },
        "proposer",
      );
    const plusPlus = await submit(
      env.patchFrom((d) =>
        writeFileSync(
          join(d, "src", "kernel", "k.c"),
          "int n;\n++n; clock_gettime(0,0);\nint k(int x) { return x * 2; }\n",
        ),
      ),
    );
    assert.equal(plusPlus.lifecycle, "rejected_v0");
    const nul = await submit(
      env.patchFrom((d) =>
        writeFileSync(
          join(d, "src", "kernel", "k.c"),
          "/* \0 */ int k(int x) { clock_gettime(0,0); return x; }\n",
        ),
      ),
    );
    assert.equal(nul.lifecycle, "rejected_v0");
    assert.match(nul.violations.join(), /binary change|forbidden pattern/);
    const link = await submit(
      env.patchFrom((d) => symlinkSync("/etc/hosts", join(d, "src", "kernel", "hosts"))),
    );
    assert.equal(link.lifecycle, "rejected_v0");
    assert.match(link.violations.join(), /symlink or submodule/);
    await assert.rejects(submit(Buffer.from("not a patch").toString("base64")));
    const refused = env.service.ledger
      .eventsAfter(0, 1000)
      .events.filter((e) => e.kind === "submission_refused");
    assert.equal(refused.length, 1);
  });

  test("inbox paths cannot escape the inbox", () => {
    const env = makeHarnessEnv();
    const inbox = env.service.paths.inboxDir;
    assert.throws(() => resolveInbox(inbox, "../state/ledger/ledger.db"), /escapes inbox/);
    symlinkSync("/etc", join(inbox, "link"));
    assert.throws(() => resolveInbox(inbox, "link/hosts"), /escapes inbox/);
    assert.ok(existsSync(resolveInbox(inbox, "repos/smoke.bundle")));
  });

  test("a rig check runs in the background and reports; a busy rig, an unknown or a second check is refused", async () => {
    const env = makeHarnessEnv("rig-a");
    let release: () => void = () => undefined;
    let busy: string | undefined;
    env.service.rigChecks = {
      model: {
        run: () =>
          new Promise((done) => {
            release = () =>
              done({ ok: true, summary: "a correct tool call", detail: { seconds: 1 } });
          }),
      },
      isolation: { notNow: () => busy, run: async () => ({ ok: false, summary: "ALLOWED" }) },
    };
    const apply = async (payload: unknown) =>
      (await env.service.applyCommand(env.sign("rig_check", payload))) as {
        accepted?: boolean;
        result?: Record<string, unknown> | { error?: string };
      };
    const events = () =>
      env.service.ledger
        .eventsAfter(0, 1000)
        .events.filter((e) => e.kind.startsWith("rig_check"))
        .map((e) => [
          e.kind,
          (e.body as { check?: string; ok?: boolean }).check,
          (e.body as { ok?: boolean }).ok,
        ]);
    const started = await apply({ check: "model" });
    assert.equal(started.accepted, true);
    assert.equal((started.result as { started?: boolean }).started, true);
    const second = await apply({ check: "isolation" });
    assert.equal(second.accepted, false);
    assert.match(JSON.stringify(second.result), /the model check is still running/);
    release();
    await new Promise((r) => setTimeout(r, 20));
    busy = "1 open trial(s)";
    const refused = await apply({ check: "isolation" });
    assert.match(JSON.stringify(refused.result), /not now: 1 open trial/);
    const forced = await apply({ check: "isolation", force: true });
    assert.equal(forced.accepted, true);
    await new Promise((r) => setTimeout(r, 20));
    const unknown = await apply({ check: "smoke" });
    assert.match(JSON.stringify(unknown.result), /cannot run the smoke check/);
    assert.deepEqual(events(), [
      ["rig_check_started", "model", undefined],
      ["rig_check_finished", "model", true],
      ["rig_check_started", "isolation", undefined],
      ["rig_check_finished", "isolation", false],
    ]);
    // A check the controller never finished (it restarted) is closed as interrupted on start.
    env.service.rigChecks.model = { run: () => new Promise(() => undefined) };
    await apply({ check: "model" });
    env.service.reconcileRigChecks();
    const last = env.service.ledger.eventsAfter(0, 1000).events.at(-1);
    assert.equal(last?.kind, "rig_check_finished");
    assert.match(JSON.stringify(last?.body), /interrupted: the controller restarted/);
  });

  test("a check that passed with a note records the note in its event", async () => {
    const env = makeHarnessEnv("rig-a");
    env.service.rigChecks = {
      smoke: {
        run: async () =>
          smokeReport("smoke-cpu", "check-smoke-1", {
            noop: { expect: "neutral", got: "inconclusive", ok: false, attempt: "a-1" },
            timer: { expect: "rejected_v0", got: "rejected_v0", ok: true, attempt: "a-2" },
          }),
      },
    };
    await env.service.applyCommand(env.sign("rig_check", { check: "smoke" }));
    await new Promise((r) => setTimeout(r, 20));
    const done = env.service.ledger
      .eventsAfter(0, 1000)
      .events.find((e) => e.kind === "rig_check_finished");
    const body = done?.body as { ok?: boolean; summary?: string; note?: string };
    assert.equal(body.ok, true);
    assert.equal(body.note, NOISY_TIMING_NOTE);
    assert.match(String(body.summary), /Note: The timing on this machine is noisy\./);
  });

  test("the isolation check at start runs forced and is awaited; a route set meanwhile is checked after it", async () => {
    const env = makeHarnessEnv("rig-a");
    let release: () => void = () => undefined;
    const ran: string[] = [];
    env.service.rigChecks = {
      isolation: {
        // Busy (a trial left open by the previous controller): the start check runs anyway.
        notNow: () => "1 open trial(s)",
        run: () =>
          new Promise((done) => {
            ran.push("isolation");
            release = () => done({ ok: true, summary: "isolation holds" });
          }),
      },
      model: {
        run: async () => {
          ran.push("model");
          return { ok: true, summary: "a correct tool call" };
        },
      },
    };
    let finished = false;
    const atStart = env.service.checkAtStart("isolation").then(() => {
      finished = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(finished, false);
    // A model route arriving during the isolation check waits for it, then is checked.
    env.service.models = new ModelSource(
      join(mkdtempSync(join(tmpdir(), "thermite-ms-")), "r.json"),
      undefined,
    );
    env.service.setModelRoute(
      {
        name: "p",
        version: 1,
        base_url: "http://m/v1",
        model: "m",
        context_window: 0,
        max_tokens: 0,
        reasoning: null,
        key_hint: "…k",
        revision: "0123abcd",
        api_key: "k",
      },
      "supervisor",
    );
    assert.deepEqual(ran, ["isolation"]);
    release();
    await atStart;
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(ran, ["isolation", "model"]);
    const started = env.service.ledger
      .eventsAfter(0, 1000)
      .events.filter((e) => e.kind === "rig_check_started")
      .map((e) => [(e.body as { check: string }).check, (e.body as { force: boolean }).force]);
    assert.deepEqual(started, [
      ["isolation", true],
      ["model", false],
    ]);
    // A rig without the check skips it.
    await makeHarnessEnv("rig-b").service.checkAtStart("isolation");
  });

  test("the owner declines a waiting promotion: it never becomes champion, and only the owner may", async () => {
    const env = makeHarnessEnv("rig-a");
    await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
    const patch = env.patchFrom((d) =>
      writeFileSync(join(d, "src", "kernel", "k.c"), "int k(int x) { return x << 1; }\n"),
    );
    const r = await env.service.submitAttempt(
      { run: "smoke-1", patch_base64: patch, hypothesis: "shift", known_flaws: [] },
      "proposer",
    );
    // As the judge leaves a confirmed win under the owner_approval policy.
    env.service.ledger.attempts.setLifecycle(r.attempt, "awaiting_approval", "judge");
    const decline = (over?: { issuedBy?: string }) =>
      env.service.applyCommand(
        env.sign(
          "decline_promotion",
          { run: "smoke-1", attempt: r.attempt, note: "not this one" },
          over,
        ),
      ) as Promise<{ status: string; accepted?: boolean; result?: unknown; reason?: string }>;
    const byAgent = await decline({ issuedBy: "agent:mcp" });
    assert.match(JSON.stringify(byAgent), /the owner's to issue/);
    const ok = await decline();
    assert.equal(ok.accepted, true, JSON.stringify(ok));
    assert.equal(String(env.service.ledger.attempts.get(r.attempt)?.lifecycle), "declined");
    const ev = env.service.ledger.latestEventBody("promotion_declined", r.attempt);
    assert.deepEqual(ev, { run: "smoke-1", was: "awaiting_approval", note: "not this one" });
    const again = await decline();
    assert.match(JSON.stringify(again), /nothing to decline/);
    const approve = (await env.service.applyCommand(
      env.sign("approve_promotion", { run: "smoke-1", attempt: r.attempt }),
    )) as { result?: unknown };
    assert.match(JSON.stringify(approve), /not awaiting approval/);
  });
});
