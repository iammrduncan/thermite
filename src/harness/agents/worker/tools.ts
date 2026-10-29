import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type TSchema, Type } from "@earendil-works/pi-ai";
import { mcpAgentTools } from "../../../agents/mcp/index.ts";
import {
  CODE_RESEARCH_TOOLS,
  kbAgentTools,
  NOTE_TOOL,
  type NoteLimit,
} from "../../../agents/tools/index.ts";
import { errorText } from "../../../common/errors.ts";
import { type LaneLimitValues, SHARED_DEV_RUN_S } from "../../../core/contract.ts";
import { IDEA_TOOL, proposeIdea, researchAgentTools } from "../tools/index.ts";
import type { TrialClock } from "../trial-clock.ts";
import type { McpForAgent, TrialDeps, TrialResult, TrialSpec } from "./spec.ts";

/**
 * A worker trial's tools in Pi (runTrial, worker.ts): each acts as the lane's user through the
 * broker, in the lane's workspace, and counts in the trial's result. A submission ends the trial:
 * no tool runs after it.
 */

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }], details: {} };
}

/**
 * The trial's tools: the workspace's files, its commands and dev runs, an attempt's status, the
 * lane's ideas and notes, the run's research folder, the kit's MCP servers, and submit. Each call
 * counts in `result`, and submit records the submission there.
 */
