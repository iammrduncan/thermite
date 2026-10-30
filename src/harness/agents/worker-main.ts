import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { modelConfigFromEnv, UsageSender } from "../../agents/model/index.ts";
import { type Prompt, promptRecord } from "../../agents/prompt.ts";
import { KB_SERVER, type KbCall } from "../../agents/tools/index.ts";
import { type McpCallResult, resultText } from "../../common/mcp-client.ts";
import { KEEP_TRIAL_PROMPT } from "../../core/api/harness/prompts.ts";
import type { McpToolInfo } from "../../core/mcp.ts";
import type { Runner, RunOutcome, RunRequest } from "../broker/index.ts";
import { KEPT_MAX } from "../compactions.ts";
import { apiCall } from "./api-call.ts";
import type { ReplyNow, TrialProgress } from "./live-session.ts";
import { startView, VIEW_FLAG, VIEW_RESULT } from "./pi-view/index.ts";
import { runResearchTrial } from "./research/index.ts";
import type { AnyTrial } from "./spawn.ts";
import {
  type CompactionLink,
  type McpForAgent,
  type ProviderWait,
  runTrial,
  type TrialResult,
  type TrialSpec,
} from "./worker/index.ts";

/**
 * A worker trial in its own process (one per trial), run as its lane's agent user. It reaches
 * the harness only through the local API with its trial's own token (which binds every call to
 * the trial's run and lane, and stops working when the trial ends). Its file and shell
 * tools run in the lane's workspace, as the lane's user, through that API: the agent itself can
 * read none of it. Prints the trial result as the last line of stdout; with VIEW_FLAG, in its
 * terminal, it draws its Pi view there (goal 169) and leaves the result in VIEW_RESULT instead.
 */

/** Lane work through the harness API (the harness checks it against the trial). */
class ApiLaneRunner implements Pick<Runner, "run" | "killRole"> {
  readonly separated = true;
  private readonly call: (path: string, body: unknown) => Promise<unknown>;

  constructor(call: (path: string, body: unknown) => Promise<unknown>) {
    this.call = call;
  }

  async run(req: RunRequest): Promise<RunOutcome> {
    return (await this.call("/v1/lane/run", req)) as RunOutcome;
  }

  async killRole(): Promise<number> {
    return 0; // the harness kills the lane's processes when the trial ends
  }
}

