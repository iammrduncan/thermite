import type { Hono } from "hono";
import { errorText } from "../../common/errors.ts";
import { chooseAtDeadline } from "../clusters/index.ts";
import { checkProgress, checkRows, commandProgress, modelProgress } from "../command-progress.ts";
import { propagateChampion } from "../issue/index.ts";
import { advanceResets, cancelReset, confirmReset } from "../lifecycle.ts";
import { runpodResetRefusal } from "../runpod/index.ts";
import { RUN_ROUTES, runHref } from "../ui/urls.ts";
import { backTo, type Dashboard } from "./context.ts";

/**
 * Following an action to its outcome (goal 080): a command's, a check's and a model's progress,
 * and the actions that answer it directly (full reset, leave a trial, propagate a champion,
 * restart or reset a rig, the owner's choice at a drain's deadline).
 */
export function actionRoutes(app: Hono, dash: Dashboard): void {
  const { noted, opts, parts, runOf, store } = dash;

  // ---------------------------------------------------------------- following an action (goal 080)
  // The page's script sends an action's form with fetch, asking for JSON, then follows it on these
  // routes until its outcome: a Progress (command-progress.ts) each time.
  app.get("/ui/commands/:file{.+\\.json}", (c) => {
    const cmd = store.commands.row(c.req.param("file").replace(/\.json$/, ""));
    return cmd ? c.json(commandProgress(cmd, Date.now())) : c.json({ error: "not found" }, 404);
  });
  app.get("/ui/rigs/:rig/checks/:file{.+\\.json}", (c) => {
    const rig = c.req.param("rig");
    const check = c.req.param("file").replace(/\.json$/, "");
    const known = store.reportedRigs.list().find((x) => x.id === rig);
    if (!known) return c.json({ error: "not found" }, 404);
    const row = checkRows(store, rig, Date.now())[check];
    return row
      ? c.json(checkProgress(row, known.last_cursor))
      : c.json({ error: "not found" }, 404);
  });
  app.get("/ui/rigs/:rig/model.json", (c) => {
    const rig = c.req.param("rig");
    return store.reportedRigs.list().some((x) => x.id === rig)
      ? c.json(modelProgress(store, rig, Date.now()))
      : c.json({ error: "not found" }, 404);
  });

  app.post("/ui/resets/:id/confirm", async (c) => {
    try {
      confirmReset(store, Number(c.req.param("id")), "owner:ui");
      await advanceResets({
        store,
        privateKeyPem: opts.privateKeyPem,
        driver: opts.driver,
        staleAfterMs: opts.staleAfterMs,
      });
    } catch (err) {
      return c.text(`refused: ${errorText(err)}`, 400);
    }
    return c.redirect("/ui/reports", 303);
  });

  // The owner's choice at a drain's deadline, on any rig (goal 173): the change now, stopping what
  // still runs, or the end of the drain. Back where the choice was made, with what it did.
  app.post("/ui/rigs/:rig/drain/:choice", async (c) => {
    const rig = c.req.param("rig");
    const choice = c.req.param("choice");
    const back = backTo(await c.req.parseBody(), `/ui/rigs/${encodeURIComponent(rig)}`);
    const done =
      choice === "apply" || choice === "end"
        ? await chooseAtDeadline(parts, rig, choice, "owner:ui")
        : { error: "No such choice." };
    const [k, words] = "error" in done ? ["error", done.error] : ["ok", done.ok];
    return c.redirect(
      `${back}${back.includes("?") ? "&" : "?"}${k}=${encodeURIComponent(words)}`,
      303,
    );
  });

  app.post("/ui/resets/:id/cancel", (c) => {
    try {
      cancelReset(store, Number(c.req.param("id")), "owner:ui");
    } catch (err) {
      return c.text(`refused: ${errorText(err)}`, 400);
    }
    return c.redirect("/ui/reports", 303);
  });

  // A stuck trial the owner leaves running (goal 143): its card stays away until it is stuck again.
  // The trial is addressed through its run (goal 170); control keeps its lines by the run's rig.
  app.post(RUN_ROUTES.leaveTrial, async (c) => {
    const f = await c.req.parseBody();
    const x = await runOf(c.req.param("campaign"), c.req.param("run"));
    if (!x) return c.text("No such run in this campaign.", 404);
    const rig = x.rig.id;
    const trial = c.req.param("trial");
    const kind = String(f.kind ?? "");
    const since = String(f.since ?? "");
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(trial) ||
      // A quiet or repeating spell is known by a time; a refused page's by its address.
      !(kind === "refused"
        ? since.length >= 1 && since.length <= 2000
        : (kind === "quiet" || kind === "repeating") && !Number.isNaN(Date.parse(since)))
    )
      return c.text("refused: that is not a stuck trial's card", 400);
    store.liveLines.leaveTrial({ rig, trial, kind, since, by: "owner:ui" });
    store.auditLog.add("owner:ui", "trial_left", {
      rig,
      run: x.run.id,
      trial,
      kind,
      since,
    });
    return c.redirect(backTo(f, "/ui"), 303);
  });

  app.post("/ui/propagate", async (c) => {
    const f = await c.req.parseBody();
    const toRun = String(f.to_run ?? "");
    try {
      await propagateChampion(store, opts.privateKeyPem, {
        run: String(f.run ?? ""),
        toRun,
        issuedBy: "owner:ui",
        staleAfterMs: opts.staleAfterMs,
      });
    } catch (err) {
      return c.text(`refused: ${errorText(err)}`, 400);
    }
    // The target's page, where its judge's test of the champion shows.
    const target = (await parts.run(toRun))?.run;
    return c.redirect(target ? runHref(target) : "/ui/campaigns", 303);
  });

  app.post("/ui/rigs/:rig/restart", async (c) => {
    const rig = c.req.param("rig");
    // A rig on RunPod: RunPod's own driver, whatever THERMITE_LIFECYCLE says.
    if (opts.runpodDriver?.serves(rig)) {
      store.auditLog.add("owner:ui", "restart", { rig });
      const to = (k: "ok" | "error", m: string) =>
        c.redirect(`/ui/rigs/${encodeURIComponent(rig)}?${k}=${encodeURIComponent(m)}#pod`, 303);
      try {
        await opts.runpodDriver.restart(rig, ["harness", "supervisor"], "owner:ui");
      } catch (err) {
        return to("error", noted(errorText(err)));
      }
      return to("ok", "Restarting: the pod stops, then starts again.");
    }
    if (!opts.driver) return c.text("no deployment driver is configured", 409);
    store.auditLog.add("owner:ui", "restart", { rig });
    try {
      await opts.driver.restart(rig, ["harness", "supervisor"]);
    } catch (err) {
      return c.text(`restart failed: ${errorText(err)}`, 500);
    }
    return c.redirect(`/ui/rigs/${encodeURIComponent(rig)}`, 303);
  });

  app.post("/ui/rigs/:rig/reset", async (c) => {
    const rig = c.req.param("rig");
    const f = await c.req.parseBody();
    if (String(f.confirm ?? "") !== `reset ${rig}`)
      return c.text(`type "reset ${rig}" to confirm a full reset`, 400);
    // A rig on RunPod: its pod must run, with no stop, start or terminate under way.
    const onRunpod = runpodResetRefusal(store, rig);
    if (onRunpod)
      return c.redirect(
        `/ui/rigs/${encodeURIComponent(rig)}?error=${encodeURIComponent(onRunpod)}#pod`,
        303,
      );
    try {
      store.fullResets.create(rig, "owner:ui");
      await advanceResets({
        store,
        privateKeyPem: opts.privateKeyPem,
        driver: opts.driver,
        staleAfterMs: opts.staleAfterMs,
      });
    } catch (err) {
      return c.text(`refused: ${errorText(err)}`, 400);
    }
    return c.redirect("/ui/reports", 303);
  });
}
