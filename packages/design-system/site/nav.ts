import type { MouseEvent } from "react";

/** The site's own address: control serves it at /design (vite.config.ts). */
const BASE = "/design";

/** An address of the site, from a page's own path: "/buttons" is "/design/buttons". */
export const to = (path: string) => `${BASE}${path === "/" ? "" : path}`;

/** The open page's own path, from the browser's address. */
export const here = () => location.pathname.slice(BASE.length).replace(/\/$/, "") || "/";

/** A plain link that stays in the site. A modified click keeps the browser's behaviour. */
export function follow(event: MouseEvent<HTMLAnchorElement>) {
  if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  history.pushState(null, "", event.currentTarget.pathname);
  dispatchEvent(new PopStateEvent("popstate"));
}
