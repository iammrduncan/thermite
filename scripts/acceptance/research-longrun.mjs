#!/usr/bin/env node
// A long research run under compose with a scripted worker model (no real model needed): the
// harness's fetcher archives real public pages (robots.txt and rate limits respected), the
// scripted workers record claims quoting them, and the harness verifies the quotes, keeps the
// clock, writes digests and closes the campaign with a final report. Midway the controller is
// killed once, to check that the run resumes. This exercises the machinery over hours; it says
// nothing about research quality, which needs the real model route.
// Usage: COMPOSE="podman compose" MINUTES=125 node scripts/acceptance/research-longrun.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { acceptanceChecks } from "./lib/checks.mjs";
import { api, command, control, dc, prepare, sleep, until } from "./lib/smoke-env.mjs";

const minutes = Number(process.env.MINUTES ?? "125");
const SEEDS = (
  process.env.SEEDS ??
  "https://en.wikipedia.org/wiki/Benchmark_(computing),https://en.wikipedia.org/wiki/Statistical_hypothesis_test"
).split(",");
const DOMAIN = new URL(SEEDS[0]).hostname;

let requests = 0;
/** One sentence of at least 40 characters, from the text a fetch returned. */
function sentenceFrom(text, skip) {
  const sentences = String(text)
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.length >= 40 && s.length <= 240 && !/[[\]{}|=]/.test(s));
  return sentences[skip % Math.max(1, sentences.length)];
}

