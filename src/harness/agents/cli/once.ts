import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CliCompactions, type OnceKeeping, reclaim } from "../../../agents/compaction/index.ts";
import type { McpAccess } from "../../../agents/mcp/index.ts";
import type { ModelConfig } from "../../../agents/model/index.ts";
import type { PlanWindows } from "../../../agents/programs/index.ts";
import { messageText } from "../../../agents/prompt.ts";
import { renderModelCheck } from "../../../agents/roles/index.ts";
import type { CallUsage } from "../../../core/usage.ts";
import type { Role, Runner } from "../../broker/index.ts";
import type { RigCheckReport } from "../model/index.ts";
import { CHECK_ROLE, PLANNER_ROLE, takeUsage } from "./common.ts";
import { setUp } from "./loop.ts";
import type { CliCall, CliProgram, CliTally } from "./program.ts";

/**
 * One prompt through a program outside a trial (goal 125, T7): a planner call or a model check,
 * as an unprivileged user of its own, in a fresh folder that is removed afterwards. Each
 * program's entry (cli/program.ts) gives what differs: its setup, environment and command line.
 */

/** What a one-prompt call takes from the harness. */
export interface CliOnceDeps {
  runner: Runner;
  apiUrl: string;
  scratchDir: string;
  /**
   * A credential for the harness's model proxy; `model`: the route it reaches (else the workers').
   * A program that reaches its model through the proxy needs it (OpenCode, Codex).
   */
  mintProxyToken?(model?: ModelConfig): string;
}

export interface CliOnceOptions {
  /** The call's own user: the planner's or the model check's, never a lane's. */
  role: Role;
  /** None unless given: a planner call runs until it answers or its run stops (goal 079). */
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  /** The MCP servers the call may use, and the gateway's credential for them (a planner's). */
  mcp?: Omit<McpAccess, "apiUrl"> | undefined;
  /** Where its conversation is kept before each compaction, and who records it (goal 070). */
  compaction?: OnceKeeping | undefined;
  /** The tools it may use, in a program that takes a list (Claude Code's; "": none). */
  tools?: string | undefined;
}

/** One prompt through `p` as `o.role`; returns what the program's output said. */
export async function cliOnce<T extends CliTally>(
  p: CliProgram<T>,
  model: ModelConfig,
  prompt: string,
  deps: CliOnceDeps,
  o: CliOnceOptions,
): Promise<T> {
  // The program finds its home by name, so the folder must be reachable by name: under the lanes'
  // area, not the controller's own (which only its processes may walk).
  const parent = join(deps.scratchDir, "lanes", `${p.prefix}-ask`);
  mkdirSync(parent, { recursive: true, mode: 0o711 });
  chmodSync(parent, 0o711);
  const dir = join(parent, randomUUID());
  mkdirSync(dir, { mode: 0o700 });
  const keeping = o.compaction;
  const call: CliCall = {
    model,
    dir,
    home: join(dir, "home"),
    tmp: join(dir, "tmp"),
    apiUrl: deps.apiUrl,
    proxyAuth: () => {
      if (!deps.mintProxyToken) throw new Error(`${p.name} needs a credential for the model proxy`);
      return deps.mintProxyToken(model);
    },
    mcp: o.mcp?.servers.length || o.mcp?.kb ? { apiUrl: deps.apiUrl, ...o.mcp } : undefined,
    keptAt: keeping?.keptAt,
    timeoutMs: o.timeoutMs,
    tools: o.tools,
  };
  p.call.prepare?.(call, prompt);
  await deps.runner.handOver(dir, o.role);
  const tally = p.newTally();
  const kill = () => void deps.runner.killRole(o.role).catch(() => 0);
  o.signal?.addEventListener("abort", kill, { once: true });
  try {
    const setupError = await setUp(p.name, p.call.setup(call), deps.runner, {
      role: o.role,
      cwd: dir,
    });
    if (setupError) {
      tally.errors.push(setupError);
      return tally;
    }
    // A call stopped before its run starts nothing, and answers with nothing.
    if (o.signal?.aborted) return tally;
    const argv = [p.exe() ?? p.bin(), ...p.call.args(call)];
    const r = await deps.runner.run({
      role: o.role,
      argv: p.shell ? p.shell(argv) : argv,
      cwd: dir,
      env: p.call.env(call),
      // The prompt on stdin, as a trial's; Claude Code's is its token, its prompt in its file.
      stdin: p.stdin ? p.stdin(prompt, call) : prompt,
      ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
      captureBytes: 8 * 1024 * 1024,
    });
    const live = p.read(r.stdout.split("\n"), tally);
    // A run cut off before its result keeps the usage its output showed (goal 075).
    p.closeRun?.(tally);
    // Each compaction it reported, kept and recorded once the call is over (goal 070): the
    // controller takes the call's folder back to read the program's own copies there. Those its
    // output reported are known before; those its own files record, only after.
    if (keeping) {
      const kept = p.call.kept;
      const reported = kept ? [] : p.found(tally, { area: dir, count: 0, at: live.length });
      if (kept || reported.length) {
        await reclaim(deps.runner, dir);
        new CliCompactions({
          title: keeping.title,
          harness: p.name,
          on: keeping.compacted,
          own: p.call.own(call, keeping.title, tally),
        }).take(live, kept ? kept(call, live.length) : reported);
      }
    }
    if (r.killedFor === "timeout")
      tally.errors.push(`no answer in ${Math.round((o.timeoutMs ?? 0) / 1000)} s`);
    else if (r.exitCode !== 0 && !tally.errors.length)
      tally.errors.push(
        p.exitWords(
          r.exitCode ?? r.signal,
          tally.notes.at(-1) ?? r.stderr.slice(-300),
          `${tally.notes.join("\n")}\n${r.stderr}`,
        ),
      );
  } finally {
    o.signal?.removeEventListener("abort", kill);
    await deps.runner.remove(dir).catch(() => undefined);
  }
  return tally;
}

