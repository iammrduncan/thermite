import { ApiError } from "../common/api/call.ts";
import { harnessClient } from "../common/api/harness.ts";
import { log } from "../common/env.ts";
import { HEALTH } from "../core/api/harness/supervisor.ts";

/** How long one look at the harness may take before it counts as no answer. */
const HEALTH_TIMEOUT_MS = 5000;

/**
 * At start the harness may still be coming up. The supervisor waits for it once, saying so once,
 * so its relays do not each log a failure in their first second. Later failures log as before.
 */
export async function waitForHarness(
  harnessUrl: string,
  stopped: () => boolean,
  opts: { pollMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const harness = harnessClient({
    url: harnessUrl,
    token: "",
    fetchImpl: opts.fetchImpl,
    timeoutMs: HEALTH_TIMEOUT_MS,
  });
  let said = false;
  while (!stopped()) {
    try {
      await harness.call(HEALTH);
      if (said) log("supervisor", "the harness answers");
      return true;
    } catch (err) {
      // Up, with a loop late (503): the supervisor starts, so that its reports say so.
      if (err instanceof ApiError && err.status !== undefined) {
        if (said) log("supervisor", "the harness answers", { status: err.status });
        return true;
      }
      // not up yet
    }
    if (!said) {
      log("supervisor", "waiting for the harness", { url: harnessUrl });
      said = true;
    }
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 1000));
  }
  return false;
}
