import { esc, infoLabel } from "../components/index.ts";
import { TIP } from "./words.ts";

/**
 * Metrics' tabs for the whole system (goal 179, from the owner's mockup): Model use as it was
 * (ui/usage.ts), and Bus, Control, Storage and Rigs, each drawn from control's system figures
 * (control/system/), and the stream inspector a click on a stream opens. The page draws its part
 * again every 2 seconds while it is shown (data-every; commands/client.ts), until Pause.
 */

export { busTab, streamHref } from "./bus.ts";
export { duration } from "./common.ts";
export { controlTab, cpuWords, storageTab } from "./control.ts";
export { rigsTab } from "./rigs.ts";
export { streamMessageBody, streamPageBody } from "./stream.ts";
export { mayPublish, STREAM_WORDS } from "./words.ts";

/** Metrics' tabs, in order: the first is the page's own, Model use. */
const METRICS_TABS = [
  ["use", "Model use"],
  ["bus", "Bus"],
  ["control", "Control"],
  ["storage", "Storage"],
  ["rigs", "Rigs"],
] as const;
export type MetricsTab = (typeof METRICS_TABS)[number][0];

/** The tab a query names; Model use for none or another word. */
export const metricsTab = (asked: string | undefined): MetricsTab =>
  METRICS_TABS.find(([t]) => t === asked)?.[0] ?? "use";

/** A tab's address. */
export const metricsHref = (tab: MetricsTab) =>
  tab === "use" ? "/ui/metrics" : `/ui/metrics?tab=${tab}`;

/** The tabs, the one shown marked. */
export function metricsTabs(active: MetricsTab): string {
  return `<nav class="tabs">${METRICS_TABS.map(([t, word]) => `<a class="${t === active ? "on" : ""}" href="${metricsHref(t)}">${esc(word)}</a>`).join("")}</nav>`;
}

/** The page's live switch, in its header: it draws the figures again every 2 seconds until Pause. */
export const liveSwitch = () =>
  `<span class="sys-live" data-every="2000"><span class="sys-pulse"></span><span data-live-words>Live, every 2 s</span> ${infoLabel("", TIP.live)}<button type="button" class="btn sm" data-pause>Pause</button></span>`;
