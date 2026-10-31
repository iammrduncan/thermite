import { ApiError } from "../../common/api/call.ts";
import { harnessClient } from "../../common/api/harness.ts";
import { log } from "../../common/env.ts";
import { ADVISORS, SETTINGS } from "../../core/api/harness/supervisor.ts";

/** The advisors' switches in the rig's settings (Edit rig). */
export interface AdvisorSwitches {
  teachers: boolean;
  auditor: boolean;
  review: boolean;
}

/** Which advisors decide, as the harness is told. */
export interface AdvisorsTold {
  auditor: boolean;
  review_panel: number;
  writer: boolean;
}

/**
 * The supervisor's two calls to its harness about the advisors: the rig's settings, and which
 * advisors decide. A refusal, or a harness out of reach, is logged with its status at the first
 * failure and not again until the call goes through (goal 164), as the relays to control do.
 */
export function harnessAdvisors(harnessUrl: string, harnessToken: string, say: typeof log = log) {
  const harness = harnessClient({ url: harnessUrl, token: harnessToken });
  const streak = (msg: string) => {
    let failing = false;
    return async <T>(call: () => Promise<T>): Promise<T | undefined> => {
      let fields: Record<string, unknown>;
      try {
        const r = await call();
        failing = false;
        return r;
      } catch (err) {
        fields =
          err instanceof ApiError && err.status !== undefined
            ? { status: err.status, answer: err.text.slice(0, 300) }
            : { error: String(err) };
      }
      if (!failing) say("supervisor", msg, fields);
      failing = true;
      return undefined;
    };
  };

  /** The last settings the harness gave; all advisors on until it gives some (an older harness). */
  let last: AdvisorSwitches = { teachers: true, auditor: true, review: true };
  const settingsCall = streak("the harness did not give the rig's settings: the last ones stand");
  const settings = async (): Promise<AdvisorSwitches> => {
    const r = await settingsCall(() => harness.call(SETTINGS));
    if (r) last = { ...last, ...r };
    return last;
  };

  /**
   * Tells the harness which advisors decide (goal 079): without an auditor, the audits it holds
   * go on by each run's rules instead of waiting; without a final writer (goal 112: the first of
   * the teachers on, which writes research papers), an answered research run closes without a
   * paper. An older harness does not know the call. Said again every minute between rounds: a
   * harness that restarted forgets it.
   */
  let told: AdvisorsTold | undefined;
  let toldAt = 0;
  const tellCall = streak("the harness did not take which advisors decide");
  const tell = async (a = told): Promise<void> => {
    if (!a) return;
    told = a;
    toldAt = Date.now();
    await tellCall(() => harness.call(ADVISORS, { body: a }));
  };
  const retell = () => (Date.now() - toldAt >= 60_000 ? tell() : undefined);

  return { settings, last: () => last, tell, retell };
}
