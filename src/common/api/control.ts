import type { AnswerOf, Route } from "../../core/api/route.ts";
import { buildHeaders } from "../../core/version.ts";
import { buildInfo } from "../build-info.ts";
import { type ApiTarget, type CallInput, callRoute } from "./call.ts";

/**
 * The client of control's API (core/api/control/): a rig's supervisor calls its rig's own routes
 * with the rig's token, and the command line the owner's routes with the owner's. Every call
 * carries this build's version, so control can compare it with its own.
 */

/**
 * How long a call to control may take before it ends as a `timeout`: five minutes. In pull mode
 * a rig's call waits at the tunnel's port for control's next exchange (up to two minutes), and an
 * export's piece then crosses RunPod's proxy. A call that ends so is made again at the next round.
 */
export const CONTROL_CALL_TIMEOUT_MS = 5 * 60_000;

export interface ControlClient {
  call<R extends Route>(route: R, input?: CallInput<R>): Promise<AnswerOf<R>>;
}

export function controlClient(o: {
  url: string;
  token: string;
  /** A rig's client: its routes' `:rig`. */
  rig?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}): ControlClient {
  const target: ApiTarget = {
    whose: "control's",
    url: o.url.replace(/\/$/, ""),
    token: o.token,
    headers: buildHeaders(buildInfo()),
    params: o.rig !== undefined ? { rig: o.rig } : undefined,
    timeoutMs: o.timeoutMs ?? CONTROL_CALL_TIMEOUT_MS,
    fetchImpl: o.fetchImpl,
  };
  return { call: (route, input) => callRoute(target, route, input) };
}
