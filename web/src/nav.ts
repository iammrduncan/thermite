import { APP_PATH } from "@core/api/control/dashboard.ts";
import type { MouseEvent } from "react";

/** An address of the app, from a screen's own path: "/settings" is "/next/settings". */
export const to = (path: string) => `${APP_PATH}${path === "/" ? "" : path}`;

/** The screen's own path, from the browser's address. */
export const here = () => location.pathname.slice(APP_PATH.length) || "/";

export function go(path: string) {
  history.pushState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}

/** In-app navigation for plain links. Modified clicks keep the browser's behavior. */
export function follow(event: MouseEvent<HTMLAnchorElement>) {
  if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  // A link out of the app (a page still at /ui) is the browser's own.
  if (!event.currentTarget.pathname.startsWith(APP_PATH)) return;
  event.preventDefault();
  go(event.currentTarget.pathname + event.currentTarget.search);
}

/** A run's own address in the app. */
export const runPath = (r: { campaign: string | null; run: string | null }) =>
  to(`/campaigns/${encodeURIComponent(r.campaign ?? "")}/runs/${encodeURIComponent(r.run ?? "")}`);
