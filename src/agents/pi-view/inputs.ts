import { errorText } from "../../common/errors.ts";
import type { PiViewCall, PiViewInput } from "../../core/api/harness/console.ts";
import { lastAssistant, steerTurn } from "../live-session.ts";
import type { McpForAgent } from "../mcp/index.ts";
import type { RoleView, ViewLevers } from "./levers.ts";
import type { PiView } from "./view.ts";

/**
 * The role's side of its Pi view's console (goal 169): it asks for the owner's next input over its
 * call's routes (a worker's trial's, a planner's or an advisor's call's), makes its one call in
 * the call's loop through its levers, draws what it did, and says what became of it. Every failure
 * here is said in words and stops nothing: the call goes on whatever its console does.
 */

/** How long one ask for the next input waits, and the pause after an ask that failed. */
const ASK_MS = 20_000;
const RETRY_MS = 2_000;

export interface ViewInputsDeps {
  view: PiView;
  /** The next input, or null after `waitMs`. */
  ask(waitMs: number): Promise<PiViewInput | null>;
  /** What became of an input. */
  answer(id: string, outcome: "typed" | "refused", why?: string): Promise<unknown>;
  /** The MCP servers the run's kit gives its workers, by name. */
  servers: readonly string[];
  /** The servers' tools listed again, from the servers: every server's, or one's. */
  relist(fresh: true | string): Promise<McpForAgent>;
}

type Outcome = { outcome: "typed" } | { outcome: "refused"; why: string };

const typed: Outcome = { outcome: "typed" };
const refused = (why: string): Outcome => ({ outcome: "refused", why });

/** A trial's MCP tools in words, server by server, with the servers that failed. */
export function mcpWords(mcp: McpForAgent | undefined, servers: readonly string[]): string {
  if (!servers.length) return "this run's kit gives its workers no MCP servers";
  const lines = servers.map((server) => {
    const tools = (mcp?.tools ?? []).filter((t) => t.server === server).map((t) => t.name);
    const why = mcp?.unavailable?.find((u) => u.server === server)?.why;
    if (tools.length) return `${server}: ${tools.length} tools: ${tools.join(", ")}`;
    return `${server}: no tools${why ? ` (${why})` : mcp ? "" : " (not listed)"}`;
  });
  return `the MCP tools of this trial:\n${lines.join("\n")}`;
}

export class ViewInputs implements RoleView {
  private readonly o: ViewInputsDeps;
  private levers: ViewLevers | undefined;
  private stopped = false;
  /** Tool calls under way: an interrupt waits for them to end. */
  private tools = 0;
  /** The owner interrupted while a tool ran: the reply stops when it ends. */
  private pending = false;
  /** The owner's interrupt stopped the agent's reply, until the trial's loop asks. */
  private stoppedByOwner = false;

  constructor(o: ViewInputsDeps) {
    this.o = o;
  }

  /** The trial's levers, once its agent is built: from now on the console takes inputs. */
  attach(levers: ViewLevers): void {
    this.levers = levers;
    const agent = levers.agent;
    this.o.view.attach(agent, levers.status);
    agent.subscribe((e) => {
      if (e.type === "tool_execution_start") this.tools++;
      if (e.type !== "tool_execution_end") return;
      this.tools = Math.max(0, this.tools - 1);
      // A submission ends the trial (or the planner's call): the owner's words that wait never
      // go in after it.
      const closed = levers.closed();
      if (closed && agent.hasQueuedMessages()) {
        agent.clearAllQueues();
        this.o.view.note(`the owner's words that waited do not go in: ${closed}`);
      }
      if (this.pending && this.tools === 0) {
        this.pending = false;
        this.stop(agent);
      }
    });
    void this.take();
  }

  interrupted(): boolean {
    const was = this.stoppedByOwner;
    this.stoppedByOwner = false;
    const agent = this.levers?.agent;
    return was && agent !== undefined && lastAssistant(agent)?.stopReason === "aborted";
  }

  /** No more inputs are taken. */
  close(): void {
    this.stopped = true;
  }

  private stop(agent: ViewLevers["agent"]): void {
    if (!agent.signal) return;
    this.stoppedByOwner = true;
    agent.abort();
  }

  /** Inputs, one at a time, until the console closes. */
  private async take(): Promise<void> {
    while (!this.stopped) {
      let input: PiViewInput | null;
      try {
        input = await this.o.ask(ASK_MS);
      } catch {
        await new Promise((r) => setTimeout(r, RETRY_MS));
        continue;
      }
      if (!input || this.stopped) continue;
      let r: Outcome;
      try {
        r = this.call(input.call);
      } catch (err) {
        r = refused(errorText(err));
      }
      if (r.outcome === "refused") this.o.view.note(`not done: ${r.why}`, "bad");
      await this.o
        .answer(input.id, r.outcome, r.outcome === "refused" ? r.why : undefined)
        .catch(() => undefined);
    }
  }

  /** One call in the trial's loop, made now. */
  private call(c: PiViewCall): Outcome {
    const levers = this.levers;
    if (!levers) return refused("the trial's agent has not started yet");
    const { agent } = levers;
    const view = this.o.view;
    switch (c.kind) {
      case "steer":
      case "follow_up": {
        const closed = levers.closed();
        if (closed) return refused(closed);
        const p = levers.ownerTurn(c.text);
        steerTurn(
          agent,
          p,
          () => levers.sent?.(p),
          c.kind === "follow_up" ? "follow-up" : "next-call",
        );
        view.owner(c.text, c.kind);
        return typed;
      }
      case "interrupt":
        if (!agent.signal)
          return refused(
            "the agent has no reply under way to stop: it waits for its provider, or between its turns",
          );
        if (this.tools > 0) {
          this.pending = true;
          view.note("interrupt: the agent's reply stops once the tool under way ends");
        } else {
          this.stop(agent);
          view.note("interrupt: the agent's reply stops");
        }
        return typed;
      case "compact":
        levers.compact();
        view.note("/compact: the conversation is compacted before the agent's next model call");
        return typed;
      case "mcp":
        view.note(mcpWords(levers.mcp(), this.o.servers));
        return typed;
      case "mcp_reconnect": {
        if (!this.o.servers.length)
          return refused("this run's kit gives its workers no MCP servers");
        if (c.server !== undefined && !this.o.servers.includes(c.server))
          return refused(`this run's kit gives its workers no MCP server named ${c.server}`);
        view.note(`/mcp reconnect: listing the tools of ${c.server ?? "every MCP server"} again`);
        void this.o.relist(c.server ?? true).then(
          (mcp) => {
            levers.setMcp(mcp);
            view.note(`${mcpWords(mcp, this.o.servers)}\n(the agent has these from its next turn)`);
          },
          (err) => view.note(`/mcp reconnect failed: ${errorText(err)}`, "bad"),
        );
        return typed;
      }
      case "status": {
        const s = levers.status();
        view.note(
          [
            `/status: model ${s.model}`,
            `turns ${s.turns}${s.maxTurns !== undefined ? ` of ${s.maxTurns}` : ""}, tool calls ${s.toolCalls}`,
            `tokens ${s.tokensIn.toLocaleString("en-US")} in, ${s.tokensOut.toLocaleString("en-US")} out`,
            `compactions ${s.compactions}`,
            s.msLeft !== undefined
              ? `time left ${Math.ceil(s.msLeft / 60_000)} min`
              : "no time limit",
          ].join("\n"),
        );
        return typed;
      }
    }
  }
}
