// Test only (check.mjs, in the harness image): a worker in Pi in its Pi view (goal 169), as a rig
// runs it: spawnTrial with the trial's console, under the real broker, which runs the terminal host
// and the worker as agent-1 in the worker's own folder in the harness's scratch area. A stand-in
// for the harness's API answers the worker's trial routes, with the harness's real side of the
// console (PiConsole), and a stand-in model answers its calls, holding the first while the owner's
// inputs go in. Checked: the worker runs as agent-1; the folders' modes; neither lane-1 nor agent-2
// can list the trials' folder, enter the trial's or reach its socket; the view on the screen; the
// owner's words, /status, a command the view has not, and Esc, each as the console says; the
// steered words in the model's next call; one short trial to its result, read from its file; its
// last screen kept; and nothing of agent-1's left.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const AGENT = "agent-1";
const AGENT_UID = 10301;
/** The controller's group, which the worker's folder lets in. */
const HARNESS_GID = 10010;
const TOKEN = "check-pi-view-token";
const TRIAL = "check-pi-view";
const SCRATCH = "/scratch/thermite";

/** The uid a process runs as. */
const uidOf = (pid) =>
  Number(/^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? -1);

/** Agent-1's processes still alive. */
const agentProcesses = () =>
  readdirSync("/proc")
    .filter((p) => /^\d+$/.test(p))
    .filter((p) => {
      try {
        return uidOf(Number(p)) === AGENT_UID;
      } catch {
        return false;
      }
    });

/**
 * A stand-in model: chat completions, each answered with a short text, streamed; the first call
 * waits until `release()`, or HOLD_MS, or until the worker closes it (an interrupt).
 */
async function heldModel() {
  const HOLD_MS = 30_000;
  const requests = [];
  let release = () => undefined;
  const held = new Promise((r) => {
    release = r;
  });
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => {
      raw += d;
    });
    req.on("end", async () => {
      if (req.method !== "POST" || !(req.url ?? "").endsWith("/chat/completions")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "only chat completions here" } }));
        return;
      }
      requests.push(raw);
      if (requests.length === 1)
        await Promise.race([held, new Promise((r) => setTimeout(r, HOLD_MS))]);
      if (res.destroyed) return;
      const chunk = (delta, finish) =>
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(chunk({ role: "assistant", content: "TERMINAL-CHECK-7 done." }, null));
      res.write(chunk({}, "stop"));
      res.write(
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, requests, release, close: () => server.close() };
}

/**
 * A stand-in for the harness's API: the routes a worker in Pi calls with its trial's token, and
 * its console's, through `view`, the harness's own PiConsole.
 */
