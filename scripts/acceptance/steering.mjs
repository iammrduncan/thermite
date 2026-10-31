#!/usr/bin/env node
// M5 acceptance under compose with two rigs and a scripted model on the host (planner and
// advisors; frontier keys are not needed to check the machinery):
//   - the two teachers and their merged by model post a cited directive set; after a reset, the next epoch
//     records it and the assignments it steered;
//   - an audit block holds a confirmed win; a cleared audit lets the next one promote;
//   - rig 1's champion is propagated to rig 2, judged there, and shown cross-verified;
//   - the supervisor's token cannot submit attempts, and a forged command is refused;
//   - daily reports and supervisor figures reach control;
//   - an advisor in Pi in its Pi view in the supervisor (lib/pi-advisor-view.mjs): one input typed
//     into a teacher's view and one owner's message, both in its next model call;
//   - with the engine socket (compose.lifecycle.yaml): control restarts a rig's supervisor;
//   - a full reset of rig 2: pause, export, verified push, wipe, fresh ledger.
// Usage: COMPOSE="podman compose" node scripts/acceptance/steering.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { acceptanceChecks } from "./lib/checks.mjs";
import { piAdvisorScene } from "./lib/pi-advisor-view.mjs";
import {
  api,
  assign,
  candidatePatch,
  command,
  compose,
  prepare,
  secret,
  sh,
  sleep,
  until,
} from "./lib/smoke-env.mjs";

let requests = 0;
const seen = { teacher: 0, merged_by: 0, auditor: 0, planner: 0 };
const piView = piAdvisorScene();

/** The scripted model: planner (falls back), teachers, their merged by model, auditor. */
function script(messages, tools, model) {
  const system = JSON.stringify(messages.find((m) => m.role === "system")?.content ?? "");
  const prompt = JSON.stringify(messages.filter((m) => m.role === "user"));
  const answer = (args) => ({ toolCalls: [{ name: "answer", args }] });
  if (tools.some((t) => t.function.name === "submit_plan")) {
    seen.planner++;
    return { text: "no plan from this model" }; // the deterministic fallback plans
  }
  if (system.includes("You merge the advice of two teachers")) {
    seen.merged_by++;
    return answer({
      directives: [
        {
          kind: "mandate",
          family: "tiling",
          rationale: "both reviewers point at cache blocking",
          citations: ["acceptance:teacher-a", "acceptance:teacher-b"],
        },
      ],
    });
  }
  if (system.includes("You review an automated research campaign")) {
    seen.teacher++;
    const advice = answer({
      summary: "try cache blocking",
      recommendations: [
        { kind: "try", family: "tiling", rationale: "blocking", citations: ["acceptance"] },
      ],
    });
    return piView.turn(model, messages, advice) ?? advice;
  }
  if (system.includes("You audit a candidate change")) {
    seen.auditor++;
    return answer({
      decision: prompt.includes("SUSPICIOUS") ? "block" : "clear",
      reasons: prompt.includes("SUSPICIOUS") ? "a marker of tampering" : "nothing suspicious",
      citations: ["diff"],
    });
  }
  return { text: "done" };
}

