// Test only (scripts/acceptance/claude-real.mjs): Thermite's own calls of Claude Code, run in the
// harness container with the image's real Claude Code and the stand-in for Anthropic's API
// (anthropic.mjs). It prints one JSON line: { checks: [{ name, ok, detail }], peakRssBytes,
// peakTerminalRssBytes }, the peak memory the broker recorded for Claude Code's runs in the
// headless trial, and for the terminal host's run (the host, Claude Code and its commands) in the
// trial in its terminal.
//   node check.mjs harness   as the controller's user: the model check, a planner call and
//                            trials, through the broker (each as its role's user): the same
//                            trial in Claude Code's own terminal (goal 169; the default) and
//                            headless, and a trial that compacts, in its terminal
//   node check.mjs advisor   as the supervisor's user, with its own TMPDIR: an advisor's call,
//                            and what /proc shows of its processes' environments
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { startAnthropicStandIn } from "./anthropic.mjs";

/** A made-up sign-in token: letters only, never a real one. */
const TOKEN = "madeupsignintokenforthestandin";
const checks = [];
/**
 * The most memory the broker recorded for one of Claude Code's runs in the headless trial, and
 * for the terminal host's run in the trial in its terminal.
 */
let peakRssBytes;
let peakTerminalRssBytes;
/** One check; `log`: lines that say why it failed, printed in full when it does. */
const check = (name, ok, detail, log) =>
  checks.push({ name, ok: Boolean(ok), detail, ...(!ok && log?.length ? { log } : {}) });
const here = "/opt/test-anthropic";
process.env.THERMITE_CLAUDE_BIN = `${here}/claude`;
const model = {
  api: "claude",
  harness: "claude-code",
  baseUrl: "https://api.anthropic.com",
  model: "claude-opus-5-5",
  apiKey: TOKEN,
  contextWindow: 1_000_000,
  maxTokens: 0,
};
const api = await startAnthropicStandIn({ token: TOKEN });