async function main(): Promise<void> {
  const trial = JSON.parse(readFileSync(String(process.argv[2]), "utf8")) as AnyTrial;
  const model = modelConfigFromEnv();
  if (!model)
    throw new Error(
      "no model route configured (THERMITE_MODEL_BASE_URL, THERMITE_MODEL, THERMITE_MODEL_API_KEY)",
    );
  const api = process.env.THERMITE_HARNESS_URL ?? "http://127.0.0.1:8700";
  const token = `trial.${trial.spec.token ?? ""}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const { status, text } = await apiCall(
      `${api}${path}`,
      method,
      { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body !== undefined ? JSON.stringify(body) : undefined,
    );
    if (status < 200 || status >= 300)
      throw new Error(`${method} ${path} -> ${status}: ${text.slice(0, 500)}`);
    return JSON.parse(text);
  };
  // The live view: this session's turns to the live log, the owner's messages back in (each
  // confirmed once the agent has it).
  const link = {
    live: (entries: unknown[]) => call("POST", "/v1/trial/live", { entries }),
    messages: async () =>
      (
        (await call("GET", "/v1/trial/messages")) as {
          messages: { id: number; text: string }[];
        }
      ).messages,
    read: (ids: number[]) => call("POST", "/v1/trial/messages/read", { ids }),
    progress: (p: TrialProgress) => call("POST", "/v1/trial/live", { entries: [], progress: p }),
    reply: (r: ReplyNow | null) => call("POST", "/v1/trial/live", { entries: [], reply: r }),
  };
  // Each wait for the provider (goal 079): a line in the trial's session, and a rate limit's
  // wait for the scheduler and the research clock. Best effort: the trial waits either way.
  const waiting = (w: ProviderWait) => {
    view?.waiting(w);
    void call("POST", "/v1/trial/live", { entries: [], wait: w }).catch(() => undefined);
  };
  // Each later turn the trial sends its worker, kept by the harness as the trial's first prompt
  // is (goal 166); the trial's token decides the run, the lane and the trial. Best effort, as the
  // live view: the record is provenance, never a gate, and the trial goes on either way.
  const sent = (p: Prompt) => {
    const { role, program, turn, sections } = promptRecord(p, {});
    void call(KEEP_TRIAL_PROMPT.method, KEEP_TRIAL_PROMPT.path, {
      role,
      program,
      turn,
      sections,
    }).catch(() => undefined);
  };
  // Each model call's usage, handed to the harness as it is made (goal 075); the trial's token
  // decides the run, the trial and the route.
  const usage = new UsageSender((calls) => call("POST", "/v1/trial/usage", { calls }));
  // The MCP tools the run's kit gives its workers (goal 068), as the harness's gateway lists them
  // for this trial; `fresh`: asked of the servers now (the Pi view's /mcp reconnect).
  const listMcp = async (fresh?: true | string): Promise<McpForAgent> => {
    const query =
      fresh === undefined ? "" : `?fresh=${encodeURIComponent(fresh === true ? "all" : fresh)}`;
    const listed = (await call("GET", `/v1/mcp-tools${query}`)) as {
      tools: McpToolInfo[];
      unavailable?: { server: string; why: string }[];
    };
    return {
      tools: listed.tools,
      unavailable: listed.unavailable,
      call: async (server, tool, args) =>
        (await call("POST", "/v1/mcp-call", { server, tool, arguments: args })) as McpCallResult,
    };
  };
  // In its terminal, the worker draws its Pi view, whose console the owner types into.
  const view =
    process.argv[3] === VIEW_FLAG
      ? startView({
          heading: `Thermite's view of a worker in Pi · trial ${trial.spec.trialId} · ${trial.spec.lane} · ${model.model}`,
          call,
          servers: trial.spec.mcpServers ?? [],
          relist: listMcp,
        })
      : undefined;
  /** The trial's result: its last line of output, or, in its Pi view, its file (VIEW_RESULT). */
  const give = async (r: TrialResult): Promise<void> => {
    if (!view) {
      process.stdout.write(`\n${JSON.stringify(r)}\n`);
      return;
    }
    await view.finish(r);
    leaveResult(JSON.stringify(r));
    process.exit(0);
  };
  // A list that can't be read gives none: the trial goes on with its own tools.
  let mcp: McpForAgent | undefined;
  if (trial.spec.mcpServers?.length) {
    try {
      const listed = await listMcp();
      if (listed.tools.length) mcp = listed;
    } catch (err) {
      // Said in the live view; the trial goes on with its own tools.
      await link
        .live([
          {
            kind: "status",
            text: `the MCP tools could not be listed (${String(err).slice(0, 300)}): this trial goes on without them`,
          },
        ])
        .catch(() => undefined);
    }
  }
  // Thermite's knowledge base (goal 175): its tools through the gateway's own server, which runs
  // them for this trial's slot; a failure is said in words.
  const kb: KbCall | undefined = trial.spec.kbWrites
    ? async (tool, args) => {
        const r = (await call("POST", "/v1/mcp-call", {
          server: KB_SERVER,
          tool,
          arguments: args,
        })) as McpCallResult;
        return { text: resultText(r), isError: r.isError === true };
      }
    : undefined;
  // Compactions (goal 070): the harness keeps the conversation in the run's research folder and
  // records each compaction; the trial's token decides the run, the lane and the file's name.
  const compaction: CompactionLink = {
    keep: async (n, markdown) =>
      (await call("POST", "/v1/trial/snapshot", {
        number: n,
        markdown: markdown.slice(0, KEPT_MAX),
      })) as { path: string; rel: string },
    done: (r) =>
      call("POST", "/v1/trial/compacted", {
        number: r.number,
        tokens_before: r.tokensBefore,
        tokens_after: r.tokensAfter,
        how: r.how,
        kept: r.path !== undefined,
        ...(r.summary ? { summary: r.summary.slice(0, 32_000) } : {}),
        ...(r.error ? { error: r.error.slice(0, 2000) } : {}),
      }),
  };
  if (trial.kind === "research") {
    const result = await runResearchTrial(trial.spec, {
      mcp,
      kb,
      compaction,
      model,
      call: (op, args) => call("POST", `/v1/research/${op}`, args),
      link,
      idea: (req) => call("POST", "/v1/trial/idea", req),
      note: (req) => call("POST", "/v1/trial/note", req),
      modelUsage: usage.add,
      waiting,
      sent,
      view: view?.trial,
    });
    return give(await withUsage(result, usage));
  }
  const spec: TrialSpec = trial.spec;
  const runner = new ApiLaneRunner((path, body) => call("POST", path, body));
  const result = await runTrial(spec, {
    runner: runner as unknown as Runner,
    // The harness substitutes the lane tool's real argv.
    laneTool: ["lanetool"],
    model,
    submit: (req) =>
      call("POST", "/v1/attempts", {
        patch_base64: req.patch_base64,
        hypothesis: req.hypothesis,
        claim: req.claim,
        known_flaws: req.known_flaws,
      }),
    status: (id) => call("GET", `/v1/attempts/${id}`),
    devRun: (req) =>
      call("POST", "/v1/dev-runs", {
        command: req.command,
        timeout_s: req.timeoutS,
        cwd: spec.workspace,
      }),
    // An idea for the run's queue: the trial's token decides the run and the lane.
    idea: (req) => call("POST", "/v1/trial/idea", req),
    // A field note: the trial's token decides the run, the lane and who wrote it.
    note: (req) => call("POST", "/v1/trial/note", req),
    // Sources, claims and notes in the run's research folder (the trial decides the run).
    research: (op, args) => call("POST", `/v1/research/${op}`, args),
    link,
    mcp,
    kb,
    compaction,
    modelUsage: usage.add,
    waiting,
    sent,
    view: view?.trial,
  });
  return give(await withUsage(result, usage));
}

/**
 * The result of a worker in its Pi view, in its folder: readable by the harness, whose group may
 * enter the folder, which no other user may. Its mode is set apart from the write, which the
 * process's umask could narrow.
 */
function leaveResult(json: string): void {
  writeFileSync(VIEW_RESULT, json);
  chmodSync(VIEW_RESULT, 0o644);
}

/** The trial's result, once its usage is handed over, with the records the harness did not take. */
async function withUsage(result: TrialResult, usage: UsageSender): Promise<TrialResult> {
  const left = await usage.finish();
  return left ? { ...result, usageUnrecorded: left } : result;
}

main().catch((err) => {
  const failed = JSON.stringify({
    stopped: "error",
    turns: 0,
    toolCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    error: String(err),
  });
  if (process.argv[3] === VIEW_FLAG) leaveResult(failed);
  else process.stdout.write(`\n${failed}\n`);
  process.exit(0);
});
