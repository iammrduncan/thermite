import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ApiError } from "../common/api/call.ts";
import type { ControlClient } from "../common/api/control.ts";
import { ENROLL, RIG_TOKEN, RIGS } from "../core/api/control/owner.ts";

/**
 * The local compose stack's enroll step (`thermite local enroll`), run by its `enroll` service at
 * each `up`, once control answers and before the rig's supervisor starts: the rig is enrolled with
 * control, as Add a rig enrolls one, and its token goes into the file its supervisor reads. Control
 * keeps only the token's hash. A token written before is kept while control still has the rig
 * enrolled; a control that lost its state (removed with its volume) enrolls the rig again.
 */

/** How long the step waits for control to answer at the stack's start: as long as control's start. */
export const ENROLL_WAIT_MS = 5 * 60_000;

/** How often the step asks control again while control starts. */
const ASK_EVERY_MS = 2_000;

/** What the step did: the token kept, a first one, a new one for a lost file, or nothing. */
export type EnrollOutcome = "kept" | "enrolled" | "replaced" | "retired";

/**
 * Enrolls `rig` with control, unless control has it enrolled and `tokenFile` holds a token, and
 * writes the token into `tokenFile` in place (the file the supervisor's container mounts). A rig
 * the owner retired is left as it is. `say` gets each line for the step's output.
 */
export async function localEnroll(o: {
  control: ControlClient;
  rig: string;
  tokenFile: string;
  say: (line: string) => void;
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<EnrollOutcome> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (o.waitMs ?? ENROLL_WAIT_MS);
  let listed: Awaited<ReturnType<typeof listRigs>>;
  for (;;) {
    try {
      listed = await listRigs(o.control);
      break;
    } catch (err) {
      // No answer yet, or control still starting (503): asked again until the deadline.
      const starting = err instanceof ApiError && (err.status === undefined || err.status === 503);
      if (!starting || Date.now() >= deadline) throw err;
      await sleep(ASK_EVERY_MS);
    }
  }
  if ((listed.retired ?? []).includes(o.rig)) {
    o.say(
      `${o.rig} is retired in control: it is not enrolled again. Bring it back on its page to use it.`,
    );
    return "retired";
  }
  // Enrolled with a token in force; a token that ended (a rig retired, then brought back) is not.
  const enrolled = (listed.enrolled ?? []).some((r) => r.rig === o.rig && !r.retired_at);
  const held = existsSync(o.tokenFile) ? readFileSync(o.tokenFile, "utf8").trim() : "";
  if (enrolled && held) {
    o.say(`${o.rig} is enrolled with control: its token is kept`);
    return "kept";
  }
  const token = enrolled
    ? (await o.control.call(RIG_TOKEN, { params: { rig: o.rig }, body: {} })).token
    : (await o.control.call(ENROLL, { body: { rig: o.rig } })).token;
  // In place, so a container that mounts the file sees the token.
  writeFileSync(o.tokenFile, `${token}\n`, { mode: 0o644 });
  o.say(
    enrolled
      ? `${o.rig} is enrolled with control and its token file was empty: control made it a new token`
      : `${o.rig} enrolled with control`,
  );
  return enrolled ? "replaced" : "enrolled";
}

const listRigs = (control: ControlClient) => control.call(RIGS);
