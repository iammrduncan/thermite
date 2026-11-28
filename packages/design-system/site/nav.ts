import type { MouseEvent } from "react";

/** Builds a gallery path while preserving any active `?preset=` query parameter. */
export function to(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const preset = new URLSearchParams(location.search).get("preset");
  return preset ? `${normalized}?preset=${encodeURIComponent(preset)}` : normalized;
}

/** Current page path without trailing slash (`/` for the index page). */
export function here(): string {
  return location.pathname.replace(/\/$/, "") || "/";
}

/** Client-side navigation helper that preserves modifier clicks and `?preset=` query state. */
export function follow(event: MouseEvent<HTMLAnchorElement>): void {
  if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  const target = new URL(event.currentTarget.href, location.origin);
  history.pushState(null, "", `${target.pathname}${target.search}`);
  dispatchEvent(new PopStateEvent("popstate"));
}