/** A planner call through a program: what it may read, use and keep, and where its usage goes. */
export interface CliAskOptions {
  signal?: AbortSignal | undefined;
  /** A folder it may read and search (the run's past research), read only. */
  read?: string | undefined;
  mcp?: Omit<McpAccess, "apiUrl"> | undefined;
  compaction?: OnceKeeping | undefined;
  /** Each model usage its output reports (goal 075). */
  usage?: ((u: CallUsage) => void) | undefined;
  /** Its subscription's usage windows, when it reports them (Claude Code). */
  windows?: ((w: PlanWindows) => void) | undefined;
}

/**
 * The planner's call through a program, as the planner's own user: its answer. With past
 * research, the prompt names the run's knowledge/ folder, which every agent user may read and none
 * may change; a program that takes a list of tools gets the read-only file tools for it.
 */
export async function cliAsk<T extends CliTally>(
  p: CliProgram<T>,
  model: ModelConfig,
  prompt: string,
  deps: CliOnceDeps,
  o: CliAskOptions = {},
): Promise<string> {
  const t = await cliOnce(p, model, prompt, deps, {
    role: PLANNER_ROLE,
    signal: o.signal,
    tools: p.plannerTools?.(Boolean(o.read)),
    // The MCP servers the run's kit gives the planner, at the gateway (goal 068).
    mcp: o.mcp,
    // Its conversation before each of the program's own compactions (goal 070).
    compaction: o.compaction,
  });
  takeUsage(t, o.usage);
  const windows = p.windows?.(t);
  if (windows) o.windows?.(windows);
  const answer = p.answer?.(t) ?? t.lastText;
  if (!answer) throw new Error(t.errors.at(-1) ?? `${p.name} gave no answer`);
  return answer;
}

/**
 * The model check in a program: the model must run one shell command through the program's own
 * tool, and the command's output must come back, as a trial's tool calls would.
 */
export async function cliModelCheck<T extends CliTally>(
  p: CliProgram<T>,
  model: ModelConfig,
  deps: CliOnceDeps,
  timeoutMs = 120_000,
): Promise<RigCheckReport> {
  const word = `thermite-${Math.random().toString(36).slice(2, 8)}`;
  const started = Date.now();
  const tool = p.check.tool;
  const t = await cliOnce(
    p,
    model,
    messageText(renderModelCheck({ program: p.id, word, tool })),
    deps,
    { role: CHECK_ROLE, timeoutMs, tools: tool },
  );
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const called = t.tools.some((x) => x.ok && x.output.includes(word));
  const detail = {
    harness: p.id,
    model: model.model,
    ...(p.check.baseUrl ? { base_url: p.check.baseUrl(model) } : {}),
    seconds,
    tool_called: called,
    tokens_in: t.tokensIn,
    tokens_out: t.tokensOut,
    ...(p.windows ? { usage: p.windows(t) ?? null } : {}),
    error: t.errors.at(-1) ?? null,
    text: t.lastText.slice(0, 300) || null,
  };
  if (called)
    return {
      ok: true,
      summary: `${model.model} answered with a correct tool call in ${seconds} s (${p.name})`,
      detail,
    };
  const why =
    p.check.why?.(t) ??
    (t.errors.length
      ? t.errors.at(-1)
      : t.toolCalls
        ? "its tool call did not print the word"
        : `no tool call${t.lastText ? `; it wrote: ${t.lastText.slice(0, 200)}` : ""}`);
  return {
    ok: false,
    summary: `${model.model} failed the tool-call check in ${p.name}: ${why}`,
    detail,
  };
}
