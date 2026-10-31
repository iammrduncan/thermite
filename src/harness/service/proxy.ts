import { randomBytes } from "node:crypto";
import type { MessageInbox } from "../../agents/cli/index.ts";
import type { McpCaller } from "../../agents/mcp/index.ts";
import {
  logStall,
  type ModelConfig,
  type ProviderErrorAnswer,
  stallWords,
} from "../../agents/model/index.ts";
import type { PlannerAnswer } from "../../core/api/harness/planner.ts";
import type { LiveKind, LiveLog } from "../../core/live.ts";
import type { CallUsage } from "../../core/usage.ts";
import type { CompactionOf } from "../compactions.ts";

/**
 * What the model proxy and the MCP gateway take from the service besides trials' tokens: the
 * credentials the harness mints for a check, a plan or a planner's MCP calls, and what the model
 * proxy saw of a provider: its error answers, and calls broken off because their stream went
 * silent.
 */

/** The credentials the service mints for the model proxy and the MCP gateway (it holds one). */
export class ProxyCredentials {
  /**
   * Credentials the model proxy takes besides trials' tokens: one per check or planner call, with
   * the route it reaches when that is not the workers' (a planner's own model, goal 073).
   */
  private proxyTokens = new Map<string, { until: number; model?: ModelConfig | undefined }>();

  /**
   * A credential for the model proxy that lasts `ms` (a model check or a plan in OpenCode or
   * Codex). `model`: the route its calls reach; none, the workers' route at the time of each call.
   */
  mintProxyToken(model: ModelConfig | undefined, ms: number): string {
    const now = Date.now();
    for (const [t, v] of this.proxyTokens) if (v.until < now) this.proxyTokens.delete(t);
    const token = `proxy.${randomBytes(24).toString("hex")}`;
    this.proxyTokens.set(token, { until: now + ms, ...(model ? { model } : {}) });
    return token;
  }

  proxyTokenValid(token: string): boolean {
    const v = this.proxyTokens.get(token);
    return v !== undefined && v.until >= Date.now();
  }

  /** The route a minted credential reaches, when it was minted for one; else undefined. */
  proxyTokenModel(token: string): ModelConfig | undefined {
    const v = this.proxyTokens.get(token);
    return v && v.until >= Date.now() ? v.model : undefined;
  }

  /** Credentials the MCP gateway takes besides trials' tokens: the planner's, one per plan. */
  private mcpTokens = new Map<string, { caller: McpCaller; until: number }>();

  /** A credential for the MCP gateway, bound to one run and kind of agent, that lasts `ms`. */
  mintMcpToken(caller: McpCaller, ms: number): string {
    const now = Date.now();
    for (const [t, v] of this.mcpTokens) if (v.until < now) this.mcpTokens.delete(t);
    const token = `mcp.${randomBytes(24).toString("hex")}`;
    this.mcpTokens.set(token, { caller, until: now + ms });
    return token;
  }

  /** Who a gateway credential is for, while it lasts. */
  mcpTokenCaller(token: string): McpCaller | undefined {
    const v = this.mcpTokens.get(token);
    return v && v.until >= Date.now() ? v.caller : undefined;
  }

  /** The credentials of the calls that run in their own terminal now, until each ends. */
  private callTokens = new Map<string, CallCredential>();

  /**
   * A credential bound to one call of a role in its program's own terminal (goal 169): the model
   * proxy takes it for the call's route, the MCP gateway as the call's caller, and the turn routes
   * for the owner's messages inside its turn. It lasts until the call ends (endCall).
   */
  mintCallToken(c: CallCredential): string {
    const token = `call.${randomBytes(24).toString("hex")}`;
    this.callTokens.set(token, c);
    return token;
  }

  /** The call a credential is bound to, while the call runs. */
  callOf(token: string): CallCredential | undefined {
    return this.callTokens.get(token);
  }

  /** The call ended: its credential no longer works. */
  endCall(token: string): void {
    this.callTokens.delete(token);
  }
}

/**
 * A call of a role in its program's own terminal, as its credential binds it: its id (the console's
 * and the screens', such as plannerCallId's), who it is to the MCP gateway (its run, its kind of
 * agent), and the route its model calls reach, when it is not the workers'.
 */
export interface CallCredential {
  id: string;
  caller: McpCaller;
  model?: ModelConfig | undefined;
  /** What its own process hands over, when it runs apart from the harness (a planner in Pi). */
  own?: OwnCall | undefined;
}

/**
 * What a call's own process hands the harness over its credential (goal 169): a planner in Pi in
 * its Pi view, which runs apart from the harness as a worker in Pi does, and reaches the same
 * routes as a worker's trial (api/trials.ts), each bound to the call instead.
 */
export interface OwnCall {
  run: string;
  /** The call's name in the run's records: "epoch 3". */
  call: string;
  /** Its session's lines, for its live source. */
  live(entries: { kind: LiveKind; text: string }[]): void;
  /** The owner's messages for it, each read once its agent has it, before its next model call. */
  messages: MessageInbox;
  /** Each model call's usage, as its own code measured it (goal 075). */
  usage?: ((u: CallUsage) => void) | undefined;
  /** Where its compactions are kept and recorded (goal 070); none: it keeps none. */
  compaction?: CompactionOf | undefined;
  /** Its answer: the first one counts. */
  answer(a: PlannerAnswer): void;
}

/** The newest error answer the model proxy saw for each trial (or "proxy"): goal 079. */
export class ProviderAnswers {
  private readonly providerAnswers = new Map<string, ProviderErrorAnswer & { at: number }>();

  /** The model proxy saw a provider's error answer for a trial (or a check or a plan). */
  noteProviderAnswer(who: string, a: ProviderErrorAnswer, now: number): void {
    this.providerAnswers.delete(who);
    this.providerAnswers.set(who, { ...a, at: now });
    // The newest few hundred: a trial reads its own soon after its program stops.
    for (const k of this.providerAnswers.keys()) {
      if (this.providerAnswers.size <= 256) break;
      this.providerAnswers.delete(k);
    }
  }

  /** The newest error answer the proxy saw for a trial, if it came at or after `since` (ms). */
  providerAnswerSince(who: string, since: number): ProviderErrorAnswer | undefined {
    const a = this.providerAnswers.get(who);
    return a && a.at >= since ? { status: a.status, headers: a.headers, body: a.body } : undefined;
  }
}

/**
 * The model proxy broke a call off because its stream went silent (goal 079): the log says so,
 * and a trial's Live. The trial's program then sees a broken connection or a 504, and the
 * proxy's answer for it (noteProviderAnswer) makes it the provider's `server` error.
 */
export function noteModelStall(
  live: LiveLog,
  trial: { id: string; run: string; lane: string } | undefined,
  ms: number,
): void {
  logStall(ms, trial ? { trial: trial.id, run: trial.run, via: "model proxy" } : {});
  if (trial)
    live.append({
      source: `trial:${trial.id}`,
      kind: "status",
      text: `${stallWords(ms)}: retried. The harness broke the call off; the trial goes on in the same session.`,
      lane: trial.lane,
      run: trial.run,
    });
}
