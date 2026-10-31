import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelConfig } from "../../../agents/model/index.ts";
import type { Prompt } from "../../../agents/prompt.ts";
import { errorText } from "../../../common/errors.ts";
import { logWarn } from "../../../common/log.ts";
import type { PlannerAnswer } from "../../../core/api/harness/planner.ts";
import type { Runner } from "../../broker/index.ts";
import { callFolder, PLANNER_ROLE, type TerminalCallLink, TrialConsole } from "../cli/index.ts";
import { PiConsole } from "../pi-view/index.ts";
import { entryArgv, piEnv, runInView } from "../spawn.ts";
import { PlannerCallError } from "./causes.ts";
import type { PlannerCallSpec } from "./submit.ts";

/**
 * The planner in Pi in a process of its own, in its Pi view (goal 169; the owner's decision of
 * 2026-10-31), on a rig whose agents run in their own terminal. The terminal host runs the
 * process (planner-main.ts) as the planner's user, in a folder of its own, as a worker in Pi runs
 * in its view (spawn.ts). The process reaches the harness only with the call's credential: its
 * tools (the knowledge base's and the MCP gateway's), its compactions, its usage, its later turns,
 * its lines for Live, the owner's messages and its answer each go over the call's routes. The
 * harness's side of its view is a PiConsole under the call's id, for the owner's console and Live.
 */

/** What the planner's process reads from its folder (PLANNER_SPEC_FILE, its own, 0600). */
export interface PlannerViewSpec {
  /** Its credential, bound to the call (`call.<token>`). */
  auth: string;
  /** Which call it is, for submit_plan's description and parameters. */
  spec: PlannerCallSpec["id"];
  /** Its prompt, as the harness rendered and kept it. */
  sent: Prompt;
  /** The MCP servers the run's kit gives the planner, by name. */
  mcpServers: string[];
  /** The kinds it may write in the knowledge base; none: no knowledge base tools. */
  kbWrites?: string[] | undefined;
  /** The view's first line: what it is a view of. */
  heading: string;
}

/** The file in the planner's folder that holds its spec. */
export const PLANNER_SPEC_FILE = "call.json";

/** What a planner call in its Pi view takes from the harness. */
export interface PlannerViewCall {
  runner: Runner;
  scratchDir: string;
  port: number;
  /** Its route: the planner's own model, or the workers'. */
  model: ModelConfig;
  /** Its id, credential, console and the owner's messages: the one path's link (cli/call.ts). */
  link: TerminalCallLink;
  mcpServers: string[];
  kbWrites?: string[] | undefined;
  heading: string;
  /** The answer its process gave over its call's route, once it gave one. */
  answer(): PlannerAnswer | undefined;
}

/** One try of the planner in its Pi view: submit_plan's arguments, or why it gave none. */
export async function plannerInView(
  o: PlannerViewCall,
  sent: Prompt,
  spec: PlannerCallSpec,
  signal?: AbortSignal,
): Promise<unknown> {
  const { runner, link } = o;
  const dir = callFolder(o.scratchDir, "pi");
  const file: PlannerViewSpec = {
    auth: link.auth,
    spec: spec.id,
    sent,
    mcpServers: o.mcpServers,
    ...(o.kbWrites ? { kbWrites: o.kbWrites } : {}),
    heading: o.heading,
  };
  writeFileSync(join(dir, PLANNER_SPEC_FILE), JSON.stringify(file), { mode: 0o600 });
  // The harness's group enters the folder, for the host's socket; no other user may.
  await runner.handOver(dir, PLANNER_ROLE, { harnessReads: true });
  const view = new PiConsole();
  link.console(new TrialConsole(view), view);
  const abort = () => void runner.killRole(PLANNER_ROLE).catch(() => 0);
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    let ended: Awaited<ReturnType<typeof runInView>>;
    try {
      ended = await runInView(
        runner,
        {
          role: PLANNER_ROLE,
          dir,
          env: piEnv(o.model, o.port, link.auth),
          id: link.id,
          argv: [...entryArgv("planner-main"), PLANNER_SPEC_FILE],
        },
        view,
      );
    } catch (err) {
      view.ended();
      logWarn("harness", "the planner in Pi could not start in its terminal", {
        call: link.id,
        error: errorText(err),
      });
      throw new PlannerCallError(
        "provider_error",
        `the planner could not start in its terminal: ${errorText(err)}`,
      );
    }
    const a = o.answer();
    if (a && "plan" in a) return a.plan;
    if (a) throw new PlannerCallError(a.cause, a.detail);
    if (signal?.aborted) throw new PlannerCallError("cancelled", "the run stopped during the call");
    const how = ended.exit?.error ?? ended.outcome.killedFor ?? ended.exit?.code ?? "no exit code";
    logWarn("harness", "the planner in Pi left no answer in its terminal", {
      call: link.id,
      how: ended.exit?.how,
      code: ended.exit?.code ?? ended.outcome.exitCode,
      killedFor: ended.outcome.killedFor,
      error: ended.exit?.error,
    });
    throw new PlannerCallError(
      "provider_error",
      `the planner's process ended with no answer (${String(how).slice(0, 300)})`,
    );
  } finally {
    signal?.removeEventListener("abort", abort);
    link.console(undefined);
    await runner.killRole(PLANNER_ROLE).catch(() => 0);
    await runner.remove(dir).catch(() => undefined);
  }
}
