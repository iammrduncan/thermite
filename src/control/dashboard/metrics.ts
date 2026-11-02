import type { Hono } from "hono";
import { BadInput, errorText } from "../../common/errors.ts";
import {
  asText,
  inspectable,
  type MessagesPage,
  streamMessage,
  streamPage,
  streamReader,
} from "../system/index.ts";
import { esc } from "../ui/components/index.ts";
import {
  busTab,
  controlTab,
  liveSwitch,
  type MetricsTab,
  metricsHref,
  metricsTabs,
  rigsTab,
  storageTab,
  streamHref,
  streamMessageBody,
  streamPageBody,
} from "../ui/metrics/index.ts";
import type { Ctx, Dashboard } from "./context.ts";

/**
 * Metrics' system tabs and the stream inspector (goal 179). `/ui/metrics?tab=bus|control|storage|rigs`
 * draws one tab from control's system figures, in a part the page draws again every 2 seconds
 * (data-part="sys"); overview.ts serves Model use and hands the other tabs here. A click on a stream
 * opens `/ui/metrics/streams/<stream>`, its messages newest first, and a message
 * `/ui/metrics/streams/<stream>/<seq>`, with its data downloaded from `…/<seq>/data`.
 */

/** The tabs' row: the tabs, and the live switch, which a redraw leaves as it is. */
const tabsRow = (tab: MetricsTab) =>
  `<div class="sys-tabsrow">${metricsTabs(tab)}${tab === "use" ? "" : liveSwitch()}</div>`;

/** The row of tabs above Model use, which overview.ts draws. */
export const modelUseTabs = () => tabsRow("use");

/** One of the system tabs, drawn now. */
export async function systemTabPage(c: Ctx, dash: Dashboard, tab: Exclude<MetricsTab, "use">) {
  const now = Date.now();
  const system = dash.parts.system;
  const vs = dash.views();
  const body =
    tab === "bus"
      ? busTab(await system.bus(), now)
      : tab === "control"
        ? controlTab(system.control(), now)
        : tab === "storage"
          ? storageTab(await system.storage())
          : rigsTab(system.rigs(vs), now);
  return dash.page(
    c,
    { title: "Metrics", summary: "the whole system, live", active: "metrics" },
    `${tabsRow(tab)}<div data-part="sys">${body}</div>`,
    vs,
  );
}

export function metricsRoutes(app: Hono, dash: Dashboard): void {
  const { page, parts } = dash;
  const crumbs = [
    { href: "/ui/metrics", text: "Metrics" },
    { href: metricsHref("bus"), text: "Bus" },
  ];
  /** A page that says what it can't show, with the way back. */
  const missing = (c: Ctx, title: string, words: string, status: 400 | 404 | 409 = 404) => {
    c.status(status);
    return page(
      c,
      { title, active: "metrics", crumbs },
      `<div class="card warn"><b>${esc(words)}</b> <a href="${metricsHref("bus")}">Back to the bus</a></div>`,
    );
  };
  const place = (v: string | undefined, name: string): number | undefined => {
    if (v === undefined || v.trim() === "") return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0)
      throw new BadInput(`${name} is refused: a place is 0 or more`);
    return n;
  };

  app.get("/ui/metrics/streams/:stream", async (c) => {
    const stream = c.req.param("stream");
    if (!inspectable(stream)) return missing(c, stream, "Control makes no stream by that name.");
    const bus = streamReader(parts.bus);
    if (!bus) return missing(c, stream, "Control has no message bus to read.", 409);
    let p: MessagesPage;
    try {
      p = await streamPage(bus, stream, {
        subject: c.req.query("subject"),
        before: place(c.req.query("before"), "before"),
        after: place(c.req.query("after"), "after"),
      });
    } catch (err) {
      if (err instanceof BadInput) return missing(c, stream, err.message, 400);
      return missing(c, stream, `The bus did not answer: ${errorText(err)}`, 409);
    }
    return page(
      c,
      {
        title: stream,
        summary:
          p.subject === ">" ? "every subject, newest first" : `on ${esc(p.subject)}, newest first`,
        active: "metrics",
        crumbs,
      },
      streamPageBody(p),
    );
  });

  const message = async (c: Ctx) => {
    const stream = c.req.param("stream") ?? "";
    const seq = Number(c.req.param("seq"));
    if (!inspectable(stream)) return { error: "Control makes no stream by that name." } as const;
    const bus = streamReader(parts.bus);
    if (!bus) return { error: "Control has no message bus to read." } as const;
    try {
      const m = await streamMessage(bus, stream, seq);
      return m
        ? { stream, m }
        : ({
            error: `${stream} holds no message at place ${c.req.param("seq")}: a reader took it, or a limit or a retention policy removed it.`,
          } as const);
    } catch (err) {
      return { error: errorText(err) } as const;
    }
  };

  app.get("/ui/metrics/streams/:stream/:seq", async (c) => {
    const r = await message(c);
    if ("error" in r) return missing(c, c.req.param("stream") ?? "", String(r.error));
    return page(
      c,
      {
        title: `${r.stream} · ${r.m.seq}`,
        summary: esc(r.m.subject),
        active: "metrics",
        crumbs: [...crumbs, { href: streamHref(r.stream), text: r.stream }],
      },
      streamMessageBody(r.stream, r.m, asText(r.m.data)),
    );
  });

  app.get("/ui/metrics/streams/:stream/:seq/data", async (c) => {
    const r = await message(c);
    if ("error" in r) return c.text(String(r.error), 404);
    const text = asText(r.m.data) !== null;
    return c.body(new Uint8Array(r.m.data), 200, {
      "content-type": text ? "text/plain; charset=utf-8" : "application/octet-stream",
      "content-disposition": `attachment; filename="${r.stream}-${r.m.seq}.${text ? "txt" : "bin"}"`,
      "x-content-type-options": "nosniff",
    });
  });
}
