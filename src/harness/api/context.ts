import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { answerOf } from "../../common/errors.ts";
import { sameSecret } from "../../common/secrets.ts";
import type { Route } from "../../core/api/route.ts";
import { Registry } from "../agents/index.ts";
import type { Runner } from "../broker/index.ts";
import { LedgerError } from "../ledger/index.ts";
import type { Research } from "../research/index.ts";
import type { CallCredential, HarnessService, OwnCall } from "../service/index.ts";

/**
 * What the harness API's sections share: who may call (the bearer tokens and their scopes, and a
 * worker's own trial token), how an error becomes a status, and the context built once for them.
 */

export type Scope = "supervisor" | "proposer";

export interface ApiTokens {
  supervisor: string;
  /** Token for local proposers (scripted proposer in development, workers later). */
  proposer?: string | undefined;
}

export function allows(tokens: ApiTokens, scopes: Scope[], header: string | undefined): boolean {
  const h = header ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  return scopes.some((s) => {
    const expected = tokens[s];
    return expected !== undefined && expected.length > 0 && sameSecret(token, expected);
  });
}

function requireScope(tokens: ApiTokens, scopes: Scope[]): MiddlewareHandler {
  return async (c, next) => {
    if (!allows(tokens, scopes, c.req.header("authorization")))
      return c.json({ error: "unauthorized" }, 401);
    await next();
  };
}

export class Unauthorized extends Error {}

/** A LedgerError's status: what the ledger could not find, or would not do. */
const LEDGER_STATUS = { not_found: 404, conflict: 409, stale: 409, invalid: 400 } as const;

export function statusFor(err: unknown): 400 | 401 | 404 | 409 | 500 {
  if (err instanceof Unauthorized) return 401;
  if (err instanceof LedgerError) return LEDGER_STATUS[err.code];
  return answerOf(err).status;
}

export interface HarnessApiExtras {
  /**
   * Lane work for worker agents that run as their own users: the runner (the broker) and the
   * lane tool's argv. The agent names the tool as "lanetool"; the harness substitutes the argv.
   */
  lanes?: { runner: Runner; laneTool: string[] } | undefined;
  /** Agents' development runs on the device (judge first), bound to the calling trial. */
  devRuns?:
    | {
        run(
          input: unknown,
          trial: string,
          limits?: { rssMib: number; diskMib: number; timeoutS?: number; processes?: number },
        ): Promise<unknown>;
      }
    | undefined;
  /** Research mode: the harness's fetcher, corpus and claim ledger. */
  research?: Research | undefined;
}

/** A worker's own trial token: `Authorization: Bearer trial.<token>`. */
export function trialToken(header: string | undefined): string | undefined {
  const h = header ?? "";
  return h.startsWith("Bearer trial.") ? h.slice("Bearer trial.".length) : undefined;
}

/** A route's body limit (core/api/): the most bytes it takes. */
export const limitOf = (route: Route & { maxBytes: number }) =>
  bodyLimit({ maxSize: route.maxBytes });

/** What every section of the API takes, built once by createHarnessApi. */
export interface ApiContext {
  service: HarnessService;
  tokens: ApiTokens;
  extras: HarnessApiExtras;
  /** The supervisor's scope: what guards its routes. */
  supervisor: MiddlewareHandler;
  registry: Registry;
  /** The caller's open trial (its token binds the run and lane). */
  trialOf: (header: string | undefined) => {
    token: string;
    trial: ReturnType<Registry["openTrial"]>;
  };
  /**
   * Who calls a running agent's own routes: its trial (its token), or a call's own process (a
   * planner in Pi in its Pi view, goal 169), by the call's credential.
   */
  agentOf: (header: string | undefined) => AgentCaller;
  /** The id of the trial or the call (any call's credential) the caller is bound to. */
  agentId: (header: string | undefined) => string;
}

/** A running agent's own process, as its routes take it: a trial's, or a call's own. */
export type AgentCaller =
  | (ReturnType<ApiContext["trialOf"]> & { call?: undefined })
  | { call: CallCredential & { own: OwnCall }; trial?: undefined };

/** A call's credential in a bearer header: `Authorization: Bearer call.<token>`. */
const callToken = (header: string | undefined): string | undefined =>
  header?.startsWith("Bearer call.") ? header.slice("Bearer ".length) : undefined;

export function apiContext(
  service: HarnessService,
  tokens: ApiTokens,
  extras: HarnessApiExtras,
): ApiContext {
  const supervisor = requireScope(tokens, ["supervisor"]);
  const registry = new Registry(service.ledger);
  /** The caller's open trial (its token binds the run and lane). */
  const trialOf = (header: string | undefined) => {
    const token = trialToken(header);
    if (!token) throw new Unauthorized("unauthorized");
    try {
      return { token, trial: registry.openTrial(token) };
    } catch (err) {
      if (err instanceof LedgerError && err.code === "not_found")
        throw new Unauthorized("unauthorized");
      throw err;
    }
  };
  const agentOf = (header: string | undefined): AgentCaller => {
    const given = callToken(header);
    if (!given) return trialOf(header);
    const call = service.callOf(given);
    if (!call?.own) throw new Unauthorized("unauthorized");
    return { call: { ...call, own: call.own } };
  };
  const agentId = (header: string | undefined): string => {
    const given = callToken(header);
    if (!given) return trialOf(header).trial.id;
    const call = service.callOf(given);
    if (!call) throw new Unauthorized("unauthorized");
    return call.id;
  };
  return { service, tokens, extras, supervisor, registry, trialOf, agentOf, agentId };
}
