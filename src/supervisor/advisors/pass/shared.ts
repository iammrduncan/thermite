import { ApiError } from "../../../common/api/call.ts";
import { harnessClient } from "../../../common/api/harness.ts";
import type { AdviseConfig } from "./state.ts";

/** A text with its spaces made one, cut to `n` characters (the last an ellipsis when cut). */
export const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The harness's API, with the supervisor's token. */
export const harnessOf = (cfg: Pick<AdviseConfig, "harnessUrl" | "harnessToken" | "fetchImpl">) =>
  harnessClient({ url: cfg.harnessUrl, token: cfg.harnessToken, fetchImpl: cfg.fetchImpl });

/** A route's answer, or undefined when a harness from before it answers 404. */
export async function ifKnown<T>(call: Promise<T>): Promise<T | undefined> {
  try {
    return await call;
  } catch (err) {
    if (err instanceof ApiError && err.code === "not_found") return undefined;
    throw err;
  }
}