/** The scripted research worker: fetch one new page, quote two sentences, update a section. */
function script(messages) {
  const tools = messages.filter((m) => m.role === "tool");
  const brief = JSON.stringify(messages.find((m) => m.role === "user")?.content ?? "");
  const lane = /lane-(\d+)/.exec(brief)?.[1] ?? "1";
  const call = (name, args) => ({ toolCalls: [{ name, args }] });
  if (tools.length === 0) {
    // A link not fetched yet from the brief, on the campaign's domain; else a seed.
    const links = [...brief.matchAll(/https:\/\/[^\s"\\]+/g)]
      .map((m) => m[0])
      .filter((u) => {
        const x = new URL(u);
        // Articles only: no namespaces (Special:, File:, ...) and no query strings.
        return x.hostname === DOMAIN && !x.pathname.includes(":") && !x.search;
      });
    const fresh = brief.includes("not fetched yet")
      ? links.filter((u) => brief.indexOf(u) > brief.indexOf("not fetched yet"))
      : [];
    // A random new article from the frontier (pages start with navigation links); else a seed.
    const pick =
      fresh.length > 0
        ? fresh[Math.floor(Math.random() * fresh.length)]
        : SEEDS[(Number(lane) - 1) % SEEDS.length];
    return call("fetch", { url: pick });
  }
  const fetched = JSON.parse(
    String(tools[0]?.content?.[0]?.text ?? tools[0]?.content ?? "{}").replace(/^[^{]*/, "") || "{}",
  );
  if (!fetched.source)
    return { text: `nothing archived: ${JSON.stringify(fetched).slice(0, 200)}` };
  if (tools.length <= 2) {
    const s = sentenceFrom(fetched.text, tools.length * 3 + Number(lane));
    if (!s) return { text: "no quotable sentence" };
    return call("add_claim", {
      text: s,
      quotes: [{ source: fetched.source, quote: s }],
      question: (tools.length + Number(lane)) % 2,
    });
  }
  if (tools.length === 3) {
    return call("update_section", {
      name: `notes-lane-${lane}`,
      body: `Read ${fetched.url}: ${String(fetched.title ?? "untitled")}.`,
    });
  }
  return { text: "done for this trial" };
}

// The first turn of each trial waits, so the run stays light on the site it reads (about one
// page every two minutes).
const PACE_MS = Number(process.env.PACE_SECONDS ?? "120") * 1000;
const model = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => {
    body += d;
  });
  req.on("end", async () => {
    requests++;
    const p = JSON.parse(body);
    const planner = (p.tools ?? []).some((t) => t.function.name === "submit_plan");
    if (!planner && !(p.messages ?? []).some((m) => m.role === "tool")) await sleep(PACE_MS);
    const turn = planner ? { text: "no plan" } : script(p.messages ?? []);
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
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((r) => model.listen(0, "0.0.0.0", r));
const port = model.address().port;
const hostName = (process.env.COMPOSE ?? "podman compose").startsWith("docker")
  ? "host.docker.internal"
  : "host.containers.internal";
const composeEnv = {
  THERMITE_POLL_SECONDS: "10",
  THERMITE_MODEL_BASE_URL: `http://${hostName}:${port}/v1`,
  THERMITE_MODEL: "scripted-researcher",
  THERMITE_MAX_TRIALS: "1",
  THERMITE_TRIAL_MINUTES: "5",
};

const report = { started_at: new Date().toISOString(), minutes, seeds: SEEDS, checks: [] };
const { check } = acceptanceChecks({ max: 400, into: report.checks });

prepare();
const { parseContract } = await import("../../dist/core/contract.js");
const parsed = parseContract({
  schema_version: 1,
  campaign: "benchmark-statistics",
  version: 1,
  title: "How benchmarks handle noise",
  mode: "research",
  project: { repo: "research-notes" },
  topic: "How performance benchmarks are designed and how their results are tested statistically",
  questions: [
    "What makes a benchmark representative and repeatable?",
    "How are differences between measurements tested for significance?",
  ],
  seeds: SEEDS,
  scope: { include_domains: [DOMAIN] },
  lanes: { count: 1, trials_per_epoch: 1 },
  min_duration: `${minutes}m`,
  max_duration: `${minutes + 5}m`,
  report_cadence: { digest_minutes: 30, report_hours: 24 },
  fetch_policy: { per_domain_per_minute: 4, max_bytes: 3_000_000 },
});
if (!parsed.ok) throw new Error(parsed.errors.join("; "));

dc(composeEnv, "up", "-d", "--build");
let failed = false;
const rigEvents = async () => {
  const all = [];
  let after = 0;
  for (;;) {
    const page = await api(`/v1/rigs/local-1/events?after=${after}&limit=5000`);
    all.push(...page.body.events);
    if (page.body.events.length < 5000) return all;
    after = page.body.events.at(-1).seq;
  }
};
try {
  await until("control health", async () => (await fetch(`${control}/v1/health`)).ok);
  await command("assign_campaign", {
    run: "research-1",
    contract: parsed.contract,
    contract_sha: parsed.sha,
    imports: [],
  });
  const started = Date.now();
  let killed = false;
  for (;;) {
    await sleep(60_000);
    const v = (await api("/v1/rigs/local-1/view")).body;
    const inst = v.runs?.find((i) => i.id === "research-1");
    const r = inst?.research ?? {};
    console.log(
      `${Math.round((Date.now() - started) / 60000)} min: ${inst?.status} sources ${r.sources ?? 0} verified ${r.verified ?? 0} trials ${inst?.agents?.trials ?? 0} model requests ${requests}`,
    );
    if (!killed && Date.now() - started > (minutes / 2) * 60_000) {
      // Kill the controller once (the broker restarts it); the run must go on.
      dc(
        composeEnv,
        "exec",
        "-T",
        "harness",
        "node",
        "-e",
        `const fs=require("fs");for(const p of fs.readdirSync("/proc")){if(!/^\\d+$/.test(p)||Number(p)===process.pid)continue;try{if(fs.readFileSync("/proc/"+p+"/cmdline","utf8").split("\\0").some(a=>a.endsWith("harness/main.js")))process.kill(Number(p),"SIGKILL")}catch{}}`,
      );
      killed = true;
      console.log("killed the harness controller");
    }
    if (inst?.status === "closed") break;
    if (Date.now() - started > (minutes + 30) * 60_000)
      throw new Error("the campaign did not close");
  }
  const evs = await rigEvents();
  const final = evs.filter((e) => e.kind === "research_final").at(-1)?.body;
  const digests = evs.filter((e) => e.kind === "research_digest").length;
  const interrupted = evs.filter(
    (e) => e.kind === "trial_finished" && e.body.stopped === "interrupted",
  ).length;
  const trials = evs.filter((e) => e.kind === "trial_finished").length;
  const closed = evs.find(
    (e) => e.kind === "run_status" && e.subject === "research-1" && e.body.status === "closed",
  );
  const elapsedMin = (Date.parse(closed?.at ?? new Date().toISOString()) - started) / 60000;
  check("the campaign ran its minimum time and closed itself", elapsedMin >= minutes, {
    elapsed_minutes: Math.round(elapsedMin),
  });
  check("digests were written on the cadence", digests >= Math.floor(minutes / 30), { digests });
  check(
    "verified claims and sources came from real pages",
    (final?.verified ?? 0) > 0 && (final?.sources ?? 0) > 0,
    {
      sources: final?.sources,
      domains: final?.domains,
      verified: final?.verified,
      drafts: final?.drafts,
    },
  );
  check("the run survived a controller kill", killed && trials > interrupted, {
    trials,
    interrupted,
  });
  check(
    "the final report exists",
    typeof final?.report === "string" && final.report.includes("## Findings"),
    (final?.report ?? "").slice(0, 300),
  );
  report.final_report = final?.report;
} catch (err) {
  failed = true;
  check("long run", false, String(err?.stack ?? err));
} finally {
  report.finished_at = new Date().toISOString();
  report.model_requests = requests;
  report.ok = !failed && report.checks.every((c) => c.ok);
  mkdirSync(join(".dev", "acceptance"), { recursive: true });
  const file = join(
    ".dev",
    "acceptance",
    `research-longrun-${report.started_at.replace(/[:.]/g, "-")}.json`,
  );
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report: ${file}`);
  if (process.env.KEEP !== "1") dc(composeEnv, "down", "-v");
  model.close();
  console.log(report.ok ? "research long run: OK" : "research long run: FAILED");
  if (!report.ok) process.exitCode = 1;
}
