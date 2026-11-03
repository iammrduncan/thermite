import type { Hono } from "hono";
import { errorText } from "../../../common/errors.ts";
import {
  DEFAULT_VOLUME_GB,
  FORM_IDLE_STOP_MINUTES,
  type LaunchRequest,
  type LimitsChange,
  MIN_IDLE_STOP_MINUTES,
  type RunpodFacts,
} from "../../runpod/index.ts";
import {
  type LaunchForm,
  launchBody,
  RUNPOD_LAUNCH_JS,
} from "../../ui/rigs/runpod-launch/index.ts";
import { type Ctx, type Dashboard, wantsJson } from "../context.ts";
import { settingsHelpers } from "../settings/shared.ts";

/**
 * RunPod rigs (goals 022, 023): their pod's log, stop, start, restart and terminate, and the
 * launch page and form.
 */
export function runpodRigRoutes(app: Hono, dash: Dashboard): void {
  const { csrf, noted, opts, page, said, store } = dash;
  const { checkCloudNow } = settingsHelpers(dash);

  // ---------------------------------------------------------------- RunPod rigs (goals 022, 023)
  // Reads the pod log now (Read again): JSON for the page's script, which then draws the block
  // again; else the rig's page at the block.
  app.post("/ui/rigs/:rig/runpod/logs", async (c) => {
    const rig = c.req.param("rig");
    const rigs = opts.runpodRigs;
    const follow = `/ui/rigs/${encodeURIComponent(rig)}/runpod/logs`;
    const answer = (ok: boolean, said: string) =>
      wantsJson(c)
        ? c.json({
            state: `read:${Date.now()}`,
            final: true,
            said,
            tone: ok ? "ok" : "bad",
            follow,
          })
        : c.redirect(
            `/ui/rigs/${encodeURIComponent(rig)}?${ok ? "ok" : "error"}=${encodeURIComponent(said)}#podlog`,
            303,
          );
    if (!rigs?.view(rig)) return answer(false, `${rig} is not a rig control launched on RunPod.`);
    try {
      const r = await rigs.logs(rig);
      return answer(
        true,
        `Read ${r.lines.length} line${r.lines.length === 1 ? "" : "s"} of pod ${r.pod}'s log from RunPod.`,
      );
    } catch (err) {
      return answer(false, `Not read: ${errorText(err)}`);
    }
  });
  const podActions = {
    stop: "Stopping: its runs are paused and its results go out first, then the pod stops.",
    start: "Starting: RunPod starts the pod, and its paused runs resume once it runs.",
    restart: "Restarting: the pod stops, then starts again.",
    terminate:
      "Terminating: its runs are paused, and the pod is removed only once every result has left it.",
  } as const;
  /** A number from a form field: empty is null (none), anything else must be a number. */
  const amount = (raw: unknown): number | null | "bad" => {
    const v = String(raw ?? "")
      .trim()
      .replace(/^\$/, "");
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : "bad";
  };
  app.post("/ui/rigs/:rig/runpod/:action", async (c) => {
    const rig = c.req.param("rig");
    const action = c.req.param("action");
    const back = (k: "ok" | "error", m: string, at = "#pod") =>
      c.redirect(`/ui/rigs/${encodeURIComponent(rig)}?${k}=${encodeURIComponent(m)}${at}`, 303);
    const rigs = opts.runpodRigs;
    if (!rigs?.view(rig)) return back("error", `${rig} is not a rig control launched on RunPod.`);
    const f = await c.req.parseBody();
    try {
      if (action === "limits") {
        const lim = amount(f.spend_limit_usd);
        const idle = amount(f.idle_stop_minutes);
        if (lim === "bad" || (lim !== null && !(lim > 0)))
          return back("error", "A spend limit is an amount in US dollars above 0, such as 40.");
        if (
          idle === "bad" ||
          (idle !== null && !(Number.isInteger(idle) && idle >= MIN_IDLE_STOP_MINUTES))
        )
          return back(
            "error",
            `An idle stop is a whole number of minutes, ${MIN_IDLE_STOP_MINUTES} or more.`,
          );
        const change: LimitsChange = { spend_limit_usd: lim, idle_stop_minutes: idle };
        const v = rigs.limits(rig, change, "owner:ui");
        return back(
          "ok",
          `Saved. ${v.spend_limit_usd === null ? "No spend limit." : `Control stops the pod at $${v.spend_limit_usd.toFixed(2)}.`} ${v.idle_stop_minutes === null ? "It never stops by itself." : `It stops after ${v.idle_stop_minutes} minutes with no run at work.`}`,
        );
      }
      if (action === "stop") await rigs.stop(rig, "owner:ui");
      else if (action === "start") await rigs.start(rig, "owner:ui");
      else if (action === "restart") await rigs.restart(rig, "owner:ui");
      else if (action === "terminate") {
        const confirm = String(f.confirm ?? "").trim();
        if (confirm !== `terminate ${rig}`)
          return back("error", `Type "terminate ${rig}" to terminate it.`);
        await rigs.terminate(rig, "owner:ui", confirm);
      } else return back("error", "No such action.");
    } catch (err) {
      return back("error", noted(errorText(err)));
    }
    return back("ok", podActions[action as keyof typeof podActions]);
  });
  app.get("/ui/assets/runpod-launch.js", (c) =>
    c.body(RUNPOD_LAUNCH_JS, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );
  /** The launch form, for one RunPod account in Providers, maybe with what was typed and why not. */
  const launchPage = (c: Ctx, form: LaunchForm, error?: string) => {
    const clouds = store.gpuClouds.list().map((g) => ({
      name: g.name,
      key_hint: g.key_hint,
      facts: g.facts as RunpodFacts | null,
      checked_at: g.checked_at,
      error: g.check_error,
    }));
    const cloud = clouds.find((g) => g.name === form.cloud) ?? clouds[0];
    const crumbs = [
      { href: "/ui/rigs", text: "Rigs" },
      { href: "/ui/rigs/add", text: "Add a rig" },
    ];
    if (!cloud || !opts.runpodRigs)
      return page(
        c,
        { title: "Launch on RunPod", crumbs, active: "rigs" },
        `<div class="card"><p>Control has no RunPod account yet. Add one under <a href="/ui/settings">Settings › Providers</a>, with an API key that may start pods, then come back.</p></div>`,
      );
    return page(
      c,
      { title: "Launch on RunPod", crumbs, active: "rigs" },
      `${launchBody({
        clouds,
        cloud,
        image: opts.runpodRigs.defaultImage(),
        idleFill: Math.max(FORM_IDLE_STOP_MINUTES, MIN_IDLE_STOP_MINUTES),
        minIdle: MIN_IDLE_STOP_MINUTES,
        volumeGb: DEFAULT_VOLUME_GB,
        csrf: csrf(c),
        now: Date.now(),
        form,
        error,
      })}<script src="/ui/assets/runpod-launch.js" defer></script>`,
    );
  };
  app.get("/ui/rigs/add/runpod", (c) =>
    launchPage(c, { cloud: c.req.query("cloud") }, said(c) || undefined),
  );
  app.post("/ui/rigs/add/runpod", async (c) => {
    const f = await c.req.parseBody();
    const one = (k: string) => String(f[k] ?? "").trim();
    const form: LaunchForm = {
      cloud: one("cloud"),
      gpu: one("gpu"),
      gpu_count: one("gpu_count"),
      judge_gpus: one("judge_gpus"),
      datacenter: one("datacenter"),
      volume_gb: one("volume_gb"),
      image_choice: one("image_choice"),
      image: one("image"),
      spend_limit_usd: one("spend_limit_usd"),
      idle_stop_minutes: one("idle_stop_minutes"),
      rig: one("rig"),
    };
    // Read again: the account's prices and stock, then the form as it was.
    if (one("read")) {
      const why = await checkCloudNow(form.cloud ?? "");
      return c.redirect(
        `/ui/rigs/add/runpod?cloud=${encodeURIComponent(form.cloud ?? "")}${why ? `&error=${noted(why)}` : ""}`,
        303,
      );
    }
    const rigs = opts.runpodRigs;
    if (!rigs || !store.gpuClouds.get(form.cloud ?? ""))
      return launchPage(c, form, "Choose a RunPod account from Settings › Providers.");
    const count = Number(form.gpu_count || "1");
    if (!(Number.isInteger(count) && count >= 1 && count <= 8))
      return launchPage(c, form, "A pod has 1 to 8 GPUs.");
    const judge = form.judge_gpus ? Number(form.judge_gpus) : undefined;
    if (
      count >= 2 &&
      judge !== undefined &&
      !(Number.isInteger(judge) && judge >= 1 && judge < count)
    )
      return launchPage(c, form, `With ${count} GPUs, the judge takes 1 to ${count - 1} of them.`);
    const volume = Number(form.volume_gb || String(DEFAULT_VOLUME_GB));
    if (!(Number.isInteger(volume) && volume >= 10 && volume <= 10_000))
      return launchPage(c, form, "The volume is 10 to 10000 GB.");
    const lim = amount(form.spend_limit_usd);
    if (lim === "bad" || (lim !== null && !(lim > 0)))
      return launchPage(c, form, "A spend limit is an amount in US dollars above 0, such as 40.");
    const idle = amount(form.idle_stop_minutes);
    if (
      idle === "bad" ||
      (idle !== null && !(Number.isInteger(idle) && idle >= MIN_IDLE_STOP_MINUTES))
    )
      return launchPage(
        c,
        form,
        `An idle stop is a whole number of minutes, ${MIN_IDLE_STOP_MINUTES} or more.`,
      );
    const own = form.image_choice === "own" || !rigs.defaultImage();
    if (own && !form.image) return launchPage(c, form, "Give your image's name and tag.");
    const req: LaunchRequest = {
      gpu: form.gpu ?? "",
      gpu_count: count,
      cloud_type: "SECURE",
      datacenter: form.datacenter || undefined,
      volume_gb: volume,
      image: own ? form.image : undefined,
      rig: form.rig || undefined,
      ...(lim !== null ? { spend_limit_usd: lim } : {}),
      // Cleared by the owner: none, whatever control's default is.
      idle_stop_minutes: idle,
      ...(count >= 2 && judge !== undefined
        ? { settings: { THERMITE_JUDGE_GPUS: String(judge) } }
        : {}),
    };
    if (!req.gpu) return launchPage(c, form, "Choose a GPU.");
    try {
      const v = await rigs.launch(form.cloud ?? "", req, "owner:ui");
      return c.redirect(
        `/ui/rigs/${encodeURIComponent(v.rig)}?ok=${encodeURIComponent(`Launched: RunPod bills pod ${v.pod} from now${v.price_per_hr !== null ? ` at $${v.price_per_hr.toFixed(2)} an hour` : ""}. Control enrolls it once it runs.`)}`,
        303,
      );
    } catch (err) {
      return launchPage(c, form, errorText(err));
    }
  });
}
