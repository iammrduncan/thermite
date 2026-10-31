import type { z } from "zod";
import type { ControlClient } from "../common/api/control.ts";
import { log } from "../common/env.ts";
import { errorText } from "../common/errors.ts";
import { REGISTER } from "../core/api/control/rigs.ts";
import type { AnswerOf } from "../core/api/route.ts";
import { userKeyFingerprint } from "../core/link/users.ts";

/**
 * The registration of the rig's keys on the message bus (goal 168): the supervisor's one call to
 * control over HTTPS at its start, with its figures and its keys' public parts. Control gives the
 * rig's key its user on the bus before it answers; the rig's reports, commands and config on the
 * bus need it. A key the supervisor made anew (its home was emptied) is registered the same way,
 * at its next start. Everything after it goes on the bus.
 */

/** How long the supervisor waits before it tries again after a registration that failed. */
export const REGISTER_AGAIN_MS = 30_000;

export interface Registration {
  control: Pick<ControlClient, "call">;
  /** The figures and the keys, as they are when the call is made. */
  body: () => z.input<typeof REGISTER.body>;
  stopping: () => boolean;
  /** Control's answer, which names its place in the rig's reports. */
  answered: (answer: AnswerOf<typeof REGISTER>) => void;
  /** How long to wait before a try again (tests make it short); REGISTER_AGAIN_MS unless given. */
  againMs?: number | undefined;
}

/** One try: true once control has the keys. A failure is logged, with control's words. */
async function registerOnce(r: Registration, tries: number): Promise<boolean> {
  const body = r.body();
  try {
    r.answered(await r.control.call(REGISTER, { body }));
    log("supervisor", "the rig's keys on the message bus are registered with control", {
      fingerprint: userKeyFingerprint(body.bus_key),
    });
    return true;
  } catch (err) {
    const again = r.againMs ?? REGISTER_AGAIN_MS;
    const what = { tries, again_in_s: again / 1000, error: errorText(err) };
    log("supervisor", "the rig's keys on the message bus are not registered yet", what, "error");
    return false;
  }
}

/**
 * Registers the rig's keys: returns after the first try, and, when it failed, tries again every
 * REGISTER_AGAIN_MS until control has them or the supervisor stops. Meanwhile the bus refuses the
 * rig's key, unless control has it from an earlier start, and the loops on the bus try again.
 */
export async function registerKeys(r: Registration): Promise<void> {
  if (await registerOnce(r, 1)) return;
  void (async () => {
    for (let tries = 2; !r.stopping(); tries++) {
      const until = Date.now() + (r.againMs ?? REGISTER_AGAIN_MS);
      while (!r.stopping() && Date.now() < until) await new Promise((x) => setTimeout(x, 250));
      if (r.stopping() || (await registerOnce(r, tries))) return;
    }
  })();
}