const model = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => {
    body += d;
  });
  req.on("end", async () => {
    requests++;
    const p = JSON.parse(body);
    // A turn may take its time: the Pi view scene holds one teacher's first reply.
    const turn = await script(p.messages ?? [], p.tools ?? [], p.model);
    const id = `c${requests}`;
    const chunk = (delta, finish) =>
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: p.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(chunk({ role: "assistant", content: turn.text ?? "" }, null));
    for (const [i, t] of (turn.toolCalls ?? []).entries()) {
      res.write(
        chunk(
          {
            tool_calls: [
              {
                index: i,
                id: `${id}_${i}`,
                type: "function",
                function: { name: t.name, arguments: JSON.stringify(t.args) },
              },
            ],
          },
          null,
        ),
      );
    }
    res.write(chunk({}, turn.toolCalls?.length ? "tool_calls" : "stop"));
    res.write(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: p.model, choices: [], usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((r) => model.listen(0, "0.0.0.0", r));
const port = model.address().port;
const docker = (process.env.COMPOSE ?? "podman compose").startsWith("docker");
const hostName = docker ? "host.docker.internal" : "host.containers.internal";

// The engine socket for the compose lifecycle driver, when this machine has one.
let socket = process.env.THERMITE_ENGINE_SOCKET_HOST;
if (!socket && !docker) {
  try {
    socket = execFileSync("podman", ["info", "--format", "{{.Host.RemoteSocket.Path}}"], {
      encoding: "utf8",
    })
      .trim()
      .replace(/^unix:\/\//, "");
  } catch {
    socket = undefined;
  }
}
const files = ["-f", "compose.yaml", ...(socket ? ["-f", "compose.lifecycle.yaml"] : [])];
const composeEnv = {
  THERMITE_POLL_SECONDS: "2",
  THERMITE_PROMOTION: "auto",
  THERMITE_CALIBRATION_BLOCKS: "0",
  THERMITE_EXPORT_MINUTES: "0.1",
  THERMITE_MODEL_BASE_URL: `http://${hostName}:${port}/v1`,
  THERMITE_MODEL: "scripted",
  // Agents plan epochs but run no trials: this acceptance is about steering, not workers.
  THERMITE_MAX_TRIALS: "0",
  THERMITE_ADVISORS_FILE: "/etc/thermite/advisors/advisors.json",
  ...(socket ? { THERMITE_ENGINE_SOCKET_HOST: socket } : {}),
};
const dc = (...args) =>
  sh(compose[0], [...compose.slice(1), ...files, "--profile", "two-rigs", ...args], {
    env: { ...process.env, ...composeEnv },
  });

const report = {
  started_at: new Date().toISOString(),
  compose: process.env.COMPOSE ?? "podman compose",
  lifecycle_driver: Boolean(socket),
  checks: [],
};
const { check } = acceptanceChecks({ max: 300, into: report.checks });
const rigEvents = async (rig) => {
  const all = [];
  let after = 0;
  for (;;) {
    const page = await api(`/v1/rigs/${rig}/events?after=${after}&limit=5000`);
    all.push(...page.body.events);
    if (page.body.events.length < 5000) return all;
    after = page.body.events.at(-1).seq;
  }
};
const view = async (rig) => (await api(`/v1/rigs/${rig}/view`)).body;
// Each rig its own run: a run's name is used once on control (goal 170).
const RUNS = { "local-1": "smoke-1", "local-2": "smoke-2" };
const runOf = async (rig) => (await view(rig)).runs?.find((i) => i.id === RUNS[rig]);

const env = prepare();
// Audits for any win above 1% (the smoke kernel's win is far larger).
const contract = JSON.parse(readFileSync(env.contractFile, "utf8"));
contract.acceptance.audit = { ratio_to_median: 3, absolute: 0.01 };
writeFileSync(env.contractFile, JSON.stringify(contract));
mkdirSync(join(".dev", "advisors"), { recursive: true });
writeFileSync(join(".dev", "advisors", "key"), "scripted\n");
const runtime = (name) => ({
  name,
  runtime: "openai",
  base_url: `http://${hostName}:${port}/v1`,
  model: name,
  api_key_file: "/etc/thermite/advisors/key",
  max_turns: 4,
});
writeFileSync(
  join(".dev", "advisors", "advisors.json"),
  JSON.stringify({
    teachers: [runtime("teacher-a"), runtime("teacher-b")],
    merged_by: runtime("merged-by"),
    auditor: runtime("auditor"),
    teacher_minutes: 0.5,
  }),
);

dc("up", "-d", "--build");
let failed = false;
try {
  await until("control health", async () => (await fetch("http://127.0.0.1:8800/v1/health")).ok);
  await assign(env, "smoke-1", "local-1");
  await assign(env, "smoke-2", "local-2");

  // 1. Directives from the teachers, attributed in the next epoch.
  await until(
    "the supervisor's directive set",
    async () =>
      (await rigEvents("local-1")).some((e) => e.kind === "directive" && e.actor === "supervisor"),
    300_000,
    3000,
  );
  check(
    "the teachers and their merged by model posted a cited directive set",
    seen.teacher >= 2 && seen.merged_by >= 1,
    seen,
  );
  await command("reset_workers", { run: "smoke-1" }, "local-1");
  const epoch = await until(
    "an epoch planned with the directive",
    async () =>
      (await rigEvents("local-1"))
        .filter((e) => e.kind === "epoch_started")
        .find((e) => e.body.directives?.length && e.body.assignments.some((a) => a.directive)),
    120_000,
    2000,
  );
  check(
    "the next epoch records the directive and the lane it steered",
    epoch.body.assignments.some((a) => a.family === "tiling" && a.directive),
    epoch.body,
  );

  // 2. Audits: a block holds a confirmed win; a clear lets the next one promote.
  const good = "kits/smoke-cpu/candidates/good";
  const goodSrc = readFileSync(join(good, "src/kernel/matmul.c"), "utf8");
  const marked = join(".dev", "marked-candidate");
  mkdirSync(join(marked, "src", "kernel"), { recursive: true });
  writeFileSync(join(marked, "src", "kernel", "matmul.c"), `${goodSrc}\n// SUSPICIOUS\n`);
  const submitTo = (service, patch, hypothesis) => {
    const b64 = Buffer.from(patch).toString("base64");
    return JSON.parse(
      dc(
        "exec",
        "-T",
        service,
        "sh",
        "-c",
        `echo ${b64} | base64 -d > /tmp/p.patch && thermite submit --harness http://127.0.0.1:8700 --token-file /run/secrets/${service === "harness" ? "harness" : "harness2"}-proposer-token --run smoke-1 --patch-file /tmp/p.patch --hypothesis "${hypothesis}"`,
      )
        .trim()
        .split("\n")
        .pop(),
    );
  };
  const blocked = submitTo("harness", candidatePatch(env, marked), "marked good kernel");
  await until(
    "the audit block",
    async () =>
      (await runOf("local-1"))?.audits?.some(
        (a) => a.attempt === blocked.attempt && a.decision === "block",
      ),
    900_000,
    3000,
  );
  const afterBlock = await runOf("local-1");
  check(
    "an audit block holds a confirmed win",
    afterBlock.champion.filter((c) => !c.reopened).at(-1).seq === 1 &&
      afterBlock.attempts.find((a) => a.id === blocked.attempt)?.lifecycle === "audit_blocked",
    afterBlock.audits,
  );
  // A win far above the absolute trigger: the auditor's clear is the last step, and it is
  // promoted with no owner step (goal 079: hands-off by default).
  const promotedWhenCleared = async (rig, attempt) =>
    until(
      `${attempt} cleared and promoted`,
      async () => {
        const i = await runOf(rig);
        return i?.audits?.some((a) => a.attempt === attempt && a.decision === "clear") &&
          i.champion.some((c) => c.attempt === attempt)
          ? i
          : undefined;
      },
      1_200_000,
      3000,
    );
  const clean = submitTo("harness", candidatePatch(env, good), "good kernel");
  const promoted = await promotedWhenCleared("local-1", clean.attempt);
  check(
    "a cleared audit of a large gain promotes it, with no owner step",
    promoted.audits.some((a) => a.attempt === clean.attempt && a.decision === "clear") &&
      !promoted.pending_promotions.includes(clean.attempt),
    promoted.audits,
  );

  // 3. Propagation and cross-verification.
  await until(
    "the champion published",
    async () => (await runOf("local-1"))?.published?.seq === 2,
    120_000,
    2000,
  );
  const prop = await until(
    "propagate issued",
    async () => {
      const r = await api("/v1/propagate", {
        method: "POST",
        body: JSON.stringify({ run: "smoke-1", to_run: "smoke-2" }),
      });
      return r.status === 201 ? r.body : undefined;
    },
    60_000,
    2000,
  );
  const received = await until(
    "local-2 received the champion",
    async () =>
      (await runOf("local-2"))?.propagations?.find((p) => p.source_seq === 2 && p.attempt),
    600_000,
    3000,
  );
  await promotedWhenCleared("local-2", received.attempt);
  const accepted = await until(
    "local-2 judged the propagated champion",
    async () =>
      (await runOf("local-2"))?.propagations?.find(
        (p) => p.result !== "judging" && p.source_seq === 2,
      ),
    1_200_000,
    3000,
  );
  check("rig 2's own judge accepted rig 1's champion", accepted.result === "accepted", {
    prop,
    accepted,
  });
  const board = (await api("/v1/leaderboard")).body.campaigns["smoke-cpu"] ?? [];
  const leader = board.find((r) => r.rig === "local-1");
  check(
    "the leaderboard shows rig 1's champion cross-verified by rig 2",
    leader?.verified_by?.includes("local-2"),
    board,
  );

  // 4. The supervisor cannot submit, and a forged command is refused.
  const probe = dc(
    "exec",
    "-T",
    "supervisor",
    "node",
    "-e",
    `const t=require("fs").readFileSync("/run/secrets/harness-supervisor-token","utf8").trim();fetch("http://harness:8700/v1/attempts",{method:"POST",headers:{authorization:"Bearer "+t,"content-type":"application/json"},body:JSON.stringify({run:"smoke-1",patch_base64:"eA==",hypothesis:"x"})}).then(r=>console.log(r.status))`,
  ).trim();
  check("the supervisor's token cannot submit attempts", probe.endsWith("401"), probe);
  const cmds = (await api("/v1/commands?limit=50")).body.commands;
  const forgedProbe = dc(
    "exec",
    "-T",
    "supervisor",
    "node",
    "-e",
    `const t=require("fs").readFileSync("/run/secrets/harness-supervisor-token","utf8").trim();const c={envelope:{v:1,id:"${crypto.randomUUID()}",rig:"local-1",kind:"approve_promotion",issued_by:"owner",issued_at:new Date().toISOString(),expires_at:new Date(Date.now()+60000).toISOString(),payload:{run:"smoke-1",attempt:"${blocked.attempt}"}},signature:"AAAA"};fetch("http://harness:8700/v1/commands",{method:"POST",headers:{authorization:"Bearer "+t,"content-type":"application/json"},body:JSON.stringify(c)}).then(r=>console.log(r.status))`,
  ).trim();
  check("a command forged by the supervisor is refused", forgedProbe.endsWith("403"), {
    forgedProbe,
    commands: cmds.length,
  });

  // 5. Reports and supervisor figures.
  const reports = await until(
    "daily reports",
    async () => {
      const r = (await api("/v1/reports?limit=10")).body.reports;
      return new Set(r.map((x) => x.rig)).size >= 2 ? r : undefined;
    },
    120_000,
    2000,
  );
  const sup = (await view("local-1")).supervisor;
  check(
    "daily reports and supervisor figures reach control",
    reports.length >= 2 &&
      sup?.export?.remote === true &&
      (sup?.advisors?.directive_sets ?? 0) >= 1,
    { rigs: reports.map((r) => r.rig), sup },
  );

  // 6. An advisor in Pi in its Pi view in the supervisor (goal 169): one teacher's call, with one
  // input typed into its view and one owner's message, both in its next model call.
  await piView.run(check, rigEvents);

  // 7. Lifecycle: restart through the compose driver.
  if (socket) {
    const r = await api("/v1/rigs/local-2/restart", {
      method: "POST",
      body: JSON.stringify({ components: ["supervisor"] }),
    });
    check(
      "control restarted rig 2's supervisor through the engine",
      r.status === 200 && r.body.restarted?.includes("supervisor-2"),
      r.body,
    );
    const t0 = Date.now();
    await until(
      "rig 2 reports again",
      async () => {
        const v = await view("local-2");
        return Date.parse(v.last_seen) > t0 ? v : undefined;
      },
      180_000,
      2000,
    );
  } else {
    check("lifecycle restart (no engine socket here: skipped)", true, "skipped");
  }

  // 8. Full reset of rig 2.
  const before = (await view("local-2")).ledger_id;
  const reset = await api("/v1/rigs/local-2/reset", {
    method: "POST",
    body: JSON.stringify({ confirm: "reset local-2" }),
  });
  if (reset.status !== 201) throw new Error(`reset refused: ${JSON.stringify(reset.body)}`);
  const waiting = await until(
    "the reset waits for the owner",
    async () => {
      const r = (await api("/v1/resets")).body.resets.find((x) => x.id === reset.body.reset);
      return ["awaiting_owner", "failed"].includes(r?.state) ? r : undefined;
    },
    600_000,
    3000,
  );
  check(
    "the reset verified the push and waits for the owner",
    waiting.state === "awaiting_owner",
    waiting,
  );
  await api(`/v1/resets/${reset.body.reset}/confirm`, { method: "POST", body: "{}" });
  const done = await until(
    "the reset finished",
    async () => {
      const r = (await api("/v1/resets")).body.resets.find((x) => x.id === reset.body.reset);
      return ["done", "failed"].includes(r?.state) ? r : undefined;
    },
    600_000,
    3000,
  );
  check(
    "the full reset ran: pause, quiesce, full export, verified push, confirmed wipe",
    done.state === "done",
    done,
  );
  const after = await until(
    "rig 2 reports a fresh ledger",
    async () => {
      const v = await view("local-2");
      return v.ledger_id && v.ledger_id !== before ? v : undefined;
    },
    300_000,
    3000,
  );
  check("rig 2 came back with a fresh ledger and no runs", after.runs.length === 0, {
    before,
    after: after.ledger_id,
  });
  const audit = (await api("/v1/audit?limit=500")).body.audit;
  check(
    "the reset's steps are in the audit log",
    audit.some((a) => a.action === "reset_requested") &&
      audit.some((a) => a.action === "reset_step"),
    audit.filter((a) => a.action.startsWith("reset")).length,
  );
} catch (err) {
  failed = true;
  check("acceptance run", false, String(err?.stack ?? err));
} finally {
  report.finished_at = new Date().toISOString();
  report.model_requests = requests;
  report.ok = !failed && report.checks.every((c) => c.ok);
  mkdirSync(join(".dev", "acceptance"), { recursive: true });
  const file = join(".dev", "acceptance", `m5-${report.started_at.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report: ${file}`);
  if (process.env.KEEP !== "1") dc("down", "-v");
  model.close();
  console.log(report.ok ? "steering acceptance: OK" : "steering acceptance: FAILED");
  if (!report.ok) process.exitCode = 1;
}
await sleep(0);
void secret;
