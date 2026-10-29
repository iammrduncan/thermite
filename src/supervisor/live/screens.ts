import { controlClient } from "../../common/api/control.ts";
import { harnessClient } from "../../common/api/harness.ts";
import { log } from "../../common/env.ts";
import { SCREENS as SCREENS_TO_CONTROL } from "../../core/api/control/rigs.ts";
import { SCREENS } from "../../core/api/harness/supervisor.ts";
import { SCREENS_IDLE_MS, SCREENS_WATCHED_MS } from "../../core/screens.ts";

/**
 * The terminal view's relay (goal 169; core/screens.ts): the supervisor asks control which of the
 * rig's trials someone watches, asks its harness for their screens, and posts them to control, over
 * HTTP whether or not the rig uses the message bus: a screen is a view, which the bus's LIVE stream
 * would keep on disk. Nothing here keeps a screen: each goes on as it came, and only while watched.
 */
export interface ScreensRelayConfig {
  rig: string;
  harnessUrl: string;
  harnessToken: string;
  controlUrl: string;
  controlToken: string;
  fetchImpl?: typeof fetch | undefined;
}

/**
 * One round: the screens of the trials watched (`watch`, control's answer to the round before),
 * posted to control. Returns the trials watched now.
 */
export async function relayScreensOnce(
  cfg: ScreensRelayConfig,
  watch: readonly string[],
): Promise<string[]> {
  const harness = harnessClient({
    url: cfg.harnessUrl,
    token: cfg.harnessToken,
    fetchImpl: cfg.fetchImpl,
  });
  const control = controlClient({
    url: cfg.controlUrl,
    token: cfg.controlToken,
    rig: cfg.rig,
    fetchImpl: cfg.fetchImpl,
  });
  const frames = watch.length
    ? (await harness.call(SCREENS, { body: { trials: [...watch] } })).screens
    : [];
  const answer = await control.call(SCREENS_TO_CONTROL, { body: { frames } });
  return answer.watch;
}

/**
 * The relay's loop until `stopping`: every SCREENS_WATCHED_MS while a trial is watched, every
 * SCREENS_IDLE_MS while none is. A failure is logged once until a round works again.
 */
export async function relayScreens(
  cfg: ScreensRelayConfig,
  stopping: () => boolean,
): Promise<void> {
  let watch: string[] = [];
  let failing = false;
  while (!stopping()) {
    let wait = SCREENS_IDLE_MS;
    try {
      const was = watch.length;
      watch = await relayScreensOnce(cfg, watch);
      if (Boolean(was) !== Boolean(watch.length))
        log("supervisor", watch.length ? "screens are watched" : "no screen is watched", {
          trials: watch,
        });
      // A watch that has just begun gets its first screens at once.
      wait = !watch.length ? SCREENS_IDLE_MS : was ? SCREENS_WATCHED_MS : 0;
      failing = false;
    } catch (err) {
      if (!failing) log("supervisor", "screens relay error", { error: String(err) }, "error");
      failing = true;
      watch = [];
    }
    const until = Date.now() + wait;
    while (!stopping() && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
  }
}
