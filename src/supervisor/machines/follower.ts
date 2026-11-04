import { mkdirSync } from "node:fs";
import { controlClient } from "../../common/api/control.ts";
import { harnessClient } from "../../common/api/harness.ts";
import { BUS_URL_SETTING, busTrust, busUrl, natsBus } from "../../common/bus/index.ts";
import { log, optionalSecretFromFile, requireEnv, secretFromFile } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import { Loops } from "../../common/health.ts";
import { MACHINE_REGISTER } from "../../core/api/control/rigs.ts";
import { RIG_ID, RIG_ID_WORDS } from "../../core/ids.ts";
import { userKeyFingerprint } from "../../core/link/users.ts";
import { SUPERVISOR_INBOX_DIR } from "../../core/paths.ts";
import { serveHealth } from "../health.ts";
import { busKey } from "../relay/index.ts";
import { controlTokenFrom } from "../settings.ts";
import { waitForHarness } from "../startup.ts";
import { answerLeaderAsks } from "./answer.ts";

/**
 * The supervisor of a follower of a rig over several machines (goal 205, THERMITE_ROLE=follower):
 * it registers its own key on the bus with control, with the rig's token, and answers its leader's
 * asks of its harness's judge GPUs on its own subject. Nothing else: the rig's leader reports,
 * takes commands and carries the live view.
 */

/** How long it waits between tries of a registration that failed, in milliseconds. */
const REGISTER_AGAIN_MS = 30_000;

export async function startFollowerSupervisor(env: NodeJS.ProcessEnv): Promise<void> {
  const home = env.THERMITE_SUPERVISOR_HOME ?? "/var/lib/thermite-supervisor";
  mkdirSync(home, { recursive: true });
  const rig = requireEnv("THERMITE_RIG_ID");
  const machine = requireEnv("THERMITE_MACHINE");
  if (!RIG_ID.test(machine))
    throw new Error(`THERMITE_MACHINE: a machine's name is ${RIG_ID_WORDS}`);
  const harnessUrl = requireEnv("HARNESS_URL").replace(/\/$/, "");
  const harnessToken = secretFromFile("THERMITE_HARNESS_TOKEN_FILE");
  serveHealth(env, rig, new Loops(), harnessToken);
  const controlUrl = env.CONTROL_URL?.replace(/\/$/, "");
  const controlToken = controlTokenFrom(env, controlUrl);
  if (!controlUrl || !controlToken)
    throw new Error(
      "CONTROL_URL or THERMITE_CONTROL_TOKEN_FILE is not set: a follower registers its key on the message bus with control, at its address, with the rig's token",
    );
  const natsUrl = busUrl(env);
  if (!natsUrl)
    throw new Error(`${BUS_URL_SETTING} is not set: a follower reaches its leader only on the bus`);
  const key = busKey(home);
  const control = controlClient({ url: controlUrl, token: controlToken, rig });
  // Its key first: the bus refuses it until control has it.
  for (let tries = 1; ; tries++) {
    try {
      await control.call(MACHINE_REGISTER, {
        params: { machine },
        body: { bus_key: key.publicKey },
      });
      log("supervisor", "the follower's key on the message bus is registered with control", {
        machine,
        fingerprint: userKeyFingerprint(key.publicKey),
      });
      break;
    } catch (err) {
      const what = { machine, tries, again_in_s: REGISTER_AGAIN_MS / 1000, error: errorText(err) };
      log(
        "supervisor",
        "the follower's key on the message bus is not registered yet",
        what,
        "error",
      );
      await new Promise((r) => setTimeout(r, REGISTER_AGAIN_MS));
    }
  }
  const bus = natsBus(natsUrl, `supervisor ${rig} ${machine}`, {
    seed: key.seed,
    trust: busTrust(env),
  });
  await waitForHarness(harnessUrl, () => false);
  await answerLeaderAsks({
    rig,
    machine,
    bus,
    harness: harnessClient({ url: harnessUrl, token: harnessToken }),
    scratchDir: home,
    inboxDir: env.THERMITE_INBOX_DIR ?? SUPERVISOR_INBOX_DIR,
    hfToken: optionalSecretFromFile("THERMITE_HF_TOKEN_FILE"),
  });
  log("supervisor", "the follower answers its leader's asks on the message bus", { rig, machine });
}
