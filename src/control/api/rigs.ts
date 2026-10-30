import { createPublicKey } from "node:crypto";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { jsonBody } from "../../common/errors.ts";
import { ENROLL, RETIRE, RIG_TOKEN, RIGS } from "../../core/api/control/owner.ts";
import { newToken } from "../credential.ts";
import { bringBackRig } from "../rigs/index.ts";
import { fingerprint } from "../store/index.ts";
import { rigVersions } from "../versions.ts";
import { reportingState } from "../views/index.ts";
import type { ApiContext } from "./context.ts";

/**
 * The rigs, for the owner: every rig control knows with its state and versions; enrollment, where
 * control makes a rig's token; a new token; retiring a rig and bringing it back.
 */
export function rigRoutes(app: Hono, api: ApiContext): void {
  const { store, tokens, privateKeyPem, control, viewOpts, parts, admin } = api;
  const { runpodRigs } = parts;

  app.get(RIGS.path, admin, (c) =>
    c.json({
      control,
      rigs: store.reportedRigs.list().map((u) => ({
        ...u,
        state: reportingState(u.last_seen, viewOpts),
        version: rigVersions(store, u.id, control),
      })),
      enrolled: store.enrollments.rigs(),
      pull: store.tunnels.list(),
      runpod: runpodRigs.list(),
    }),
  );

  // Enrollment: control makes a rig's token, shows it once and keeps only its SHA-256, so a new
  // rig needs no change to control's deployment and no restart.
  const publicKeyPem = createPublicKey(privateKeyPem)
    .export({ type: "spki", format: "pem" })
    .toString();
  const inFile = (rig: string) =>
    tokens.rigs[rig] !== undefined
      ? `rig ${rig} has its token in control's rig tokens file; change it there`
      : undefined;
  app.post(ENROLL.path, admin, bodyLimit({ maxSize: ENROLL.maxBytes }), async (c) => {
    const { rig } = ENROLL.body.parse(await jsonBody(c.req));
    const taken =
      inFile(rig) ?? (store.enrollments.rig(rig) ? `rig ${rig} is already enrolled` : undefined);
    if (taken) return c.json({ error: taken }, 409);
    const t = newToken();
    store.enrollments.enroll(rig, t.sha256, "owner:api");
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
  app.post(RIG_TOKEN.path, admin, (c) => {
    const rig = c.req.param("rig");
    const fixed = inFile(rig);
    if (fixed) return c.json({ error: fixed }, 409);
    if (!store.enrollments.rig(rig)) return c.json({ error: `rig ${rig} is not enrolled` }, 404);
    const t = newToken();
    store.enrollments.rotateToken(rig, t.sha256, "owner:api");
    return c.json({ rig, token: t.token });
  });
  // Any rig: one control enrolled (its token ends), one in the rig tokens file (its token is
  // refused while retired; take it out of the file too), or one that only ever reported.
  app.post(RETIRE.path, admin, (c) => {
    const rig = c.req.param("rig");
    if (
      !store.reportedRigs.list({ withRetired: true }).some((u) => u.id === rig) &&
      !store.enrollments.knownRig(rig)
    )
      return c.json({ error: `no rig ${rig}` }, 404);
    store.retired.add(rig, "owner:api");
    return c.json({
      rig,
      retired: true,
      ...(inFile(rig)
        ? { note: "its token is in control's rig tokens file: remove it there too" }
        : {}),
    });
  });
  app.post("/v1/rigs/:rig/bring-back", admin, async (c) => {
    const rig = c.req.param("rig");
    return (await bringBackRig(store, rig, "owner:api"))
      ? c.json({ rig, retired: false })
      : c.json({ error: `rig ${rig} is not retired` }, 404);
  });
}
