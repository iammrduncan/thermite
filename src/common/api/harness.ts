import type { AnswerOf, Route } from "../../core/api/route.ts";
import { type ApiTarget, type CallInput, callRoute } from "./call.ts";

/**
 * The client of a harness's API (core/api/harness/), for its rig's supervisor and the command
 * line: each call with the token it was made with.
 */

/**
 * How long a call to the harness may take before it ends as a `timeout`: five minutes, longer
 * than the slowest route (a command that brings a large import). A command still being applied
 * then answers `in_progress` to the next call, so nothing is applied twice.
 */
export const HARNESS_CALL_TIMEOUT_MS = 5 * 60_000;

export interface HarnessClient {
  call<R extends Route>(route: R, input?: CallInput<R>): Promise<AnswerOf<R>>;
}

export function harnessClient(o: {
  url: string;
  token: string;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}): HarnessClient {
  const target: ApiTarget = {
    whose: "the harness's",
    url: o.url.replace(/\/$/, ""),
    token: o.token,
    timeoutMs: o.timeoutMs ?? HARNESS_CALL_TIMEOUT_MS,
    fetchImpl: o.fetchImpl,
  };
  return { call: (route, input) => callRoute(target, route, input) };
}
