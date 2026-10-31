#!/usr/bin/env node
// M2a judge acceptance under compose on the cpu driver. It assigns the smoke campaign, then
// checks the plan's M2 verify list:
//   - every smoke candidate gets its expected verdict (broken -> invalid, no-op -> neutral,
//     a known-good change -> win_confirmed and promoted, timer and reference edits refused at
//     V0, reference fallback fails the dispatch proof, NaN never a score, OOM and disk fill
//     are crash_candidate);
//   - role users cannot reach the ledger, kits, builds, secrets or the broker (isolation);
//   - tampering with the build store fails and leaves the builds intact;
//   - nothing a run starts outlives it;
//   - the isolation and smoke rig checks pass when asked for through control;
//   - a killed controller is recorded as crash_infra exactly once, and the job completes;
//   - the run's first job measures the starting point on every cell (its baseline, goal 115);
//   - an A/A calibration measures the rig's noise.
// It writes a JSON report to .dev/acceptance/. Usage: COMPOSE="podman compose" node scripts/acceptance/judge.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acceptanceChecks } from "./lib/checks.mjs";
import {
  assign,
  candidatePatch,
  dc,
  events,
  latestVerdicts,
  lifecycles,
  prepare,
  rigCheck,
  sleep,
  submit,
  until,
} from "./lib/smoke-env.mjs";

const composeEnv = {
  THERMITE_POLL_SECONDS: "2",
  THERMITE_PROMOTION: "auto",
  THERMITE_CALIBRATION_BLOCKS: "6",
};
const report = {
  started_at: new Date().toISOString(),
  compose: process.env.COMPOSE ?? "podman compose",
  checks: [],
};
const { check } = acceptanceChecks({ into: report.checks });
const harnessExec = (...args) => dc(composeEnv, "exec", "-T", "harness", ...args);
const procsOf = (uid) =>
  JSON.parse(
    harnessExec(
      "node",
      "-e",
      `const fs=require("fs");const out=[];for(const p of fs.readdirSync("/proc")){if(!/^\\d+$/.test(p))continue;try{const s=fs.readFileSync("/proc/"+p+"/status","utf8");if(new RegExp("^Uid:\\\\s+${uid}\\\\b","m").test(s))out.push(Number(p))}catch{}}process.stdout.write(JSON.stringify(out))`,
    ),
  );

