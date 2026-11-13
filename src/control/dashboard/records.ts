import type { Hono } from "hono";
import { errorText, Refusal } from "../../common/errors.ts";
import {
  archiveResponse,
  deleteExports,
  type ExportRef,
  exportsToDelete,
  stillReceiving,
} from "../exports.ts";
import { AUDIT_ACTORS, AUDIT_KINDS, cursorOf } from "../store/index.ts";
import { AUDIT_DEFAULT_KINDS, AUDIT_PAGE, type AuditQuery, auditBody } from "../ui/audit.ts";
import { avatar, esc, icon, meter, pct, valuesPairWords } from "../ui/components/index.ts";
import { exportRun, exportsBody, exportsHref, pickedExport } from "../ui/exports.ts";
import { reportsBody, reportsQuery } from "../ui/reports.ts";
import { runHref } from "../ui/urls.ts";
import { leaderboard } from "../views/index.ts";
import { backTo, type Dashboard } from "./context.ts";

/** The Audit log (with the commands), Leaderboard, Exports (goal 103) and Reports pages. */
export function recordRoutes(app: Hono, dash: Dashboard): void {
  const { csrf, opts, page, said, store, views } = dash;

  // ---------------------------------------------------------------- commands, audit, leaderboard, reports
  // The Commands page is the audit log's commands now (goal 181).
  app.get("/ui/commands", (c) => c.redirect("/ui/audit?type=command", 302));

  // The audit log (goals 015 and 181): AUDIT_PAGE entries a page, newest first, filtered by kind,
  // by who and by rig, with the commands' delivery and outcome. MCP calls only when asked for.
  app.get("/ui/audit", async (c) => {
    const now = Date.now();
    const many = (k: string) => (c.req.queries(k) ?? []).filter(Boolean);
    const query: AuditQuery = {
      type: many("type").filter((k) => (AUDIT_KINDS as readonly string[]).includes(k)),
      who: many("who").filter((k) => (AUDIT_ACTORS as readonly string[]).includes(k)),
      rig: many("rig"),
      q: c.req.query("q") ?? "",
      before: cursorOf(c.req.query("before")),
      after: cursorOf(c.req.query("after")),
    };
    const filter = {
      kinds: query.type.length ? query.type : AUDIT_DEFAULT_KINDS,
      actors: query.who,
      rigs: query.rig,
      words: query.q,
    };
    const p = await store.auditLog.page(
      AUDIT_PAGE,
      filter,
      query.before !== undefined ? { before: query.before } : { after: query.after },
    );
    const first = p.entries[0]?.id;
    const vs = await views();
    const rigs = [...new Set([...vs.map((u) => u.id), ...query.rig])].sort();
    return page(
      c,
      { title: "Audit log", summary: "who did what through control", active: "audit" },
      await auditBody({
        entries: p.entries,
        query,
        rigs,
        command: async (id) => store.commands.row(id),
        from: first === undefined ? 0 : (await store.auditLog.count(filter, first)) + 1,
        total: await store.auditLog.count(filter),
        older: p.older,
        newer: p.newer,
        now,
      }),
      vs,
    );
  });

  app.get("/ui/leaderboard", async (c) => {
    const board = await leaderboard(store, { staleAfterMs: opts.staleAfterMs });
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
  // .tar.gz. Owner only, as the whole dashboard is (its session is the owner's). Delete, with the
  // exports ticked (`pick`), shows their confirmation at the top; its form deletes them.
  const files = opts.exportFiles;
  app.get("/ui/exports", async (c) => {
    const vs = await views();
    const now = Date.now();
    const all = await store.exports.all(1000);
    const many = (k: string) => (c.req.queries(k) ?? []).filter(Boolean);
    const at = Number(c.req.query("at"));
    const query = {
      rig: many("rig"),
      kind: many("kind"),
      campaign: many("campaign"),
      q: c.req.query("q") ?? "",
      at: Number.isInteger(at) && at > 0 ? at : 0,
    };
    const rigs = [
      ...new Set([...all.map((e) => e.rig), ...vs.map((u) => u.id), ...query.rig]),
    ].sort();
    // Each export's campaign, read once: the page's filters and rows ask for it many times.
    const campaigns = new Map<(typeof all)[number], string | undefined>();
    for (const e of all) {
      const run = exportRun(e);
      const campaign = run ? await store.runRegistry.campaignOf(run, e.rig) : undefined;
      campaigns.set(e, campaign ?? undefined);
    }
    const campaignOf = (e: (typeof all)[number]) => campaigns.get(e);
    const rig = query.rig.length === 1 ? query.rig[0] : undefined;
    let confirm: Parameters<typeof exportsBody>[0]["confirm"];
    if (c.req.query("delete")) {
      const refs = (c.req.queries("pick") ?? []).flatMap((v) => pickedExport(v) ?? []);
      try {
        confirm = { ...(await exportsToDelete({ store, files }, refs, now)), refused: undefined };
      } catch (err) {
        if (!(err instanceof Refusal)) throw err;
        confirm = { found: [], gone: [], refused: errorText(err) };
      }
    }
    const error = said(c);
    return page(
      c,
      {
        title: "Exports",
        summary: rig
          ? `the exports <a href="/ui/rigs/${encodeURIComponent(rig)}">${esc(rig)}</a> sent to control, newest first`
          : "the exports rigs sent to control, newest first",
        active: "exports",
      },
      `${error ? `<div class="card warn" style="margin-bottom:12px"><b class="bad">Not deleted.</b> ${esc(error)}</div>` : ""}${exportsBody(
        {
          exports: all,
          rigs,
          campaignOf,
          query,
          kept: files !== undefined,
          now,
          csrf: csrf(c),
          receiving: (e) => stillReceiving(files, e, now),
          confirm,
        },
      )}`,
      vs,
    );
  });
  app.post("/ui/exports/delete", async (c) => {
    const f = await c.req.parseBody({ all: true });
    const back = backTo(f, exportsHref());
    const refs: ExportRef[] = [f.export ?? []].flat().flatMap((v) => pickedExport(v) ?? []);
    const to = (key: "sent" | "error", words: string) => {
      const u = new URL(back, "http://control");
      u.searchParams.set(key, words);
      return c.redirect(`${u.pathname}${u.search}`, 303);
    };
    if (!refs.length) return to("error", "Tick one or more exports, then press Delete.");
    try {
      return to("sent", (await deleteExports({ store, files }, refs, "owner:ui")).said);
    } catch (err) {
      if (!(err instanceof Refusal)) throw err;
      return to("error", errorText(err));
    }
  });
  app.get("/ui/exports/:rig/:name/archive", async (c) =>
    archiveResponse(
      c,
      { store, files: opts.exportFiles, by: "owner:ui" },
      c.req.param("rig"),
      c.req.param("name"),
    ),
  );

  // Reports (goal 181): what each finished run produced, newest first.
  app.get("/ui/reports", async (c) => {
    const vs = await views();
    const query = reportsQuery(
      (k) => c.req.query(k),
      (k) => (c.req.queries(k) ?? []).filter(Boolean),
    );
    return page(
      c,
      { title: "Reports", summary: "what each finished run produced", active: "reports" },
      reportsBody({ views: vs, query }),
      vs,
    );
  });
}
