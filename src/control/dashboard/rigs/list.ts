import type { Hono } from "hono";
import { bringBackRig } from "../../rigs/index.ts";
import type { RunpodRigView } from "../../runpod/index.ts";
import { ago, esc } from "../../ui/components/index.ts";
import {
  type RigsListRow,
  type RigWhere,
  rigFilter,
  rigsListBody,
  rigsSummary,
} from "../../ui/rigs/list.ts";
import type { Dashboard } from "../context.ts";

/** The Rigs page, with Retire and Bring back. */
export function rigListRoutes(app: Hono, dash: Dashboard): void {
  const { control, offlineAfterMs, opts, page, store, views } = dash;

  // ---------------------------------------------------------------- rigs (Magnesium's Fleet)
  // Retire a rig that is gone, whatever set it up; bring it back.
  app.post("/ui/rigs/:rig/retire", async (c) => {
    const rig = c.req.param("rig");
    const back = (k: "ok" | "error", m: string) =>
      c.redirect(`/ui/rigs/${encodeURIComponent(rig)}?${k}=${encodeURIComponent(m)}`, 303);
    const f = await c.req.parseBody();
    if (String(f.confirm ?? "").trim() !== `retire ${rig}`)
      return back("error", `Type "retire ${rig}" to retire it.`);
    if (!store.reportedRigs.list().some((u) => u.id === rig)) return back("error", "No such rig.");
    store.retired.add(rig, "owner:ui");
    return back("ok", `${rig} is retired.`);
  });
  app.post("/ui/rigs/:rig/bring-back", async (c) => {
    const rig = c.req.param("rig");
    const ok = await bringBackRig(store, rig, "owner:ui");
    return c.redirect(
      `/ui/rigs/${encodeURIComponent(rig)}?${ok ? "ok" : "error"}=${encodeURIComponent(ok ? `${rig} is back.` : `${rig} is not retired.`)}`,
      303,
    );
  });

  /** Where a rig runs, for its row on the Rigs list: the kind of place and its name. */
  const whereOf = (rig: string, pod: RunpodRigView | undefined): RigWhere => {
    const gone = (status: string) => (status === "removed" ? ", removed" : "");
    const m = store.machines.rig(rig);
    if (m) return { kind: "Machine", name: `${m.machine}${gone(m.status)}` };
    const k = store.clusters.rig(rig);
    if (k) return { kind: "Cluster", name: `${k.cluster}${gone(k.status)}` };
    if (pod) return { kind: "RunPod", name: pod.datacenter ?? "" };
    const j = store.joinedRigs.get(rig);
    if (j) return { kind: "Joined", name: j.form === "namespace" ? "a namespace" : "a machine" };
    return { kind: "Set up by you", name: "" };
  };
  app.get("/ui/rigs", (c) => {
    const now = Date.now();
    const vs = views();
    const gone = store.retired.list();
    const listed = new Set([...vs.map((u) => u.id), ...gone.map((r) => r.rig)]);
    const rows: RigsListRow[] = [
      ...vs.map((u) => ({
        id: u.id,
        u,
        where: whereOf(u.id, u.runpod),
        pod: u.runpod,
        keyPending: Boolean(store.reportedRigs.key(u.id).pending),
      })),
      // A pod costs from its launch: it is listed before its first report too.
      ...(opts.runpodRigs?.list() ?? [])
        .filter((p) => p.active && !listed.has(p.rig))
        .map((p) => ({ id: p.rig, where: whereOf(p.rig, p), pod: p, keyPending: false })),
    ];
    const launch =
      opts.runpodRigs && store.gpuClouds.list().length
        ? `<a class="btn" href="/ui/rigs/add/runpod">Launch on RunPod</a>`
        : "";
    return page(
      c,
      {
        title: "Rigs",
        summary: rigsSummary(rows),
        actions: `${launch}<a class="btn primary" href="/ui/rigs/add">Add a rig</a>`,
        active: "rigs",
      },
      `${rigsListBody({
        rows,
        filter: rigFilter(c.req.query("f")),
        control,
        staleAfterMs: opts.staleAfterMs,
        offlineAfterMs,
        now,
      })}${
        gone.length
          ? `<div class="block" style="margin-top:20px"><div class="head"><h2>Retired</h2><span class="n">${gone.length}</span><span class="right">out of the lists; their records stay</span></div><div class="card flat">${gone
              .map(
                (r) =>
                  `<div class="row" style="padding:6px 0"><a href="/ui/rigs/${encodeURIComponent(r.rig)}">${esc(r.rig)}</a><span class="muted small">retired ${esc(ago(r.at, now))} ago by ${esc(r.by)}</span></div>`,
              )
              .join("")}</div></div>`
          : ""
      }`,
      vs,
    );
  });
}
