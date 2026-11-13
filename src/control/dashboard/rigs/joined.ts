import type { Hono } from "hono";
import { errorText } from "../../../common/errors.ts";
import { ClientFailures, clientOf } from "../../api/index.ts";
import { inBackground } from "../../background.ts";
import {
  actOnClusterRig,
  type ClusterRigAction,
  cancelDrain,
  dropRunners,
  setClusterRigResources,
  setClusterRigUpAgain,
  updateRigImages,
} from "../../clusters/index.ts";
import { notSent } from "../../command-progress.ts";
import { newToken } from "../../credential.ts";
import { joinMachineScript, joinNamespaceManifest } from "../../join.ts";
import { manageScript, type RigAction, tail } from "../../machines/index.ts";
import { removeCheck } from "../../results-left.ts";
import { awaitFirstReport, STEP_WORDS } from "../../rigs/index.ts";
import { fingerprint } from "../../store/index.ts";
import { type Ctx, type Dashboard, wantsJson } from "../context.ts";
import { placeFollowUrl, rigHelpers } from "./shared.ts";

/** Failed join requests a client may make in a minute before it waits. */
const JOIN_FAILURES = 20;

/** What every answer of a join request carries: kept by nothing on the way, and never a page. */
const JOIN_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};

/**
 * Rigs you join yourself: their join command and the requests it makes (/v1/join). Then, for a
 * rig control set up on a cluster or a machine, the change it follows and its stop, start,
 * restart and remove.
 */