async function harness() {
  const { BrokerClient } = await import("/opt/thermite/dist/harness/broker/client.js");
  const { claudeModelCheck, claudeOnce, runClaudeTrial } = await import(
    "/opt/thermite/dist/harness/agents/cli/claude-code.js"
  );
  const runner = new BrokerClient("/run/thermite/broker.sock");
  const scratchDir = "/scratch/thermite";
  const deps = { runner, apiUrl: "http://127.0.0.1:8700", scratchDir };

  // The model check, as the rig check runs it.
  const mc = await claudeModelCheck(model, deps);
  check(
    "the model check passes: Claude Code ran its Bash call as the model check's user",
    mc.ok && mc.detail.tool_called,
    mc.summary,
  );

  // A planner call with past research: Claude Code's Grep (its own ripgrep) reads a folder
  // outside its own, as the planner's user, which may read it.
  const kdir = join(scratchDir, "claude-real-knowledge");
  mkdirSync(kdir, { recursive: true });
  chmodSync(kdir, 0o755);
  writeFileSync(join(kdir, "notes.md"), "aligned loads made the kernel 12% faster\n", {
    mode: 0o644,
  });
  const grep = { pattern: "aligned", path: kdir, output_mode: "content" };
  const pl = await claudeOnce(
    model,
    `Plan the next round. First call the Grep tool with input ${JSON.stringify(grep)}END`,
    deps,
    { tools: "Read,Grep,Glob", timeoutMs: 120_000, role: "planner" },
  );
  const found = pl.tools.find((t) => t.tool === "Grep");
  check(
    "a planner call's Grep read past research outside its folder, as the planner's user",
    found?.ok && /aligned loads/.test(found.output),
    found ?? pl.errors.at(-1) ?? pl.notes,
  );

  // A trial: Claude Code edits the workspace with its Write tool, runs a command that looks for
  // the token, and submits with thermite-trial, as the lane's user. The harness API is a stand-in
  // here that takes the submission. The same trial runs in Claude Code's own terminal (goal 169:
  // the rig's default), through the terminal host, and headless (`-p`), an advanced choice.
  const lane = "lane-1";
  for (const terminal of [true, false])
    await codeTrial({ runner, runClaudeTrial, lane, scratchDir, terminal });

  // Goal 070: a trial that compacts. The stand-in makes two rounds and says the conversation is
  // large after the second, so the real Claude Code compacts before its next request (its window
  // 100,000 tokens, compacted at 50%). Thermite's PreCompact hook, from Thermite's settings for
  // the run, copies the transcript as the lane's user and adds its line to the compaction's
  // instructions; the stand-in's summary names the file, and the harness reads the hook's copy.
  // Claude Code writes its debug log (DEBUG=1) in its home: on a failure, the check prints its
  // compaction lines, with what the hooks wrote and what the transcript shows.
  const area2 = join(scratchDir, "lanes", lane, randomUUID());
  const repo2 = join(area2, "repo");
  mkdirSync(join(repo2, "src"), { recursive: true });
  writeFileSync(join(repo2, "src", "value.txt"), "1\n");
  execFileSync("git", ["init", "--quiet", "-b", "work"], { cwd: repo2, stdio: "ignore" });
  await runner.handOver(area2, lane, { harnessReads: true });
  const compacted = [];
  const said2 = [];
  const kept = { dir: join(scratchDir, "research", "claude-real-1", "compactions"), stem: "t-compact", readable: true };
  // In its terminal: the compaction comes from its transcript, as the host copies it.
  const ct = await runClaudeTrial(
    {
      trialId: "t-compact",
      token: "trial-compact",
      run: "claude-real-1",
      lane,
      workspace: repo2,
      workspaceRoot: area2,
      parentCommit: "0".repeat(40),
      editablePaths: ["src/**"],
      brief: "COMPACT-CHECK Look at the value.",
      wallMs: 150_000,
    },
    {
      runner,
      model: { ...model, contextWindow: 100_000, compactAt: 50 },
      apiUrl: "http://127.0.0.1:9",
      live: (entries) => said2.push(...entries),
      progress: () => undefined,
      submitted: () => undefined,
      pollMs: 300,
      keptAt: kept,
      compacted: (c) => compacted.push(c),
      env: { DEBUG: "1" },
      terminal: true,
    },
  );
  const first = compacted[0];
  const compactedOk =
    first?.number === 1 &&
    first.own === true &&
    /from Claude Code's own transcript of the session/.test(first.markdown) &&
    /COMPACT-CHECK/.test(first.markdown) &&
    // The newest tool result before the compaction: Claude Code wrote it to its transcript only
    // while the hook waited.
    /Tool result: Bash \(toolu_compact_2\)/.test(first.markdown) &&
    (first.summary ?? "").includes(`${kept.dir}/t-compact-1.md`);
  check(
    "the real Claude Code, in its terminal, compacted a trial's conversation: its PreCompact hook copied the whole transcript, to the last tool result, and the summary names the kept file",
    compactedOk,
    {
      compactions: ct.compactions ?? 0,
      stopped: ct.stopped,
      error: ct.error,
      own: first?.own,
      summary: first?.summary,
      head: first?.markdown.slice(0, 300),
      results: first?.markdown.match(/Tool result: [^\n]*/g),
    },
    compactedOk ? undefined : await compactionDiagnostics(runner, area2, said2),
  );
  await runner.remove(area2);
  runner.close();
}

/**
 * The trial that edits the workspace and submits, in Claude Code's own terminal or headless, in a
 * workspace of its own; its checks, and the peak memory of its runs.
 */
