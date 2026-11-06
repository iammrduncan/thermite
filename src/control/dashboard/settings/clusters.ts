import type { Hono } from "hono";
import { checkClusterNow, setClusterSlots } from "../../clusters/index.ts";
import type { Dashboard } from "../context.ts";
import { machineUrl } from "./shared.ts";

/** A cluster's forms on Providers: check it now, its slots, and delete it. */
export function clusterRoutes(app: Hono, dash: Dashboard): void {
  const { noted, parts, store } = dash;

  // ---------------------------------------------------------------- clusters (Providers)
  app.post("/ui/settings/clusters/:name/check", async (c) => {
    const name = c.req.param("name");
    if (!store.clusters.get(name)) return c.redirect(machineUrl("error", "No such cluster."), 303);
    const why = await checkClusterNow(parts, name);
    return c.redirect(
      why
        ? machineUrl("error", noted(`"${name}": ${why}`))
        : machineUrl("ok", `Read "${name}" again.`),
      303,
    );
  });
  app.post("/ui/settings/clusters/:name/slots", async (c) => {
    const name = c.req.param("name");
    const f = await c.req.parseBody();
    const slots = String(f.slots ?? "")
      .split(/[\s,]+/)
      .filter(Boolean);
    const why = await setClusterSlots(parts, name, slots, "owner:ui");
    return c.redirect(
      why
        ? machineUrl("error", noted(`"${name}": ${why}.`))
        : machineUrl(
            "ok",
            `"${name}" now has ${slots.length} slot${slots.length === 1 ? "" : "s"}, read again.`,
          ),
      303,
    );
  });
  app.post("/ui/settings/clusters/:name/delete", (c) => {
    const name = c.req.param("name");
    if (store.clusters.rigs(name).some((r) => r.status !== "removed"))
      return c.redirect(machineUrl("error", `"${name}" still runs rigs: remove them first.`), 303);
    return c.redirect(
      store.clusters.delete(name, "owner:ui")
        ? machineUrl("ok", `"${name}" is deleted: control keeps nothing of its kubeconfig.`)
        : machineUrl("error", "No such cluster."),
      303,
    );
  });
}
