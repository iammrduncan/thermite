import { harnessClient } from "../../common/api/harness.ts";
import { log } from "../../common/env.ts";
import { SCREENS } from "../../core/api/harness/supervisor.ts";
import { SCREENS_IDLE_MS, SCREENS_WATCHED_MS, type ScreenFrame } from "../../core/screens.ts";
import { ask, type ControlOnBus } from "../ask.ts";

/**
 * The terminal view's relay (goal 169; core/screens.ts): the supervisor asks control which of the
 * rig's terminals someone watches, asks its harness for their screens, takes its own advisors'
 * from its own consoles, and sends them to control, on the message bus as a request on the rig's
 * own subject (core/link/asks.ts's `screens`), which no stream keeps: a screen is a view, not a
 * record. Nothing here keeps a screen: each goes on as it came, and only while watched.
 */
export interface ScreensRelayConfig {
  harnessUrl: string;
  harnessToken: string;
  /** Where the supervisor asks control: its rig's subjects on the bus. */
  control: ControlOnBus;
  fetchImpl?: typeof fetch | undefined;
  /** The supervisor's own terminals, its advisors' (advisors/terminal/consoles.ts). */
  own?: { has(id: string): boolean; frames(ids: readonly string[]): Promise<ScreenFrame[]> };
}

/**
 * One round: the screens of the trials watched (`watch`, control's answer to the round before),
 * sent to control. Returns the trials watched now.
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
  const mine = watch.filter((id) => cfg.own?.has(id));
  const theirs = watch.filter((id) => !mine.includes(id));
  const frames = [
    ...(theirs.length ? (await harness.call(SCREENS, { body: { trials: theirs } })).screens : []),
    ...(mine.length && cfg.own ? await cfg.own.frames(mine) : []),
  ];
  const answer = await ask(cfg.control, "screens", { frames });
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
