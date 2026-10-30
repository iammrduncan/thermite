import type { Hono } from "hono";
import { errorText } from "../../../common/errors.ts";
import { BUS_KEY_CHANGE_STEPS, BUS_KEYS_SEEN_STEP } from "../../bus/index.ts";
import { updateRigImages } from "../../clusters/index.ts";
import { notSent } from "../../command-progress.ts";
import { tail, updateScript } from "../../machines/index.ts";
import { checkRigPlace, controlImages } from "../../rigs/index.ts";
import { rigHref } from "../../ui/urls.ts";
import { backTo, type Dashboard, wantsJson } from "../context.ts";
import { rigHelpers, updateFollowUrl } from "./shared.ts";

/**
 * A rig's state (goal 012): its update to control's version, and a check of where it runs; the
 * owner's acceptance of a rig's new report key; and the owner's Seen of a change of its keys on the
 * message bus, which took effect without the owner.
 */
export function rigStateRoutes(app: Hono, dash: Dashboard): void {
  const { control, noted, opts, parts, ssh, store, updates } = dash;
  const { placeOf, updateProgress } = rigHelpers(dash);

  app.post("/ui/rigs/:rig/key/accept", async (c) => {
    const f = await c.req.parseBody();
    // Only the key whose fingerprint the owner saw: a key swapped in meanwhile is not accepted.
    store.reportedRigs.acceptPendingKey(
      c.req.param("rig"),
      "owner:ui",
      String(f.fingerprint ?? ""),
    );
    return c.redirect(rigHref(c.req.param("rig")), 303);
  });
  // The owner saw the changes of a rig's keys on the bus: their card leaves Needs you, and they
  // stay in the rig's history.
  app.post("/ui/rigs/:rig/bus-keys/seen", async (c) => {
    const rig = c.req.param("rig");
    const f = await c.req.parseBody();
    if (store.rigHistory.latest(rig, BUS_KEY_CHANGE_STEPS, 1).length) {
      store.rigHistory.add(rig, BUS_KEYS_SEEN_STEP, true);
      store.auditLog.add("owner:ui", "rig_bus_keys_seen", { rig });
    }
    return c.redirect(backTo(f, rigHref(rig)), 303);
  });

  // ---------------------------------------------------------------- a rig's state (goal 012)
  /** Moves a rig control set up on a machine onto control's images, over SSH; what changed. */
  const updateMachineRig = async (rig: string): Promise<string> => {
    const r = store.machines.rig(rig);
    if (!r || r.status === "removed") throw new Error(`Control didn't set ${rig} up on a machine.`);
    const m = store.machines.get(r.machine);
    if (!m) throw new Error(`The machine ${r.machine} is no longer in Settings › Providers.`);
    const images = controlImages(parts, r.gpus.length);
    if (typeof images === "string") throw new Error(images);
    if (!parts.publicUrl)
      throw new Error("Control's address for rigs is not set (THERMITE_CONTROL_PUBLIC_URL).");
    store.machines.setRigStatus(rig, "updating");
    const out = await ssh.sshScript(
      {
        address: m.address,
        port: m.port,
        user: m.user,
        privateKey: opts.secrets.open(m.key_sealed),
        hostKeys: m.host_keys,
      },
      updateScript({
        rig,
        controlUrl: parts.publicUrl,
        images,
        gpus: r.gpus,
        judgeGpus: r.judge_gpus,
        root: r.root,
        bus: parts.rigBus,
      }),
      [],
      30 * 60_000,
    );
    if (out.code !== 0) {
      store.machines.setRigStatus(rig, "failed");
      throw new Error(tail(out.stderr) || `the update exited ${out.code}`);
    }
    store.machines.setRigImages(rig, images);
    store.machines.setRigStatus(rig, "running");
    store.auditLog.add("owner:ui", "machine_rig_images", { rig, from: r.images, to: images });
    const changed = [
      r.images.harness !== images.harness ? `harness ${r.images.harness} → ${images.harness}` : "",
      r.images.supervisor !== images.supervisor
        ? `supervisor ${r.images.supervisor} → ${images.supervisor}`
        : "",
    ]
      .filter(Boolean)
      .join("; ");
    return `${changed || `the same image names, pulled again: ${images.harness}, ${images.supervisor}`}; its services restarted`;
  };
  /** Moves a rig control set up on a cluster onto control's images; what changed. */
  const updateClusterRig = async (rig: string): Promise<string> => {
    const k = store.clusters.rig(rig);
    const want = k ? controlImages(parts, k.spec.gpus) : undefined;
    if (
      k &&
      want &&
      typeof want !== "string" &&
      want.harness === k.spec.images.harness &&
      want.supervisor === k.spec.images.supervisor &&
      k.status !== "failed"
    )
      throw new Error(
        `${rig} runs the images control deploys already (${want.harness}, ${want.supervisor}), and they are not Thermite ${control.version}'s: set control's rig images to ${control.version}'s, then update again`,
      );
    // The update has paused the rig's runs at a safe point already: its containers move now, and
    // a drain would only report them moved before they did.
    const done = await updateRigImages(parts, rig, "owner:ui", { wait: false });
    if ("error" in done) throw new Error(done.error);
    return done.ok;
  };
  app.get("/ui/rigs/:rig/update.json", (c) => {
    const rig = c.req.param("rig");
    return store.reportedRigs.list().some((x) => x.id === rig)
      ? c.json(updateProgress(rig))
      : c.json({ error: "not found" }, 404);
  });
  app.post("/ui/rigs/:rig/update", (c) => {
    const rig = c.req.param("rig");
    const json = wantsJson(c);
    const back = (k: "ok" | "error", m: string) =>
      json
        ? c.json(
            k === "ok"
              ? { ...updateProgress(rig), said: m, tone: "ok", follow: updateFollowUrl(rig) }
              : notSent(m),
            k === "ok" ? 200 : 400,
          )
        : c.redirect(
            `/ui/rigs/${encodeURIComponent(rig)}?${k}=${encodeURIComponent(m)}#version`,
            303,
          );
    // Another program's words (ssh, kubectl): the page's address names them by a note's ID.
    const failed = (why: string) => back("error", json ? why : noted(why));
    const place = placeOf(rig);
    if (!place.update)
      return back(
        "error",
        place.noUpdate ??
          `Control didn't set ${rig} up on a machine or a cluster, so it can't move it onto its images. Pull the ${control.version} images where it runs, and start it again with them.`,
      );
    try {
      void updates.begin(rig, "owner:ui", {
        apply: () => (place.kind === "machine" ? updateMachineRig(rig) : updateClusterRig(rig)),
      });
    } catch (err) {
      return failed(errorText(err));
    }
    store.auditLog.add("owner:ui", "rig_update", { rig, to: control.version });
    return back(
      "ok",
      `The update of ${rig} to ${control.version} began. Its steps show below as they happen.`,
    );
  });
  app.post("/ui/rigs/:rig/check", async (c) => {
    const rig = c.req.param("rig");
    const back = (k: "ok" | "error", m: string) =>
      c.redirect(`/ui/rigs/${encodeURIComponent(rig)}?${k}=${encodeURIComponent(m)}`, 303);
    const found = await checkRigPlace(parts, rig, "owner:ui");
    if (!found) return back("error", "Control can't reach where this rig runs.");
    return found.ok ? back("ok", found.words) : back("error", noted(found.words));
  });
}
