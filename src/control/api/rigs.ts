import { createPublicKey } from "node:crypto";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { jsonBody } from "../../common/errors.ts";
import { mapInTurn } from "../../common/in-turn.ts";
import { ENROLL, RETIRE, RIG_TOKEN, RIGS } from "../../core/api/control/owner.ts";
import { busReach } from "../bus/index.ts";
import { newToken } from "../credential.ts";
import { bringBackRig } from "../rigs/index.ts";
import { fingerprint } from "../store/index.ts";
import { rigVersions } from "../versions.ts";
import { podStopped, reportingState } from "../views/index.ts";
import type { ApiContext } from "./context.ts";

/**
 * The rigs, for the owner: every rig control knows with its state, versions and connection to the
 * message bus; enrollment, where control makes a rig's token; a new token; retiring a rig and
 * bringing it back.
 */
export function rigRoutes(app: Hono, api: ApiContext): void {
  const { store, privateKeyPem, control, viewOpts, parts, admin } = api;
  const { runpodRigs } = parts;

  app.get(RIGS.path, admin, async (c) => {
    const now = Date.now();
    return c.json({
      control,
      rigs: await mapInTurn(await store.reportedRigs.list(), async (u) => ({
        ...u,
        state: reportingState(u.last_seen, viewOpts),
        version: await rigVersions(store, u.id, control),
        // On the message bus or off it, as the rig's page shows it (goal 168).
        bus: await busReach(store, u.id, {
          lastSeen: u.last_seen,
          now,
          podStopped: podStopped({ runpod: await runpodRigs.view(u.id) }),
        }),
      })),
      enrolled: await store.enrollments.rigs(),
      retired: (await store.retired.list()).map((r) => r.rig),
      pull: await store.tunnels.list(),
      runpod: await runpodRigs.list(),
    });
  });

  // Enrollment: control makes a rig's token, shows it once and keeps only its SHA-256, so a new
  // rig needs no change to control's deployment and no restart.
  const publicKeyPem = createPublicKey(privateKeyPem)
    .export({ type: "spki", format: "pem" })
    .toString();
  app.post(ENROLL.path, admin, bodyLimit({ maxSize: ENROLL.maxBytes }), async (c) => {
    const { rig } = ENROLL.body.parse(await jsonBody(c.req));
    if (await store.enrollments.rig(rig))
      return c.json({ error: `rig ${rig} is already enrolled` }, 409);
    const t = newToken();
    await store.enrollments.enroll(rig, t.sha256, "owner:api");
    return c.json(
      {
        rig,
        token: t.token,
        control_public_key: publicKeyPem,
        control_fingerprint: fingerprint(publicKeyPem),
        bus: parts.rigBus ?? null,
      },
      201,
    );
  });
  app.post(RIG_TOKEN.path, admin, async (c) => {
    const rig = c.req.param("rig");
    if (!(await store.enrollments.rig(rig)))
      return c.json({ error: `rig ${rig} is not enrolled` }, 404);
    const t = newToken();
    await store.enrollments.rotateToken(rig, t.sha256, "owner:api");
    return c.json({ rig, token: t.token });
  });
  // Any rig: one control enrolled (its token ends), or one that only ever reported.
  app.post(RETIRE.path, admin, async (c) => {
    const rig = c.req.param("rig");
    if (
      !(await store.reportedRigs.list({ withRetired: true })).some((u) => u.id === rig) &&
      !(await store.enrollments.knownRig(rig))
    )
      return c.json({ error: `no rig ${rig}` }, 404);
    await store.retired.add(rig, "owner:api");
    return c.json({ rig, retired: true });
  });
  app.post("/v1/rigs/:rig/bring-back", admin, async (c) => {
    const rig = c.req.param("rig");
    return (await bringBackRig(store, rig, "owner:api"))
      ? c.json({ rig, retired: false })
      : c.json({ error: `rig ${rig} is not retired` }, 404);
  });
}