export function trialTools(
  spec: TrialSpec,
  deps: TrialDeps,
  result: TrialResult,
  o: { limits: LaneLimitValues; clock: TrialClock; notes: NoteLimit },
): AgentTool[] {
  const { limits, clock, notes } = o;
  const lane = (op: string, args: unknown, stdin?: string) =>
    deps.runner.run({
      role: spec.lane,
      argv: [...deps.laneTool, op, JSON.stringify(args)],
      cwd: spec.workspace,
      timeoutMs: 30_000,
      ...(stdin !== undefined ? { stdin } : {}),
      captureBytes: 4 * 1024 * 1024,
    });
  const laneResult = async (op: string, args: unknown, stdin?: string) => {
    const r = await lane(op, args, stdin);
    try {
      const parsed = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}") as {
        ok: boolean;
        error?: string;
      };
      if (!parsed.ok) throw new Error(parsed.error ?? "failed");
      return parsed as Record<string, unknown>;
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : `tool failed: ${r.stderr.slice(-300)}`);
    }
  };
  const tool = <P extends TSchema>(
    name: string,
    description: string,
    parameters: P,
    run: (p: Record<string, unknown>) => Promise<ReturnType<typeof text> & { terminate?: boolean }>,
  ): AgentTool<P> => ({
    name,
    label: name,
    description,
    parameters,
    execute: async (_id, params) => {
      result.toolCalls++;
      // A submission ends the trial: nothing runs after it, even later calls of the same turn.
      if (result.submitted)
        return { ...text("the trial ended with your submission"), terminate: true };
      return run(params as Record<string, unknown>);
    },
  });

  return [
    tool(
      "list_files",
      "List files under a directory of the repository (default: the root).",
      Type.Object({ path: Type.Optional(Type.String()), depth: Type.Optional(Type.Number()) }),
      async (p) => text(((await laneResult("list", p)).entries as string[]).join("\n")),
    ),
    tool(
      "read_file",
      "Read a text file, with line numbers. Use offset and limit for long files.",
      Type.Object({
        path: Type.String(),
        offset: Type.Optional(Type.Number()),
        limit: Type.Optional(Type.Number()),
      }),
      async (p) => {
        const r = await laneResult("read", p);
        return text(`${r.content}\n(${r.total_lines} lines)`);
      },
    ),
    tool(
      "write_file",
      "Create or replace a file with the given content.",
      Type.Object({ path: Type.String(), content: Type.String() }),
      async (p) => {
        await laneResult("write", { path: p.path }, String(p.content));
        return text(`wrote ${p.path}`);
      },
    ),
    tool(
      "edit_file",
      "Replace an exact piece of text in a file. old_text must occur exactly once unless replace_all is true.",
      Type.Object({
        path: Type.String(),
        old_text: Type.String(),
        new_text: Type.String(),
        replace_all: Type.Optional(Type.Boolean()),
      }),
      async (p) => {
        const r = await laneResult(
          "edit",
          { path: p.path },
          JSON.stringify({ old: p.old_text, new: p.new_text, all: p.replace_all === true }),
        );
        return text(`replaced ${r.replaced} occurrence(s) in ${p.path}`);
      },
    ),
    tool(
      "search",
      "Search the repository for a regular expression; returns file:line matches.",
      Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()) }),
      async (p) =>
        text(((await laneResult("search", p)).matches as string[]).join("\n") || "no matches"),
    ),
    tool(
      "run",
      `Run a shell command in the repository (build, test, inspect). Output is truncated to its end. Timings from here never count. ${
        limits.runTimeoutS !== undefined
          ? `A command is stopped after ${limits.runTimeoutS} s (the campaign's limit), or sooner with timeout_s.`
          : "A command runs until it finishes; set timeout_s to stop it sooner."
      } What it starts in the background keeps running until your trial ends: send its output to a file (cmd > log 2>&1 &) and read the file. Memory: ${limits.runRssMib} MiB for everything your lane runs at once. Disk: ${limits.workspaceMib} MiB for the workspace.`,
      Type.Object({ command: Type.String(), timeout_s: Type.Optional(Type.Number()) }),
      async (p) => {
        const time = clock.commandTime(p.timeout_s, limits.runTimeoutS);
        const r = await deps.runner.run({
          role: spec.lane,
          argv: ["sh", "-c", String(p.command)],
          cwd: spec.workspace,
          ...(time.timeoutMs !== undefined ? { timeoutMs: time.timeoutMs } : {}),
          rssLimitBytes: limits.runRssMib * 1024 * 1024,
          disk: {
            path: spec.workspaceRoot ?? spec.workspace,
            limitBytes: limits.workspaceMib * 1024 * 1024,
          },
          captureBytes: 32 * 1024,
        });
        const earlier = r.backgroundKilled
          ? `\n(your background processes were killed earlier: ${r.backgroundKilled} limit)`
          : "";
        return text(
          `exit ${r.exitCode ?? r.signal}${r.killedFor ? ` (killed: ${r.killedFor})` : ""}${earlier}${clock.stoppedWords(r.killedFor, time)}\n--- stdout\n${r.stdout.slice(-6_000)}\n--- stderr\n${r.stderr.slice(-3_000)}\n(output trimmed to its end: pipe through grep, head or tail to see other parts)`,
        );
      },
    ),
    tool(
      "dev_run",
      `Run a command on the measurement device (for example a GPU) when the judge is not using it. Use it to check that your change works on the real target. Results are diagnostic only. ${
        limits.devRunTimeoutS !== undefined
          ? `A dev run is stopped after ${limits.devRunTimeoutS} s (the campaign's limit), or sooner with timeout_s.`
          : `A dev run ends when its command does, or at timeout_s; where the judge shares the device, it is stopped after ${SHARED_DEV_RUN_S} s at most.`
      } Nothing it starts on the device outlives it.`,
      Type.Object({ command: Type.String(), timeout_s: Type.Optional(Type.Number()) }),
      async (p) => {
        if (!deps.devRun) return text("dev_run is not available for this campaign; use run.");
        const time = clock.commandTime(p.timeout_s); // the campaign's own limit is the harness's
        const r = await deps.devRun({
          lane: spec.lane,
          command: String(p.command),
          ...(time.timeoutMs !== undefined ? { timeoutS: Math.ceil(time.timeoutMs / 1000) } : {}),
        });
        const killed = (r as { killed?: unknown } | null)?.killed;
        return text(`${JSON.stringify(r).slice(0, 16_000)}${clock.stoppedWords(killed, time)}`);
      },
    ),
    tool(
      "status",
      "Show the lifecycle and verdict of an attempt of this campaign: yours, another lane's or an earlier run's. A change refused before building lists why under violations.",
      Type.Object({ attempt: Type.String() }),
      async (p) => text(JSON.stringify(await deps.status(String(p.attempt)))),
    ),
    ...(deps.idea
      ? [
          tool(IDEA_TOOL.name, IDEA_TOOL.description, IDEA_TOOL.parameters, (p) =>
            proposeIdea(deps.idea as NonNullable<TrialDeps["idea"]>, p),
          ),
        ]
      : []),
    ...(deps.note
      ? [
          tool(NOTE_TOOL.name, NOTE_TOOL.description, NOTE_TOOL.parameters, (p) =>
            notes.write(deps.note as NonNullable<TrialDeps["note"]>, p),
          ),
        ]
      : []),
    // Sources, claims and notes in the run's research folder, as a research trial records them.
    ...(deps.research
      ? researchAgentTools(
          CODE_RESEARCH_TOOLS,
          async (op, args) => {
            // A submission ends the trial: nothing runs after it.
            if (result.submitted) return "the trial ended with your submission";
            try {
              return await (deps.research as NonNullable<TrialDeps["research"]>)(op, args);
            } catch (err) {
              return `refused: ${errorText(err)}`;
            }
          },
          { run: spec.run, lane: spec.lane },
          () => {
            result.toolCalls++;
          },
        )
      : []),
    // Thermite's knowledge base (goal 175): kb_search, kb_read, and kb_write when it may write.
    ...(deps.kb && spec.kbWrites
      ? kbAgentTools(
          async (t, args) =>
            // A submission ends the trial: nothing runs after it.
            result.submitted
              ? { text: "the trial ended with your submission", isError: true }
              : (deps.kb as NonNullable<TrialDeps["kb"]>)(t, args),
          spec.kbWrites,
          () => {
            result.toolCalls++;
          },
        )
      : []),
    // The MCP tools the run's kit gives its workers, through the harness's gateway (goal 068).
    ...(deps.mcp
      ? mcpAgentTools(
          deps.mcp.tools,
          async (server, t, args) =>
            // A submission ends the trial: nothing runs after it.
            result.submitted
              ? {
                  content: [{ type: "text", text: "the trial ended with your submission" }],
                  isError: true,
                }
              : (deps.mcp as McpForAgent).call(server, t, args),
          () => {
            result.toolCalls++;
          },
        )
      : []),
    tool(
      "submit",
      "Submit your change for judging. Call it once, when your change builds and passes your own tests. This ends the trial.",
      Type.Object({
        hypothesis: Type.String({
          description: "What you changed and why it should help, in one or two sentences.",
        }),
        claim: Type.Optional(Type.String({ description: "What you expect the judge to find." })),
        known_flaws: Type.Optional(
          Type.Array(Type.String(), {
            description: "Anything wrong or limited about this change.",
          }),
        ),
      }),
      async (p) => {
        if (result.submitted)
          return { ...text("already submitted in this trial"), terminate: true };
        // Only the editable paths are staged, so build outputs and scratch files never enter a patch.
        const pathspecs = spec.editablePaths
          .map((p) => `':(glob)${p.replace(/'/g, "")}'`)
          .join(" ");
        const diff = await deps.runner.run({
          role: spec.lane,
          argv: ["sh", "-c", `git add -A -- ${pathspecs} && git diff --cached --binary`],
          cwd: spec.workspace,
          timeoutMs: 60_000,
          captureBytes: 32 * 1024 * 1024,
        });
        if (diff.exitCode !== 0)
          return text(`could not prepare the patch: ${diff.stderr.slice(-500)}`);
        if (!diff.stdout.trim()) {
          return text(
            `there are no changes inside the editable paths (${spec.editablePaths.join(", ")})`,
          );
        }
        const out = await deps.submit({
          run: spec.run,
          lane: spec.lane,
          parent: spec.parentCommit,
          patch_base64: Buffer.from(diff.stdout).toString("base64"),
          hypothesis: String(p.hypothesis).slice(0, 2000),
          claim: p.claim === undefined ? undefined : String(p.claim).slice(0, 2000),
          known_flaws: ((p.known_flaws as string[] | undefined) ?? []).map((f) =>
            String(f).slice(0, 1000),
          ),
        });
        result.submitted = out;
        result.stopped = "submitted";
        return {
          ...text(
            `submitted ${out.attempt}: ${out.lifecycle}${out.violations?.length ? `; refused: ${out.violations.join("; ")}` : ""}`,
          ),
          terminate: true,
        };
      },
    ),
  ];
}
