import type { Hono } from "hono";
import { errorText } from "../../../common/errors.ts";
import { readRunpod } from "../../runpod/index.ts";
import { keyHint } from "../../secrets.ts";
import type { Dashboard } from "../context.ts";
import { machineUrl, settingsHelpers, usd } from "./shared.ts";

/** A GPU cloud's forms on Providers: check it now, its key, its test pods, and delete it. */
export function cloudRoutes(app: Hono, dash: Dashboard): void {
  const { noted, opts, store } = dash;
  const { checkCloudNow } = settingsHelpers(dash);

  // ---------------------------------------------------------------- GPU clouds (Providers)
  app.post("/ui/settings/clouds/:name/check", async (c) => {
    const name = c.req.param("name");
    if (!(await store.gpuClouds.get(name)))
      return c.redirect(machineUrl("error", "No such GPU cloud."), 303);
    const why = await checkCloudNow(name);
    return c.redirect(
      why
        ? machineUrl("error", noted(`"${name}": ${why}`))
        : machineUrl("ok", `Read "${name}" again.`),
      303,
    );
  });
  app.post("/ui/settings/clouds/:name/key", async (c) => {
    const name = c.req.param("name");
    const key = String((await c.req.parseBody()).runpod_key ?? "").trim();
    if (!(await store.gpuClouds.get(name)))
      return c.redirect(machineUrl("error", "No such GPU cloud."), 303);
    if (!key) return c.redirect(machineUrl("error", "Paste the new key."), 303);
    try {
      const facts = await readRunpod(key, opts.cloudFetch);
      await store.gpuClouds.replaceKey(name, opts.secrets.seal(key), keyHint(key), "owner:ui");
      await store.gpuClouds.setFacts(name, { facts });
    } catch (err) {
      return c.redirect(machineUrl("error", noted(`Kept the old key: ${errorText(err)}.`)), 303);
    }
    return c.redirect(machineUrl("ok", `"${name}" has its new key, and is read again.`), 303);
  });
  app.post("/ui/settings/clouds/:name/test", async (c) => {
    const name = c.req.param("name");
    const f = await c.req.parseBody();
    if (!opts.runpodTests) return c.redirect(machineUrl("error", "Test pods are off."), 303);
    const num = (v: unknown) => (String(v ?? "").trim() ? Number(String(v).trim()) : undefined);
    try {
      const x = await opts.runpodTests.start(
        name,
        {
          gpu: String(f.gpu ?? "").trim() || undefined,
          cloud_type: f.cloud_type === "COMMUNITY" ? "COMMUNITY" : "SECURE",
          image: String(f.image ?? "").trim() || undefined,
          disk_gb: num(f.disk_gb),
          restart: f.restart === "1",
          stop_after_minutes: num(f.stop_after_minutes),
        },
        "owner:ui",
      );
      return c.redirect(
        machineUrl(
          "ok",
          `Test ${x.id} started: a ${x.gpu_name} pod at ${usd(x.price_per_hr)}/h. Its report shows below when it comes.`,
        ),
        303,
      );
    } catch (err) {
      return c.redirect(machineUrl("error", noted(`No test pod: ${errorText(err)}.`)), 303);
    }
  });
  app.post("/ui/settings/clouds/:name/tests/:id/end", async (c) => {
    if (!opts.runpodTests) return c.redirect(machineUrl("error", "Test pods are off."), 303);
    try {
      const x = await opts.runpodTests.end(c.req.param("id"), "owner:ui");
      return c.redirect(
        machineUrl(
          x.active ? "error" : "ok",
          x.active
            ? noted(`Test ${x.id}: ${x.error ?? "the pod is not removed yet"}`)
            : `Test ${x.id} ended: the pod is removed.`,
        ),
        303,
      );
    } catch (err) {
      return c.redirect(machineUrl("error", noted(errorText(err))), 303);
    }
  });
  app.get("/ui/settings/clouds/:name/tests/:id{.+\\.json}", async (c) => {
    const x = await opts.runpodTests?.view(c.req.param("id").replace(/\.json$/, ""));
    return x && x.cloud === c.req.param("name") ? c.json(x) : c.json({ error: "not found" }, 404);
  });
  app.post("/ui/settings/clouds/:name/delete", async (c) => {
    const name = c.req.param("name");
    if ((await opts.runpodTests?.list(name, 1))?.some((x) => x.active))
      return c.redirect(
        machineUrl("error", "A test pod is running there: end it first, so its pod is removed."),
        303,
      );
    return c.redirect(
      (await store.gpuClouds.delete(name, "owner:ui"))
        ? machineUrl("ok", `"${name}" is deleted: control keeps nothing of its key.`)
        : machineUrl("error", "No such GPU cloud."),
      303,
    );
  });
}