export function joinedRigRoutes(app: Hono, dash: Dashboard): void {
  const { noted, opts, parts, ssh, store } = dash;
  const { joinedPage, mintJoin, placeProgress } = rigHelpers(dash);

  // ---------------------------------------------------------------- rigs you join yourself
  /** A form's answer: JSON for the page's script, else the rig's page with the words. */
  const placeBack = async (c: Ctx, rig: string, k: "ok" | "error", msg: string) =>
    wantsJson(c)
      ? k === "ok"
        ? c.json({
            ...(await placeProgress(rig)),
            said: msg,
            tone: "ok",
            follow: placeFollowUrl(rig),
          })
        : c.json(notSent(msg), 400)
      : c.redirect(`/ui/rigs/${encodeURIComponent(rig)}?${k}=${encodeURIComponent(msg)}`, 303);
  /** placeBack for another program's words (ssh, kubectl): the page's address names them. */
  const placeFailed = async (c: Ctx, rig: string, why: string) =>
    placeBack(c, rig, "error", wantsJson(c) ? why : noted(why));
  app.post("/ui/rigs/:rig/join/:action", async (c) => {
    const r = await store.joinedRigs.get(c.req.param("rig"));
    const action = c.req.param("action");
    const back = (k: "ok" | "error", msg: string) =>
      c.redirect(
        `/ui/rigs/${encodeURIComponent(c.req.param("rig"))}?${k}=${encodeURIComponent(msg)}`,
        303,
      );
    if (!r || r.status === "retired")
      return back("error", "This is not a rig you run yourself, or it is retired.");
    const f = await c.req.parseBody();
    if (action === "new") return joinedPage(c, r, "", await mintJoin(r.rig));
    if (action === "revoke") {
      await store.joinedRigs.revokeToken(r.rig, "owner:ui");
      await store.rigHistory.add(r.rig, "join_revoked", true);
      return back("ok", "The join command no longer works.");
    }
    if (action === "retire") {
      if (String(f.confirm ?? "").trim() !== `retire ${r.rig}`)
        return back("error", `Type "retire ${r.rig}" to retire it.`);
      await store.joinedRigs.revokeToken(r.rig, "owner:ui");
      if (await store.enrollments.rig(r.rig)) await store.enrollments.retire(r.rig, "owner:ui");
      await store.joinedRigs.set(r.rig, { status: "retired" });
      await store.rigHistory.add(r.rig, "retired", true);
      return back(
        "ok",
        `${r.rig} is retired: its token no longer works. Remove its files there with the command on this page.`,
      );
    }
    return back("error", "No such action.");
  });
  // The join command's request: no session, only the one-time join token. Control mints the rig's
  // own token now, so the files it serves are the only copy of it. Every request that fails gets
  // the same answer, so it says nothing of which rigs wait to join; the token is used only when
  // the rest is right. A client that fails JOIN_FAILURES times in a minute waits.
  const failures = new ClientFailures();
  app.get("/v1/join/:rig/:what", async (c) => {
    const rig = c.req.param("rig");
    const what = c.req.param("what");
    const r = await store.joinedRigs.get(rig);
    const client = clientOf(c);
    const now = Date.now();
    if (failures.count(client, now) >= JOIN_FAILURES)
      return c.text("thermite: too many join requests failed; wait a minute\n", 429, JOIN_HEADERS);
    const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (
      !r ||
      what !== (r.form === "machine" ? "script" : "manifest") ||
      !parts.publicUrl ||
      !parts.rigBus ||
      !(await store.joinedRigs.useToken(rig, token))
    ) {
      if (failures.add(client, now) === JOIN_FAILURES)
        await store.auditLog.add("control", "join_throttled", {});
      return c.text(
        "thermite: this join command does not work: it was used, revoked or expired. Make a new one on the rig's page in Thermite.\n",
        401,
        JOIN_HEADERS,
      );
    }
    const rigToken = newToken();
    if (await store.enrollments.rig(rig))
      await store.enrollments.rotateToken(rig, rigToken.sha256, `rig:${rig}`);
    else await store.enrollments.enroll(rig, rigToken.sha256, "owner:ui");
    const secrets = { controlToken: rigToken.token, harnessSupervisorToken: newToken().token };
    const s = r.spec;
    let body: string;
    let detail: string;
    if (r.form === "machine") {
      const root = c.req.query("uid") === "0";
      body = joinMachineScript(
        {
          rig,
          controlUrl: parts.publicUrl,
          images: s.images,
          gpus: s.gpus as number[],
          judgeGpus: s.judgeGpus,
          root,
          controlPublicKey: parts.controlPublicKey,
          controlFingerprint: fingerprint(parts.controlPublicKey),
          bus: parts.rigBus,
        },
        secrets,
      );
      await store.joinedRigs.set(rig, { status: "joining", spec: { ...s, root } });
      detail = root ? "as root" : "as a user, with rootless Podman";
    } else {
      body = joinNamespaceManifest(
        {
          rig,
          namespace: s.namespace as string,
          controlUrl: parts.publicUrl,
          images: s.images,
          gpus: s.gpus as number,
          judgeGpus: s.judgeGpus,
          gpuMode: s.gpuMode ?? "device-plugin",
          deviceClass: s.deviceClass,
          storageClass: s.storageClass,
          storageGi: s.storageGi ?? 100,
          controlPublicKey: parts.controlPublicKey,
          bus: parts.rigBus,
          reach: await store.reachable.list(),
        },
        secrets,
      );
      await store.joinedRigs.set(rig, { status: "joining" });
      detail = `namespace ${s.namespace}`;
    }
    await store.rigHistory.add(rig, "join_used", true, detail);
    // Pulling the images can take a while on a new machine: wait up to an hour.
    const first = awaitFirstReport(
      parts,
      rig,
      async (st) => store.joinedRigs.set(rig, { status: st }),
      60,
    );
    void inBackground(store, "joined", rig, "first_report", first);
    return c.text(body, 200, JOIN_HEADERS);
  });

  app.get("/ui/rigs/:rig/place.json", async (c) => {
    const rig = c.req.param("rig");
    return (await store.clusters.rig(rig)) || (await store.machines.rig(rig))
      ? c.json(await placeProgress(rig))
      : c.json({ error: "not found" }, 404);
  });
  app.post("/ui/rigs/:rig/cluster/:action", async (c) => {
    const r = await store.clusters.rig(c.req.param("rig"));
    const action = c.req.param("action");
    const back = async (k: "ok" | "error", msg: string) => placeBack(c, c.req.param("rig"), k, msg);
    if (!r || r.status === "removed") return back("error", "Control didn't set this rig up.");
    if (action === "images" || action === "images-now") {
      const done = await updateRigImages(parts, r.rig, "owner:ui", {
        wait: action !== "images-now",
      });
      return "error" in done ? await placeFailed(c, r.rig, done.error) : await back("ok", done.ok);
    }
    if (action === "drain-cancel") {
      const done = await cancelDrain(parts, r.rig, "owner:ui");
      return "error" in done ? await back("error", done.error) : await back("ok", done.ok);
    }
    // A change to its GPUs, CPUs or memory that waits for its drain, made now (goal 118).
    if (action === "resources-now") {
      if (r.status !== "draining" || !r.pending)
        return back("error", `${r.rig} has no change to its GPUs, CPUs or memory waiting.`);
      const done = await setClusterRigResources(parts, r.rig, {}, "owner:ui", {
        wait: false,
        owner: true,
      });
      return "error" in done ? await back("error", done.error) : await back("ok", done.ok);
    }
    // A setup that failed before its first report, done again on another node (goal 206).
    if (action === "again") {
      const node = String((await c.req.parseBody()).node ?? "").trim();
      const done = await setClusterRigUpAgain(parts, r.rig, node || undefined, "owner:ui");
      return "error" in done ? await back("error", done.error) : await back("ok", done.ok);
    }
    if (!["stop", "start", "restart", "remove"].includes(action))
      return back("error", "No such action.");
    const f = await c.req.parseBody();
    const removing =
      action === "remove" ? await removeCheck(store, r.rig, String(f.confirm ?? "").trim()) : null;
    if (removing && "refused" in removing) return back("error", removing.refused);
    const done = await actOnClusterRig(parts, r, action as ClusterRigAction, "owner:ui", {
      ...removing,
    });
    return "error" in done ? await placeFailed(c, r.rig, done.error) : await back("ok", done.ok);
  });
  app.post("/ui/rigs/:rig/machine/:action", async (c) => {
    const r = await store.machines.rig(c.req.param("rig"));
    const action = c.req.param("action") as RigAction;
    const back = async (k: "ok" | "error", msg: string) => placeBack(c, c.req.param("rig"), k, msg);
    if (!r || r.status === "removed") return back("error", "Control didn't set this rig up.");
    if (!["stop", "start", "restart", "remove"].includes(action))
      return back("error", "No such action.");
    const f = await c.req.parseBody();
    const removing =
      action === "remove" ? await removeCheck(store, r.rig, String(f.confirm ?? "").trim()) : null;
    if (removing && "refused" in removing) return back("error", removing.refused);
    const m = await store.machines.get(r.machine);
    if (!m) return back("error", `The machine ${r.machine} is no longer in Settings › Machines.`);
    try {
      const out = await ssh.sshScript(
        {
          address: m.address,
          port: m.port,
          user: m.user,
          privateKey: opts.secrets.open(m.key_sealed),
          hostKeys: m.host_keys,
        },
        manageScript(r, action),
        [],
        5 * 60_000,
      );
      if (out.code !== 0) throw new Error(tail(out.stderr) || `exit ${out.code}`);
    } catch (err) {
      const why = errorText(err);
      await store.rigHistory.add(r.rig, action, false, why);
      return await placeFailed(c, r.rig, why);
    }
    await store.rigHistory.add(r.rig, action, true);
    await store.machines.setRigStatus(
      r.rig,
      action === "stop" ? "stopped" : action === "remove" ? "removed" : "running",
    );
    if (action === "remove") {
      await store.enrollments.retire(r.rig, "owner:ui");
      // Its runner processes on clusters go with it (goal 206).
      await dropRunners(parts, r.rig, "owner:ui");
    }
    await store.auditLog.add("owner:ui", `machine_rig_${action}`, {
      rig: r.rig,
      machine: r.machine,
      ...removing,
    });
    return back("ok", `${STEP_WORDS[action]}.`);
  });
}
