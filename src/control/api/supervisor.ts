import type { Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { BadInput, jsonBody, Refusal } from "../../common/errors.ts";
import { FIGURES } from "../../core/api/control/rigs.ts";
import { isSealKey, SEAL_KEY_WORDS } from "../../core/link/config.ts";
import { isUserKey, USER_KEY_WORDS } from "../../core/link/users.ts";
import {
  type BusUsers,
  busKeyHolder,
  type ConfigWriter,
  keyHeldWords,
  noteKeyRefused,
  takeRigBusKey,
  takeRigSealKey,
} from "../bus/index.ts";
import { reportPlace } from "../ingest.ts";
import { modelSteps } from "../model-steps.ts";
import type { ControlStore } from "../store/index.ts";

/**
 * What the route needs from control: its store, and the bus's users and the rigs' config on it
 * when control runs the bus.
 */
export interface SupervisorRoutesDeps {
  store: ControlStore;
  busUsers?: BusUsers | undefined;
  busConfig?: ConfigWriter | undefined;
}

/**
 * The supervisor's own figures, its regular call (unsigned: the supervisor reports itself). A
 * model download that starts or ends is a step in the rig's history.
 * With the bus, the figures carry the rig's key: a key that is not a NATS user key is refused, and
 * a new or changed one gets its user on the bus before the answer, so the supervisor can sign in
 * once it has it. Beside it comes the rig's seal key, which control seals the rig's config to: a
 * new or changed one has the rig's config written for it at once. A key that another rig or control
 * holds is refused, with the figures, and noted in the rig's history. The keys are kept apart from
 * the figures, which pages show.
 */
export function supervisorRoutes(
  app: Hono,
  rigAuth: MiddlewareHandler,
  deps: SupervisorRoutesDeps,
): void {
  const { store } = deps;
  app.post(FIGURES.path, rigAuth, bodyLimit({ maxSize: FIGURES.maxBytes }), async (c) => {
    const rig = c.req.param("rig");
    const {
      bus_key: busKey,
      bus_seal_key: sealKey,
      ...stats
    } = FIGURES.body.parse(await jsonBody(c.req));
    if (busKey !== undefined && !isUserKey(busKey))
      throw new BadInput(`bus_key is not ${USER_KEY_WORDS}`);
    if (sealKey !== undefined && !isSealKey(sealKey))
      throw new BadInput(`bus_seal_key is not ${SEAL_KEY_WORDS}`);
    if (sealKey !== undefined && busKey === undefined)
      throw new BadInput("bus_seal_key comes only with bus_key, the rig's key on the bus");
    const own = deps.busUsers?.ownKeys() ?? [];
    for (const [field, key] of [
      ["bus_key", busKey],
      ["bus_seal_key", sealKey],
    ] as const) {
      const holder = key === undefined ? undefined : busKeyHolder(store, rig, key, own);
      if (key === undefined || !holder) continue;
      noteKeyRefused(store, rig, field, key, holder);
      throw new Refusal(keyHeldWords(field));
    }
    const before = store.reportedRigs.supervisor(rig)?.models;
    store.reportedRigs.setSupervisor(rig, stats);
    for (const s of modelSteps(before, stats.models))
      store.rigHistory.add(rig, s.step, s.ok, s.detail);
    if (busKey && takeRigBusKey(store, rig, busKey) !== "same") await deps.busUsers?.sync();
    if (sealKey && takeRigSealKey(store, rig, sealKey) !== "same") void deps.busConfig?.write();
    return c.json({ ok: true, reports: reportPlace(store, rig) });
  });
}
