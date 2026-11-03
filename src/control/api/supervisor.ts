import type { Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { BadInput, jsonBody, Refusal } from "../../common/errors.ts";
import { REGISTER, SupervisorFigures } from "../../core/api/control/rigs.ts";
import { isSealKey, SEAL_KEY_WORDS } from "../../core/link/config.ts";
import { isUserKey, USER_KEY_WORDS } from "../../core/link/users.ts";
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
      noteOffBusCall(store, rig);
      throw new Refusal(NO_KEYS);
    }
    if (!isUserKey(busKey)) throw new BadInput(`bus_key is not ${USER_KEY_WORDS}`);
    if (!isSealKey(sealKey)) throw new BadInput(`bus_seal_key is not ${SEAL_KEY_WORDS}`);
    const own = deps.busUsers?.ownKeys() ?? [];
    for (const [field, key] of [
      ["bus_key", busKey],
      ["bus_seal_key", sealKey],
    ] as const) {
      const holder = busKeyHolder(store, rig, key, own);
      if (!holder) continue;
      noteKeyRefused(store, rig, field, key, holder);
      throw new Refusal(keyHeldWords(field));
    }
    takeFigures(store, rig, figures);
    noteRegistered(store, rig);
    if (takeRigBusKey(store, rig, busKey) !== "same") await deps.busUsers?.sync();
    if (takeRigSealKey(store, rig, sealKey) !== "same") void deps.busConfig?.write();
    return c.json({ ok: true, reports: reportPlace(store, rig) });
  });
}
