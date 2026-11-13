import type { Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { BadInput, jsonBody, Refusal } from "../../common/errors.ts";
import { REGISTER, RUNNER_REGISTER, SupervisorFigures } from "../../core/api/control/rigs.ts";
import { RIG_ID, RIG_NAME_RULE } from "../../core/ids.ts";
import { isSealKey, SEAL_KEY_WORDS } from "../../core/link/config.ts";
import { isUserKey, USER_KEY_WORDS, userKeyFingerprint } from "../../core/link/users.ts";
import {
  type BusUsers,
  busKeyHolder,
  type ConfigWriter,
  keyHeldWords,
  noteKeyRefused,
  noteOffBusCall,
  noteRegistered,
  takeRigBusKey,
  takeRigSealKey,
} from "../bus/index.ts";
import { reportPlace } from "../ingest.ts";
import { takeFigures } from "../rigs/index.ts";
import type { ControlStore } from "../store/index.ts";

/**
 * What the route needs from control: its store, and the bus's users and the rigs' config on it.
 */
export interface SupervisorRoutesDeps {
  store: ControlStore;
  busUsers?: BusUsers | undefined;
  busConfig?: ConfigWriter | undefined;
}

/** Why a call with no keys on the bus is refused, in words: the rig must be set up again. */
const NO_KEYS =
  "this rig has no keys on the message bus: control takes a rig's reports, commands and config only on the bus. Set the rig up again with this version: control's Update for a rig it set up, a new join command, or a new launch on RunPod";

/**
 * The registration of the rig's keys on the message bus, over HTTPS, with its figures: the
 * supervisor's one call at its start. A key that is not a NATS user key is refused, and a new or
 * changed one gets its user on the bus before the answer, so the supervisor can sign in once it
 * has it. Beside it comes the rig's seal key, which control seals the rig's config to: a new or
 * changed one has the rig's config written for it at once. A key that another rig or control holds
 * is refused, and noted in the rig's history. A call with no keys, from a rig that reports over
 * HTTP, is refused in words, and the rig shows broken (bus/reach.ts).
 */
export function supervisorRoutes(
  app: Hono,
  rigAuth: MiddlewareHandler,
  deps: SupervisorRoutesDeps,
): void {
  const { store } = deps;
  app.post(REGISTER.path, rigAuth, bodyLimit({ maxSize: REGISTER.maxBytes }), async (c) => {
    const rig = c.req.param("rig");
    const {
      bus_key: busKey,
      bus_seal_key: sealKey,
      ...figures
    } = SupervisorFigures.parse(await jsonBody(c.req));
    if (busKey === undefined || sealKey === undefined) {
      await noteOffBusCall(store, rig);
      throw new Refusal(NO_KEYS);
    }
    if (!isUserKey(busKey)) throw new BadInput(`bus_key is not ${USER_KEY_WORDS}`);
    if (!isSealKey(sealKey)) throw new BadInput(`bus_seal_key is not ${SEAL_KEY_WORDS}`);
    const own = deps.busUsers?.ownKeys() ?? [];
    // No table keeps a key to one holder: the look for another holder does. So the look and the
    // take are one transaction, and two rigs that register one key at once do not both hold it.
    const taken = await store.tx(async () => {
      for (const [field, key] of [
        ["bus_key", busKey],
        ["bus_seal_key", sealKey],
      ] as const) {
        const holder = await busKeyHolder(store, rig, key, own);
        if (holder) return { refused: { field, key, holder }, bus: undefined, seal: undefined };
      }
      await takeFigures(store, rig, figures);
      await noteRegistered(store, rig);
      const bus = await takeRigBusKey(store, rig, busKey);
      // The seal key with it when the bus's key is as it was: nothing then waits between the
      // look and its take. After a new bus key, it is taken once the bus has the key, below.
      const seal = bus === "same" ? await takeRigSealKey(store, rig, sealKey) : undefined;
      return { bus, seal, refused: undefined };
    });
    if (taken.refused) {
      // Noted outside the transaction, which a refusal's throw would drop.
      const { field, key, holder } = taken.refused;
      await noteKeyRefused(store, rig, field, key, holder);
      throw new Refusal(keyHeldWords(field));
    }
    if (taken.bus !== "same") await deps.busUsers?.sync();
    const seal = taken.seal ?? (await takeRigSealKey(store, rig, sealKey));
    if (seal !== "same") void deps.busConfig?.write();
    return c.json({ ok: true, reports: await reportPlace(store, rig) });
  });

  // A runner process of the rig (goal 206): its key gets the runner's user on the bus, which takes
  // only its core's asks on its own subject. A key another holds is refused, as a rig's is.
  app.post(
    RUNNER_REGISTER.path,
    rigAuth,
    bodyLimit({ maxSize: RUNNER_REGISTER.maxBytes }),
    async (c) => {
      const rig = c.req.param("rig");
      const runner = c.req.param("runner");
      if (!RIG_ID.test(runner)) throw new BadInput(`a runner's name is ${RIG_NAME_RULE}`);
      const { bus_key: key } = RUNNER_REGISTER.body.parse(await jsonBody(c.req));
      if (!isUserKey(key)) throw new BadInput(`bus_key is not ${USER_KEY_WORDS}`);
      const own = deps.busUsers?.ownKeys() ?? [];
      // The look for another holder and the take in one transaction, as for a rig's key.
      const taken = await store.tx(async () => {
        if ((await store.busKeys.runnerKey(rig, runner)) === key) return "same" as const;
        const holder = await busKeyHolder(store, rig, key, own);
        if (holder || (await store.busKeys.rigKey(rig)) === key)
          return { holder: holder ?? `rig ${rig}` };
        await store.busKeys.setRunnerKey(rig, runner, key);
        await store.rigHistory.add(
          rig,
          "runner_bus_key",
          true,
          `${runner}: ${userKeyFingerprint(key)}`,
        );
        return "taken" as const;
      });
      if (taken === "same") return c.json({ ok: true });
      if (taken !== "taken") {
        await noteKeyRefused(store, rig, "bus_key", key, taken.holder);
        throw new Refusal(keyHeldWords("bus_key"));
      }
      await deps.busUsers?.sync();
      return c.json({ ok: true });
    },
  );
}