async function trialRoutes(view) {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => {
      raw += d;
    });
    req.on("end", async () => {
      const answer = (status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer trial.${TOKEN}`)
        return answer(401, { error: "unauthorized" });
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return answer(400, { error: "not JSON" });
      }
      const path = (req.url ?? "").split("?")[0];
      if (path === "/v1/trial/console/next")
        return answer(200, { input: await view.next(body.wait_ms) });
      if (path === "/v1/trial/console/done") {
        view.done(body.id, body.outcome, body.why);
        return answer(200, { ok: true });
      }
      if (path === "/v1/trial/console/end") {
        await view.end();
        return answer(200, { ok: true });
      }
      if (path === "/v1/trial/messages") return answer(200, { messages: [] });
      if (path === "/v1/trial/prompt") return answer(201, { id: 1 });
      if (["/v1/trial/live", "/v1/trial/usage", "/v1/trial/messages/read"].includes(path))
        return answer(200, { ok: true });
      return answer(404, { error: `no route ${path} here` });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, close: () => server.close() };
}

/** What a role may do with the trials' folder, this trial's folder and its socket, in words. */
const PROBE = `
const fs = require("fs"), net = require("net"), path = require("path");
const dir = process.argv[1], r = {};
try { fs.readdirSync(path.dirname(dir)); r.list = "listed"; } catch (e) { r.list = e.code; }
try { fs.readdirSync(dir); r.enter = "entered"; } catch (e) { r.enter = e.code; }
const s = net.connect(path.join(dir, "terminal.sock"));
const done = () => process.stdout.write(JSON.stringify(r));
s.on("connect", () => { r.socket = "connected"; s.destroy(); done(); });
s.on("error", (e) => { r.socket = e.code; done(); });
`;

/** Runs the Pi view's scene; `c` is check.mjs's: its loader, runner, checks and lane helpers. */
export async function piViewTrial(c) {
  const { spawnTrial } = await c.load("harness/agents/spawn");
  const { PiConsole } = await c.load("harness/agents/pi-view/index");
  const model = await heldModel();
  const view = new PiConsole();
  const api = await trialRoutes(view);
  let term;
  const attach = view.attach.bind(view);
  view.attach = (t) => {
    term = t;
    attach(t);
  };
  try {
    const dir = join(SCRATCH, "agents", TRIAL);
    const running = spawnTrial(
      {
        kind: "code",
        spec: {
          trialId: TRIAL,
          token: TOKEN,
          run: "check-run",
          lane: c.LANE,
          workspace: join(SCRATCH, "lanes", c.LANE, "none"),
          parentCommit: "c".repeat(40),
          editablePaths: ["notes.txt"],
          brief: "TERMINAL-CHECK-7: reply.",
        },
      },
      c.runner,
      SCRATCH,
      api.port,
      undefined,
      {
        baseUrl: `http://127.0.0.1:${model.port}/v1`,
        model: "scripted",
        apiKey: "made-up",
        contextWindow: 32_000,
        maxTokens: 2_000,
      },
      view,
    );
    await c.until("the worker's first model call", () => model.requests.length >= 1, 90_000);
    await c.until("its terminal", () => term, 30_000);
    const status = await term.status();
    const agents = statSync(join(SCRATCH, "agents"));
    const own = statSync(dir);
    c.check(
      "a worker in Pi draws its Pi view in its own terminal as agent-1; the trials' folder may be passed through, not listed; its own folder is agent-1's, with the harness's group",
      uidOf(status.pid) === AGENT_UID &&
        (agents.mode & 0o777) === 0o711 &&
        own.uid === AGENT_UID &&
        own.gid === HARNESS_GID &&
        (own.mode & 0o777) === 0o750,
      {
        uid: uidOf(status.pid),
        agents: (agents.mode & 0o777).toString(8),
        own: [own.uid, own.gid, (own.mode & 0o777).toString(8)],
      },
    );
    const lane = await c.area("pi-probe");
    const probe = async (role, cwd) => {
      const r = await c.runner.run({
        role,
        argv: [process.execPath, "-e", PROBE, dir],
        cwd,
        timeoutMs: 20_000,
        captureBytes: 64 * 1024,
      });
      try {
        return JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "");
      } catch {
        return { said: `${r.stdout}${r.stderr}`.slice(-300) };
      }
    };
    const shut = { list: "EACCES", enter: "EACCES", socket: "EACCES" };
    const fromLane = await probe(c.LANE, lane.dir);
    const fromAgent = await probe("agent-2", SCRATCH);
    c.check(
      "neither lane-1 nor another lane's agent can list the trials' folder, enter the trial's folder or reach its terminal's socket",
      JSON.stringify(fromLane) === JSON.stringify(shut) &&
        JSON.stringify(fromAgent) === JSON.stringify(shut),
      { "lane-1": fromLane, "agent-2": fromAgent },
    );
    const shown = (await view.screen())?.data ?? "";
    // The owner's console, as terminal_input reaches it: each input one call in the trial's loop.
    const outcome = (i) =>
      view.ownerInput(i).then(
        () => "typed",
        (err) => `refused: ${err instanceof Error ? err.message : String(err)}`,
      );
    const said = {
      steer: await outcome({ text: "TERMINAL-CHECK-8: keep it short." }),
      status: await outcome({ text: "/status" }),
      model: await outcome({ text: "/model another" }),
      esc: await outcome({ keys: ["esc"] }),
    };
    // Esc stopped the held call; its hold ends anyway.
    model.release();
    const r = await running;
    await c.sleep(500);
    const after = (await view.screen())?.data ?? "";
    c.check(
      "its screen is Thermite's view of its Pi session, on Live's path",
      shown.includes("Thermite's view of a worker in Pi") && shown.includes("TERMINAL-CHECK-7"),
      { chars: shown.length },
    );
    c.check(
      "the owner's console: words steer it, /status shows its counts, a command the view has not is refused in words, Esc stops its reply",
      said.steer === "typed" &&
        said.status === "typed" &&
        /is not a command of the Pi view/.test(said.model) &&
        said.esc === "typed",
      said,
    );
    const next = model.requests.slice(1).join("\n");
    c.check(
      "the steered words reached the model at its next call, as the owner's message",
      next.includes("TERMINAL-CHECK-8") && next.includes("A message from the campaign's owner"),
      { calls: model.requests.length },
    );
    c.check(
      "one short trial to its result, read from the worker's file: it went on after Esc, and ended with no submission",
      r.stopped === "no_submission" && r.turns >= 2 && model.requests.length >= 3,
      { stopped: r.stopped, error: r.error, turns: r.turns, calls: model.requests.length },
    );
    let gone = false;
    try {
      statSync(dir);
    } catch {
      gone = true;
    }
    c.check(
      "its last screen is kept in memory, its folder removed, and nothing of agent-1's left",
      (view.lastScreen()?.data ?? "").includes("Thermite's view of a worker in Pi") &&
        after.length > 0 &&
        gone &&
        agentProcesses().length === 0,
      { kept: view.lastScreen()?.data.length ?? 0, gone, left: agentProcesses() },
    );
  } finally {
    model.release();
    await c.runner.killRole(AGENT).catch(() => 0);
    model.close();
    api.close();
  }
}
