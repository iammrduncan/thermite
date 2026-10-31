import type { Hono } from "hono";
import { archiveResponse } from "../exports.ts";
import { cursorOf } from "../store/index.ts";
import { commandRow } from "../ui/commands/index.ts";
import { ago, avatar, esc, icon, meter, pct, valuesPairWords } from "../ui/components/index.ts";
import { exportsBody } from "../ui/exports.ts";
import { runHref } from "../ui/urls.ts";
import { leaderboard } from "../views/index.ts";
import type { Dashboard } from "./context.ts";

/** The Commands, Audit, Leaderboard, Exports (goal 103) and Reports pages. */
export function recordRoutes(app: Hono, dash: Dashboard): void {
  const { csrf, opts, page, store, views } = dash;

  // ---------------------------------------------------------------- commands, audit, leaderboard, reports
  app.get("/ui/commands", (c) => {
    const now = Date.now();
    const rows = store.commands
      .list(200)
      .map((x) => commandRow(x, now))
      .join("");
    return page(
      c,
      {
        title: "Commands",
        summary: "every signed command control issued, newest first",
        active: "commands",
      },
      `<div class="card flat"><table><thead><tr><th>Issued</th><th>Rig</th><th>Kind</th><th>By</th><th>Status</th><th>Outcome</th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="empty">No command yet.</td></tr>`}</tbody></table></div>`,
    );
  });

  app.get("/ui/audit", (c) => {
    const now = Date.now();
    // 300 entries a page, newest first; Older and Newer page through every entry (goal 015).
    const before = cursorOf(c.req.query("before"));
    const p = store.auditLog.page(
      300,
      {},
      before !== undefined ? { before } : { after: cursorOf(c.req.query("after")) },
    );
    // A refusal that repeats is one entry: when it came first, how often, and when last.
    const when = (x: { at: string; count: number; last_at: string }) =>
      `${esc(ago(x.at, now))} ago${x.count > 1 ? `<div class="xs">${x.count} times, the last ${esc(ago(x.last_at, now))} ago</div>` : ""}`;
    const rows = p.entries
      .map(
        (x) =>
          `<tr><td class="muted nowrap">${when(x)}</td><td>${esc(x.actor)}</td><td><b>${esc(x.action.replace(/_/g, " "))}</b> <span class="muted xs">${esc(x.action)}</span></td><td class="clip"><code class="muted">${esc(JSON.stringify(x.body).slice(0, 200))}</code></td></tr>`,
      )
      .join("");
    const links = [
      p.newer !== null ? `<a href="/ui/audit?after=${p.newer}">Newer</a>` : "",
      p.older !== null ? `<a href="/ui/audit?before=${p.older}">Older</a>` : "",
    ].filter(Boolean);
    return page(
      c,
      { title: "Audit log", summary: "who did what through control", active: "audit" },
      `<div class="card flat"><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Detail</th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="empty">No entry here.</td></tr>`}</tbody></table></div>${links.length ? `<div class="pager">${links.join("")}</div>` : ""}`,
    );
  });

  app.get("/ui/leaderboard", (c) => {
    const board = leaderboard(store, { staleAfterMs: opts.staleAfterMs });
    const body = Object.entries(board)
      .map(([campaign, rows]) => {
        const best = Math.max(0.0001, ...rows.map((r) => r.gain));
        return `<div class="block"><div class="head"><h2>${esc(campaign)}</h2><span class="n">${rows.length} rig${rows.length > 1 ? "s" : ""}</span></div><div class="card flat"><table><thead><tr><th style="width:40px">#</th><th>Rig / run</th><th>Champion</th><th style="width:40%">Gain over its baseline</th><th>Cross-verified</th></tr></thead><tbody>${rows
          .map(
            (r, n) =>
              `<tr><td class="muted">${n + 1}</td><td>${avatar(r.rig)} <a href="${runHref({ id: r.run, campaign })}"><b>${esc(r.rig)}</b> / ${esc(r.run)}</a></td><td class="muted">seq ${r.champion_seq}</td><td>${meter("", pct(r.gain, 2), r.gain / best, "primary")}${r.values ? `<div class="muted small">${esc(valuesPairWords(r.values))}</div>` : ""}</td>
<td>${r.verified_by.length ? `<span class="pill ok">${icon.check}by ${esc(r.verified_by.join(", "))}</span>` : `<span class="muted small">not yet</span>`}</td></tr>`,
          )
          .join("")}</tbody></table></div></div>`;
      })
      .join("");
    return page(
      c,
      {
        title: "Leaderboard",
        summary:
          "gains against each run's own baseline, measured on its own rig; cross-verified once another rig's judge accepted it",
        active: "campaigns",
      },
      body || `<div class="card"><div class="empty">No hill climb yet.</div></div>`,
    );
  });

  // ---------------------------------------------------------------- exports (goal 103)
  // Every export control keeps, for every rig, newest first; a complete one downloads as one
  // .tar.gz. Owner only, as the whole dashboard is (its session is the owner's).
  app.get("/ui/exports", (c) => {
    const vs = views();
    const all = store.exports.all(1000);
    const rig = c.req.query("rig") || undefined;
    const rigs = [...new Set([...all.map((e) => e.rig), ...vs.map((u) => u.id)])].sort();
    if (rig && !rigs.includes(rig)) rigs.push(rig);
    return page(
      c,
      {
        title: "Exports",
        summary: rig
          ? `the exports <a href="/ui/rigs/${encodeURIComponent(rig)}">${esc(rig)}</a> sent to control, newest first`
          : "the exports rigs sent to control, newest first",
        active: "exports",
      },
      exportsBody({
        exports: all,
        rigs,
        rig,
        kept: opts.exportFiles !== undefined,
        now: Date.now(),
      }),
      vs,
    );
  });
  app.get("/ui/exports/:rig/:name/archive", (c) =>
    archiveResponse(
      c,
      { store, files: opts.exportFiles, by: "owner:ui" },
      c.req.param("rig"),
      c.req.param("name"),
    ),
  );

  app.get("/ui/reports", (c) => {
    const now = Date.now();
    const t = csrf(c);
    const act = (id: unknown, what: string, label2: string, primary = false) =>
      `<form class="inline" method="post" action="/ui/resets/${esc(id)}/${what}"><input type="hidden" name="csrf" value="${t}"><button class="sm${primary ? " primary" : ""}">${label2}</button></form>`;
    const resets = store.fullResets
      .list(20)
      .map(
        (r) =>
          `<tr><td><b>${esc(r.rig)}</b></td><td><span class="chip ${String(r.state) === "done" ? "ok" : String(r.state) === "failed" ? "bad" : "warn"}">${esc(r.state)}</span></td><td class="clip">${esc(r.detail ?? "")}</td><td class="muted nowrap">${esc(ago(String(r.updated_at), now))} ago</td>
<td class="num">${String(r.state) === "awaiting_owner" ? act(r.id, "confirm", "Confirm the wipe", true) : ""} ${["start", "quiescing", "exporting", "verifying", "awaiting_owner"].includes(String(r.state)) ? act(r.id, "cancel", "Cancel") : ""}</td></tr>`,
      )
      .join("");
    const rows = store.rigReports
      .list(30)
      .map(
        (r) =>
          `<div class="card"><div class="card-head">${avatar(r.rig)}<span class="title">${esc(r.rig)}</span><span class="sub">${esc(r.kind)} report</span><span class="right muted small">${esc(ago(r.at, now))} ago</span></div><pre class="report" style="margin-top:10px">${esc(r.body)}</pre></div>`,
      )
      .join("");
    return page(
      c,
      {
        title: "Reports",
        summary: "daily reports from each rig's supervisor, and full resets",
        active: "reports",
      },
      `${resets ? `<div class="block"><div class="head"><h2>Full resets</h2></div><div class="card flat"><table><thead><tr><th>Rig</th><th>State</th><th>Detail</th><th>Updated</th><th></th></tr></thead><tbody>${resets}</tbody></table></div></div>` : ""}
<div class="block"><div class="head"><h2>Daily reports</h2></div>${rows || `<div class="card"><div class="empty">No daily report yet.</div></div>`}</div>`,
    );
  });
}