async function codeTrial({ runner, runClaudeTrial, lane, scratchDir, terminal }) {
  const mode = terminal ? "in its terminal" : "headless";
  const area = join(scratchDir, "lanes", lane, randomUUID());
  const repo = join(area, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "value.txt"), "1\n");
  const git = (...a) =>
    execFileSync(
      "git",
      ["-c", "user.name=thermite", "-c", "user.email=thermite@localhost", ...a],
      { cwd: repo, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: area }, stdio: "ignore" },
    );
  git("init", "--quiet", "-b", "work");
  git("add", "-A");
  git("commit", "--quiet", "-m", "parent");
  await runner.handOver(area, lane, { harnessReads: true });
  let submission;
  const harnessApi = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => {
      raw += d;
    });
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/v1/attempts") {
        const body = JSON.parse(raw);
        submission = {
          trialToken: req.headers.authorization === "Bearer trial.trial-check",
          patch: Buffer.from(body.patch_base64, "base64").toString("utf8"),
          hypothesis: body.hypothesis,
        };
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ attempt: "a-check", lifecycle: "queued" }));
        return;
      }
      res.writeHead(404).end("{}");
    });
  });
  await new Promise((r) => harnessApi.listen(0, "127.0.0.1", r));
  const write = { file_path: join(repo, "src", "value.txt"), content: "2\n" };
  const half = Math.floor(TOKEN.length / 2);
  const bash = {
    command: `node ${here}/probe.mjs ${TOKEN.slice(0, half)} ${TOKEN.slice(half)} && thermite-trial submit --hypothesis "value two, from the real Claude Code"`,
  };
  const live = [];
  // The trial's console in its terminal (goal 169): its last screen, kept in memory at its end.
  let held;
  // What the broker records of each of Claude Code's runs (the program's run, or the terminal
  // host's, is the one it may spare from the memory limit), for the figure in Claude Code's limits
  // note.
  let peak = 0;
  const measured = new Proxy(runner, {
    get(target, key) {
      if (key === "run")
        return async (req) => {
          const r = await target.run(req);
          if (req.spareExe) peak = Math.max(peak, r.peakRssBytes ?? 0);
          return r;
        };
      const v = target[key];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const trial = await runClaudeTrial(
    {
      trialId: `t-check-${terminal ? "terminal" : "headless"}`,
      token: "trial-check",
      run: "claude-real-1",
      lane,
      workspace: repo,
      workspaceRoot: area,
      parentCommit: "0".repeat(40),
      editablePaths: ["src/**"],
      brief: `Set the value to 2. First call the Write tool with input ${JSON.stringify(write)}END Then call the Bash tool with input ${JSON.stringify(bash)}END`,
      wallMs: 180_000,
    },
    {
      runner: measured,
      model,
      apiUrl: `http://127.0.0.1:${harnessApi.address().port}`,
      live: (entries) => live.push(...entries),
      progress: () => undefined,
      submitted: () => (submission ? { attempt: "a-check", lifecycle: "queued" } : undefined),
      pollMs: 300,
      afterSubmitMs: 1500,
      terminal,
      console: (c) => {
        if (c !== "headless") held = c;
      },
    },
  ).finally(() => harnessApi.close());
  if (terminal) peakTerminalRssBytes = peak;
  else peakRssBytes = peak;
  check(
    `a trial in Claude Code ${mode} submitted with thermite-trial, with the trial's token`,
    trial.stopped === "submitted" && submission?.trialToken,
    { stopped: trial.stopped, error: trial.error, turns: trial.turns, tokensIn: trial.tokensIn },
  );
  check(
    `its Write tool changed the workspace ${mode}: permissions bypassed, nothing waited for approval`,
    /-1\n\+2/.test(submission?.patch ?? "") && /src\/value\.txt/.test(submission?.patch ?? ""),
    submission?.patch ?? live.slice(-4),
  );
  const said = live.find((e) => e.kind === "result" && /signin=/.test(e.text))?.text ?? "";
  check(
    `its command ran as the lane's user ${mode} and found the token in no environment, Claude Code's included`,
    /uid=10101 signin=absent/.test(said),
    said || live.slice(-4),
  );
  if (terminal) {
    // The host's copy of its transcript, which the tally came from, and its screen at the end,
    // kept in memory for the live view, never in the trial's area.
    const copy = join(area, "claude-session.jsonl");
    const screen = held?.lastScreen()?.data ?? "";
    const copied = existsSync(copy) ? readFileSync(copy, "utf8").split("\n").filter(Boolean) : [];
    check(
      "in its terminal, its transcript was copied for the harness and its tally came from it, and its screen was kept at the end",
      copied.some((l) => l.includes('"type":"assistant"')) &&
        trial.turns >= 2 &&
        trial.tokensIn > 0 &&
        screen.length > 0 &&
        !existsSync(join(area, "claude-screen.ansi")),
      { lines: copied.length, turns: trial.turns, screen: screen.length },
    );
  }
  await runner.remove(area);
}

/**
 * Why a trial did not compact as expected, as lines: Claude Code's own debug log (its
 * `autocompact:` and `Reactive compact:` lines and the hooks it ran), what Thermite's hooks wrote
 * in the trial's area, what Claude Code's transcript shows, and the trial's last live lines. The
 * controller takes the area back first: Claude Code keeps its files private to the lane's user.
 */
async function compactionDiagnostics(runner, area, live) {
  const out = [];
  try {
    await runner.reclaim(area);
  } catch (err) {
    out.push(`(the area could not be taken back: ${String(err)})`);
  }
  const files = (dir) => {
    try {
      return readdirSync(dir).map((f) => join(dir, f));
    } catch {
      return [];
    }
  };
  const home = join(area, "claude-home", ".claude");
  for (const log of files(join(home, "debug")).filter((f) => f.endsWith(".txt"))) {
    const lines = readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => /compact|PreCompact|PostCompact|hook|settings/i.test(l));
    out.push(`debug log ${log} (${lines.length} lines about compaction or hooks; the last 60):`);
    out.push(...lines.slice(-60).map((l) => `  ${l.slice(0, 400)}`));
  }
  if (!files(join(home, "debug")).length) out.push(`no debug log under ${join(home, "debug")}`);
  const drops = files(join(area, "claude-compactions"));
  out.push(`the hooks' folder: ${drops.map((f) => f.split("/").pop()).join(", ") || "empty or missing"}`);
  for (const f of drops.filter((f) => f.endsWith(".meta.json")))
    out.push(`  ${f.split("/").pop()}: ${readFileSync(f, "utf8").trim().slice(0, 600)}`);
  for (const f of drops.filter((f) => f.endsWith(".jsonl")))
    out.push(`  ${f.split("/").pop()}: ${readFileSync(f, "utf8").split("\n").filter(Boolean).length} lines`);
  for (const project of files(join(home, "projects")))
    for (const t of files(project).filter((f) => f.endsWith(".jsonl"))) {
      const lines = readFileSync(t, "utf8").split("\n").filter(Boolean);
      const boundaries = lines.filter((l) => /"subtype":"compact_boundary"/.test(l)).length;
      const summaries = lines.filter((l) => /"isCompactSummary":true/.test(l)).length;
      out.push(`transcript ${t}: ${lines.length} lines, ${boundaries} compaction boundaries, ${summaries} summaries`);
    }
  out.push("the trial's last live lines:");
  out.push(...live.slice(-12).map((e) => `  ${e.kind}: ${String(e.text).slice(0, 300)}`));
  return out;
}

/**
 * The processes of an advisor's call (their environment names its folder, thermite-advisor-…), as
 * /proc shows them to the supervisor's user while the call runs: whether the token or the scrub
 * is in each one's environment, and whether it names the token's file descriptor. Never the token.
 */
function watchAdvisor() {
  const seen = new Map();
  const look = () => {
    for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
      let env;
      try {
        env = readFileSync(`/proc/${pid}/environ`, "latin1");
      } catch {
        continue; // gone, or another user's
      }
      if (!env.includes("/thermite-advisor-")) continue;
      let exe = "";
      try {
        exe = readlinkSync(`/proc/${pid}/exe`);
      } catch {
        // gone
      }
      const vars = env.split("\0");
      const was = seen.get(pid);
      let ppid = was?.ppid ?? "";
      let argv0 = was?.argv0 ?? "";
      try {
        ppid = readFileSync(`/proc/${pid}/stat`, "latin1").replace(/^.*\) /s, "").split(" ")[1] ?? "";
        argv0 = readFileSync(`/proc/${pid}/cmdline`, "latin1").split("\0")[0] ?? "";
      } catch {
        // gone
      }
      const scrub = vars.some((v) => v.startsWith("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB="));
      seen.set(pid, {
        pid,
        ppid,
        argv0,
        exe: exe || was?.exe || "",
        token: env.includes(TOKEN) || Boolean(was?.token),
        scrub: scrub || Boolean(was?.scrub),
        fd: vars.includes("CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3") || Boolean(was?.fd),
      });
    }
  };
  const timer = setInterval(look, 20);
  return {
    stop: () => {
      clearInterval(timer);
      return [...seen.values()];
    },
  };
}