const env = prepare();
const candidates = JSON.parse(readFileSync("kits/smoke-cpu/candidates/candidates.json", "utf8"));
console.log("compose: build and start");
dc(composeEnv, "up", "-d", "--build");
let failed = false;
try {
  await until("control health", async () => (await fetch("http://127.0.0.1:8800/v1/health")).ok);
  await assign(env, "smoke-1");
  check("assign_campaign with pinned project and kit bundles", true);

  // The baseline runs first (goal 115): the starting point alone on every measured cell. The
  // calibration follows it.
  const baseline = await until(
    "the baseline of the starting point",
    async () => (await events()).find((e) => e.kind === "baseline" && e.subject === "smoke-1"),
    600_000,
    2000,
  );
  check(
    "baseline measured: champion #1 on every cell",
    baseline.body.champion_seq === 1 &&
      Object.values(baseline.body.cells ?? {}).length > 0 &&
      Object.values(baseline.body.cells).every((m) =>
        Object.values(m).every((v) => v.median > 0 && v.n === baseline.body.blocks),
      ),
    baseline.body.summary,
  );
  const calibration = await until(
    "A/A calibration",
    async () => (await events()).find((e) => e.kind === "calibration"),
    600_000,
    2000,
  );
  check(
    "A/A calibration measured",
    Number.isFinite(calibration.body.sigma),
    calibration.body.summary,
  );

  // The isolation selftest, asked for through control as an operator would: the rig refuses
  // it while busy (its probes kill each role's processes), so it is asked again until idle.
  const isolation = await rigCheck("isolation");
  check("isolation through control: role users are refused everywhere", isolation.ok === true, {
    summary: isolation.summary,
    detail: isolation.detail,
  });

  // Everything except the known-good change first, so each is judged against the seed.
  const ids = {};
  for (const [name, c] of Object.entries(candidates)) {
    if (name === "good") continue;
    const a = submit(
      composeEnv,
      "smoke-1",
      candidatePatch(env, `kits/smoke-cpu/candidates/${name}`),
      c.hypothesis,
    );
    ids[name] = a.attempt;
  }
  const settled = (evs, id) => {
    const life = lifecycles(evs)[id];
    return [
      "judged",
      "rejected_v0",
      "duplicate",
      "promoted",
      "awaiting_approval",
      "errored",
    ].includes(life);
  };
  await until(
    "all candidates judged",
    async () => {
      const evs = await events();
      return Object.values(ids).every((id) => settled(evs, id));
    },
    1_800_000,
    3000,
  );
  ids.good = submit(
    composeEnv,
    "smoke-1",
    candidatePatch(env, "kits/smoke-cpu/candidates/good"),
    candidates.good.hypothesis,
  ).attempt;
  await until(
    "good candidate settled",
    async () => settled(await events(), ids.good),
    900_000,
    3000,
  );

  const evs = await events();
  const verdicts = latestVerdicts(evs);
  const lifes = lifecycles(evs);
  for (const [name, c] of Object.entries(candidates)) {
    const got = c.expect === "rejected_v0" ? lifes[ids[name]] : verdicts[ids[name]];
    const ok = c.accept ? c.accept.includes(got) : got === c.expect;
    check(`candidate ${name} -> ${c.accept ? c.accept.join("|") : c.expect}`, ok, got);
  }
  const promoted = evs.find((e) => e.kind === "champion_promoted" && e.body.attempt === ids.good);
  check("the confirmed win was promoted by compare-and-swap", Boolean(promoted), promoted?.body);
  const integrity = JSON.parse(
    harnessExec(
      "node",
      "-e",
      `const fs=require("fs"),c=require("crypto"),p=require("path");const root="/var/lib/thermite/builds";const bad=[];let n=0;for(const k of fs.readdirSync(root)){const m=p.join(root,k,"manifest.json");if(!fs.existsSync(m))continue;for(const [f,h] of Object.entries(JSON.parse(fs.readFileSync(m,"utf8")).files)){n++;if(c.createHash("sha256").update(fs.readFileSync(p.join(root,k,f))).digest("hex")!==h)bad.push(k+"/"+f)}}process.stdout.write(JSON.stringify({files:n,bad}))`,
    ),
  );
  check(
    "build store intact after the overwrite attempt (every file matches its manifest)",
    integrity.files > 0 && integrity.bad.length === 0,
    integrity,
  );
  const leftovers = procsOf(10030);
  check("no run-user process outlives its run", leftovers.length === 0, leftovers);
  const nanScores = evs.filter(
    (e) => e.kind === "verdict" && e.subject === ids.nan && e.body.delta !== null,
  );
  check("NaN never became a score", nanScores.length === 0, nanScores.length);

  // Kill the controller in the middle of a job: the broker restarts it, the lease is reclaimed
  // as crash_infra once, and the job runs again to a verdict.
  const victim = submit(
    composeEnv,
    "smoke-1",
    candidatePatch(env, "kits/smoke-cpu/candidates/linger", "kits/smoke-cpu/candidates/good"),
    "a change on top of the new champion",
  ).attempt;
  await until(
    "victim screening",
    async () => lifecycles(await events())[victim] === "screening",
    600_000,
    500,
  );
  harnessExec(
    "node",
    "-e",
    `const fs=require("fs");for(const p of fs.readdirSync("/proc")){if(!/^\\d+$/.test(p))continue;try{const a=fs.readFileSync("/proc/"+p+"/cmdline","utf8").split("\\0");if(Number(p)!==process.pid&&(a[1]||"").endsWith("dist/harness/main.js"))process.kill(Number(p),"SIGKILL")}catch{}}`,
  );
  await until(
    "victim settled after restart",
    async () => settled(await events(), victim),
    900_000,
    3000,
  );
  const after = await events();
  const jobsOfVictim = new Set(
    after.filter((e) => e.kind === "job_queued" && e.body.attempt === victim).map((e) => e.subject),
  );
  const crashes = after.filter((e) => e.kind === "crash_infra" && jobsOfVictim.has(e.subject));
  check(
    "killed controller: crash_infra recorded exactly once",
    crashes.length === 1,
    crashes.map((e) => e.subject),
  );
  check(
    "killed controller: the attempt still got a verdict",
    Boolean(latestVerdicts(after)[victim]),
    latestVerdicts(after)[victim],
  );

  // The same smoke, asked for through control as an operator would: the harness builds the
  // campaign from the kit in its image, judges every candidate and compares each verdict.
  const smoke = await rigCheck("smoke", { timeoutMs: 1_800_000 });
  check("the smoke check through control: every candidate as expected", smoke.ok === true, {
    summary: smoke.summary,
    candidates: smoke.detail?.candidates,
  });

  // Resource numbers for sizing a rig (the CPU smoke; a GPU rig's come from its CUDA smoke).
  const peaks = JSON.parse(
    harnessExec(
      "node",
      "-e",
      `const fs=require("fs");const out={};for(const p of fs.readdirSync("/proc")){if(!/^\\d+$/.test(p))continue;try{const c=fs.readFileSync("/proc/"+p+"/cmdline","utf8").replace(/\\0/g," ").trim();const s=fs.readFileSync("/proc/"+p+"/status","utf8");const hwm=Number(/^VmHWM:\\s+(\\d+)/m.exec(s)?.[1]??0)*1024;if(c)out[c.slice(0,80)]=hwm}catch{}}process.stdout.write(JSON.stringify(out))`,
    ),
  );
  const runPeaks = after
    .filter((e) => e.kind === "job_finished")
    .map((e) => e.body.result?.verdict)
    .filter(Boolean).length;
  report.resources = { process_peak_rss_bytes: peaks, judged_jobs: runPeaks };
  check("resource peaks recorded", Object.keys(peaks).length > 0, peaks);
} catch (err) {
  failed = true;
  check("acceptance run", false, String(err?.stack ?? err));
} finally {
  // Every verdict with its reasons, for diagnosing a miss after the stack is gone.
  try {
    report.verdicts = JSON.parse(
      harnessExec(
        "node",
        "-e",
        `const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("/var/lib/thermite/ledger/ledger.db",{readOnly:true});process.stdout.write(JSON.stringify(db.prepare("select v.attempt, a.hypothesis, v.verdict, v.reasons from verdict v join attempt a on a.id = v.attempt order by v.id").all()))`,
      ),
    );
  } catch {
    report.verdicts = "unavailable";
  }
  report.finished_at = new Date().toISOString();
  report.ok = !failed && report.checks.every((c) => c.ok);
  mkdirSync(join(".dev", "acceptance"), { recursive: true });
  const file = join(".dev", "acceptance", `m2a-${report.started_at.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report: ${file}`);
  if (process.env.KEEP !== "1") dc(composeEnv, "down", "-v");
  console.log(report.ok ? "judge acceptance: OK" : "judge acceptance: FAILED");
  if (!report.ok) process.exitCode = 1;
}
await sleep(0);
