import type { Hono } from "hono";
import { issueCommand } from "../../issue/index.ts";
import { setRigModel, WEEKLY_MODEL_STEP, WEEKLY_WAIT_STEP, weeklyLimit } from "../../rigs/index.ts";
import { waitEnd } from "../../ui/operator/index.ts";
import { rigHref } from "../../ui/urls.ts";
import type { Dashboard } from "../context.ts";

/**
 * The owner's two choices on a rig whose subscription's weekly limit is full (goal 169; the card
 * is ui/operator/weekly.ts): give the rig's workers another model for new trials, as Edit rig
 * does, and end its runs' waits for the reset; or wait for the reset. Each is a step in the rig's
 * history and an entry in the audit log, and the card leaves Needs you. Nothing answers the
 * program's own menu, and nothing changes a model without the owner.
 */
export function rigWeeklyRoutes(app: Hono, dash: Dashboard): void {
  const { opts, store, views } = dash;
  const back = (rig: string, k: "ok" | "error", m: string) =>
    `${rigHref(rig)}?${k}=${encodeURIComponent(m)}`;
  /** The rig's weekly limit now, or the words that say nothing waits for one. */
  const limitOf = (rig: string) => {
    const u = views().find((x) => x.id === rig);
    return u ? weeklyLimit(store, u) : undefined;
  };
  const NONE = "Its subscription's weekly limit no longer holds its runs: nothing waits for it.";

  app.post("/ui/rigs/:rig/weekly-limit/wait", async (c) => {
    const rig = c.req.param("rig");
    const w = limitOf(rig);
    if (!w) return c.redirect(back(rig, "error", NONE), 303);
    store.rigHistory.add(rig, WEEKLY_WAIT_STEP, true, w.until);
    store.auditLog.add("owner:ui", "weekly_limit_wait", { rig, until: w.until });
    return c.redirect(
      back(
        rig,
        "ok",
        `${rig} waits for the reset, ${waitEnd(w.until)}. Its page says so until then, and new trials start by themselves after it.`,
      ),
      303,
    );
  });

  app.post("/ui/rigs/:rig/weekly-limit/model", async (c) => {
    const rig = c.req.param("rig");
    const f = await c.req.parseBody();
    const w = limitOf(rig);
    if (!w) return c.redirect(back(rig, "error", NONE), 303);
    const [provider = "", model = ""] = String(f.model ?? "")
      .split("|")
      .map((x) => decodeURIComponent(x));
    if (!provider || !model)
      return c.redirect(back(rig, "error", "Choose a provider's model first."), 303);
    // The workers' model, as their row on Edit rig sets it: audited there (rig_model_given).
    const out = await setRigModel(store, rig, { agent: "workers", provider, model }, "owner:ui");
    if ("error" in out) return c.redirect(back(rig, "error", out.error), 303);
    // Its runs stop waiting for the reset: their new trials take the new model.
    for (const r of w.runs)
      issueCommand(store, opts.privateKeyPem, {
        rig,
        kind: "end_wait",
        payload: { run: r.run },
        issuedBy: "owner:ui",
      });
    store.rigHistory.add(rig, WEEKLY_MODEL_STEP, true, `${provider} · ${model}`);
    store.auditLog.add("owner:ui", "weekly_limit_model", {
      rig,
      provider,
      model,
      until: w.until,
      runs: w.runs.map((r) => r.run),
    });
    return c.redirect(
      back(
        rig,
        "ok",
        `${rig} takes ${provider} · ${model} for new trials within a minute; Edit rig shows it. Written to the audit log. The subscription's weekly limit still resets ${waitEnd(w.until)}.`,
      ),
      303,
    );
  });
}