async function advisor() {
  const { runAdvisor } = await import("/opt/thermite/dist/supervisor/advisors/index.js");
  // The auditor's own prompt, as its role renders it (goal 166), with the check's marker in its
  // package.
  const { renderAuditor } = await import("/opt/thermite/dist/agents/roles/index.js");
  const watch = watchAdvisor();
  const r = await runAdvisor({
    runtime: { name: "check", runtime: "claude-code", model: model.model, token: TOKEN, timeout_s: 120 },
    prompt: (f) => renderAuditor({ pkg: { question: "ADVISOR-CHECK Is this change clear?" } }, f),
    schema: {
      safeParse: (v) =>
        v && typeof v === "object" && typeof v.decision === "string"
          ? { success: true, data: v }
          : { success: false },
    },
    answerSchema: { type: "object", properties: { decision: { type: "string" } } },
  });
  const procs = watch.stop();
  check(
    "an advisor's call in Claude Code answered, as the supervisor's user with /tmp closed to it",
    r.output?.decision === "clear",
    r.error ?? r.output,
  );
  // Claude Code also starts short-lived copies of its own binary (its ripgrep, for one), without
  // file descriptor 3 or its name: only the call's own Claude Code, whose parent is not Claude
  // Code, signs in. No process of the call may have the token or the scrub.
  const claude = procs.filter((p) => p.exe === "/usr/local/bin/claude");
  const pids = new Set(claude.map((p) => p.pid));
  const main = claude.filter((p) => !pids.has(p.ppid));
  check(
    "the advisor's Claude Code ran without the scrub, its sign-in on file descriptor 3, and no process of the call had the token in its environment",
    main.length > 0 && main.every((p) => p.fd) && procs.every((p) => !p.token && !p.scrub),
    procs,
  );
}

const mode = process.argv[2] === "advisor" ? "advisor" : "harness";
try {
  if (mode === "advisor") await advisor();
  else await harness();
} catch (err) {
  check(`the ${mode} checks ran`, false, err instanceof Error ? err.stack : String(err));
}
check(
  `every call to the stand-in for Anthropic's API was signed in with the token (${mode})`,
  api.seen.signedIn > 0 && api.seen.other === 0,
  api.seen,
);
await api.close();
console.log(
  JSON.stringify({
    checks,
    ...(peakRssBytes !== undefined ? { peakRssBytes } : {}),
    ...(peakTerminalRssBytes !== undefined ? { peakTerminalRssBytes } : {}),
  }),
);
// A check that failed may leave a server or the broker's connection open: the line above is all.
process.exit(0);
