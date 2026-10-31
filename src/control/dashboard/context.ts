import { createHash, createHmac } from "node:crypto";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { buildInfo } from "../../common/build-info.ts";
import { sameSecret } from "../../common/secrets.ts";
import { McpServers } from "../mcp-servers/index.ts";
import type { PageOptions } from "../pages.ts";
import { ChatGPTLogins } from "../providers/index.ts";
import { RigUpdates } from "../rigs/index.ts";
import { SESSION_DAYS } from "../settings.ts";
import type { ControlStore } from "../store/index.ts";
import { infoLabel } from "../ui/campaigns/new/index.ts";
import { esc, NAV_COOKIE, type Shell, shell } from "../ui/components/index.ts";
import { type Forms, type Need, needs as operatorNeeds } from "../ui/operator/index.ts";
import {
  OFFLINE_AFTER_MS,
  type RigView,
  type RunOnRig,
  type RunView,
  runCampaign,
} from "../views/index.ts";

const DAY_MS = 24 * 3_600_000;
/** What Close run does, in its ⋯ menu on a run's page (goal 087). */
const CLOSE_RUN_WORDS =
  "The run ends for good: nothing more starts, and it can't be resumed. Its results stay.";
const CLOSE_WHY_TIP =
  "Why you close the run, up to 500 characters. The run keeps it: it shows wherever the run's state does, in its History and in the rig's export.";
// biome-ignore lint/suspicious/noExplicitAny: any route's context
export type Ctx = Context<any, any, any>;

/** What control gives its dashboard (control/pages.ts). */
export type DashboardOptions = PageOptions;

/** A session's ID as control's store keeps it: hashed. */
export const hashOf = (sid: string) => createHash("sha256").update(sid).digest("hex");
/** A run's campaign, as the views name it (a run without one is its own). */
export const campaignOfRun = (vs: RigView[], rig: string, run: string) => {
  const r = vs.find((u) => u.id === rig)?.runs.find((x) => x.id === run);
  return r ? runCampaign(r) : undefined;
};
/** Where a page's forms in the navigation return: the page, without the notes it showed. */
const backHere = (c: Ctx) => {
  const u = new URL(c.req.url);
  for (const k of ["sent", "error", "on", "ok"]) u.searchParams.delete(k);
  return `${u.pathname}${u.search}`;
};
/** Where a form returns: a path under /ui only (never another site). */
export const backTo = (f: Record<string, unknown>, fallback: string) => {
  const b = String(f.back ?? "");
  return b.startsWith("/ui") && !b.startsWith("//") ? b : fallback;
};
/** Whether the page's script sent the form, asking for JSON to follow the action (goal 080). */
export const wantsJson = (c: Ctx) => (c.req.header("accept") ?? "").includes("application/json");

/**
 * What the dashboard's sections share, made once by createDashboard: control's store, its parts
 * and the options; the session and CSRF helpers; the rigs' views; the command forms; what waits
 * for the owner; and the page shell. Each section (a module of this folder) takes what it needs.
 */
export function dashboardContext(store: ControlStore, opts: DashboardOptions) {
  const chatgpt = opts.chatgpt ?? new ChatGPTLogins(store, opts.secrets, opts.providerFetch);
  const mcpServers = opts.mcpServers ?? new McpServers(store, opts.secrets);
  // Control's own build, which each rig's is compared with, and the window after which a rig
  // that does not report is offline.
  const control = opts.control ?? buildInfo();
  const offlineAfterMs = Math.max(opts.offlineAfterMs ?? OFFLINE_AFTER_MS, opts.staleAfterMs);
  // Update to control's version, from a rig's page: each runs on in the background.
  const updates =
    opts.rigUpdates ??
    new RigUpdates({
      store,
      privateKeyPem: opts.privateKeyPem,
      control,
      staleAfterMs: opts.staleAfterMs,
      offlineAfterMs: opts.offlineAfterMs,
    });
  updates.endUnfinished();
  // Keyed by control's own signing key and the owner's credential: stable across restarts, void
  // once the token changes, and not derivable from the token's hash alone (which is not secret).
  const tokenKey = createHash("sha256")
    .update(`thermite-ui\0${opts.privateKeyPem}\0${opts.admin.hex}`)
    .digest();
  const tokenFp = createHmac("sha256", tokenKey).update("session-fingerprint").digest("hex");
  const csrfOf = (sid: string) =>
    createHmac("sha256", tokenKey).update(`csrf\0${sid}`).digest("hex");
  const sessionMs = (opts.sessionDays ?? SESSION_DAYS) * DAY_MS;
  const cookie = (c: Ctx, sid: string) =>
    setCookie(c, "thermite_session", sid, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/ui",
      maxAge: Math.floor(sessionMs / 1000),
      // Behind a proxy that ends TLS, the proxy's header says the owner's side is HTTPS.
      secure:
        new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https",
    });
  const sessionOf = (c: Ctx) => {
    const sid = getCookie(c, "thermite_session");
    if (!sid) return undefined;
    const s = store.uiSessions.get(hashOf(sid));
    const now = Date.now();
    if (!s || s.expiresAt <= now || !sameSecret(s.tokenFp, tokenFp)) return undefined;
    // Renewed at most once a day, so a session in use does not run out.
    if (s.expiresAt - now < sessionMs - DAY_MS) {
      store.uiSessions.extend(hashOf(sid), now + sessionMs);
      cookie(c, sid);
    }
    return sid;
  };
  const csrf = (c: Ctx) => csrfOf(sessionOf(c) ?? "");
  const parts = opts.parts;
  const views = parts.views;
  /**
   * A run of a campaign wherever it ran (goal 170), earlier runs too: undefined for a run no rig
   * created, or one of another campaign.
   */
  const runOf = async (campaign: string, run: string): Promise<RunOnRig | undefined> => {
    const x = await parts.run(run);
    return x && runCampaign(x.run) === campaign ? x : undefined;
  };
  /** A form that issues a command; `back` is where the owner lands afterwards. */
  const cmdForm = (
    c: Ctx,
    f: {
      rig: string;
      kind: string;
      fields?: Record<string, string>;
      label: string;
      cls?: string;
      back?: string;
      extra?: string;
      /** Off while what it sent waits for the rig (a check's Sent, Running…). */
      disabled?: boolean;
    },
  ) =>
    `<form class="inline" method="post" action="/ui/commands"><input type="hidden" name="csrf" value="${csrf(c)}"><input type="hidden" name="rig" value="${esc(f.rig)}"><input type="hidden" name="kind" value="${esc(f.kind)}">${Object.entries(
      f.fields ?? {},
    )
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
      .join(
        "",
      )}${f.back ? `<input type="hidden" name="back" value="${esc(f.back)}">` : ""}${f.extra ?? ""}<button class="${f.cls ?? ""}"${f.disabled ? " disabled" : ""}>${esc(f.label)}</button></form>`;

  /** Pause, with an optional reason the run keeps (it shows wherever the run's state does). */
  const pauseMenu = (c: Ctx, rig: string, run: string, back: string, cls = "") =>
    `<details class="menu"><summary class="btn${cls ? ` ${cls}` : ""}">Pause</summary><div class="menu-pop">${cmdForm(c, { rig, kind: "pause_run", fields: { run }, label: "Pause the run", cls: "sm", back, extra: `<input name="reason" maxlength="500" placeholder="why (optional)" aria-label="Why" style="width:100%;margin-bottom:6px">` })}<div class="muted small">The lanes' running trials stop and no new ones start. Its jobs waiting for the judge wait until you resume, so the judge's time goes to running runs. Resume picks up from the same champion.</div></div></details>`;
  /**
   * Close run (goal 087): the owner's reason, what closing does, and a typed confirmation, as
   * Retire and Full reset ask for. Control checks the typed words too (/ui/commands).
   */
  const closeForm = (c: Ctx, rig: string, run: string, back: string) =>
    `<form method="post" action="/ui/commands" class="stack close-run"><input type="hidden" name="csrf" value="${csrf(c)}"><input type="hidden" name="rig" value="${esc(rig)}"><input type="hidden" name="kind" value="close_run"><input type="hidden" name="run" value="${esc(run)}"><input type="hidden" name="back" value="${esc(back)}"><div class="small"><b>Close run.</b> <span class="muted">${CLOSE_RUN_WORDS}</span></div><label>${infoLabel("Why", CLOSE_WHY_TIP)}<input name="reason" required maxlength="500" placeholder="such as: another run finished the work"></label><input name="confirm" placeholder="type: close ${esc(run)}" data-confirm="close ${esc(run)}" aria-label="Type close ${esc(run)} to confirm"><button class="danger">Close the run</button></form>`;
  /**
   * ⋯ in a run's header: Restart the lanes, for a running run with agents (the run's header and
   * Live's), and, with `close` (the run's page), Close run for a run not closed yet (goal 087).
   */
  const moreMenu = (c: Ctx, rig: string, r: RunView, back: string, cls = "", close = false) => {
    const restart =
      r.status === "running" && r.has_agents !== false
        ? `${cmdForm(c, { rig, kind: "reset_workers", fields: { run: r.id }, label: "Restart the lanes", cls, back })}<div class="muted small">Ends the lanes' running trials now and the current round: every lane starts again from the champion. Nothing the judge decided is lost.</div>`
        : "";
    const closing = close && r.status !== "closed" ? closeForm(c, rig, r.id, back) : "";
    if (!restart && !closing) return "";
    return `<details class="menu"><summary class="btn${cls ? ` ${cls}` : ""}" title="More">⋯</summary><div class="menu-pop">${restart}${restart && closing ? `<div class="divider" style="margin:2px 0"></div>` : ""}${closing}</div></details>`;
  };
  const forms = (c: Ctx): Forms => ({
    cmd: (f) => cmdForm(c, f),
    csrf: csrf(c),
  });
  /**
   * Everything that waits for the owner, across rigs: the "Needs you" feed, with its evidence.
   * A decision already sent, and not refused, is left out at once; it comes back only if the
   * rig refuses it or the item needs the owner again.
   */
  const needs = (c: Ctx, vs: RigView[], now: number, back = "/ui"): Need[] =>
    operatorNeeds(store, vs, forms(c), now, back).filter((n) => !n.decided);
  /** The archived campaigns (goal 077): out of the navigation, Needs you and the Overview. */
  const archivedNames = () => new Set(store.archive.list().map((a) => a.campaign));
  /** Leaves out what belongs to an archived campaign's runs: for Needs you and the lists. */
  const notArchived = <T extends { rig: string; run?: string | undefined }>(
    vs: RigView[],
    xs: T[],
    archived = archivedNames(),
  ) =>
    archived.size
      ? xs.filter((x) => !x.run || !archived.has(campaignOfRun(vs, x.rig, x.run) ?? ""))
      : xs;
  /**
   * The page shell with the navigation's campaigns and their folders, collapsed to its icons when
   * this browser keeps it so (NAV_COOKIE).
   */
  const page = (
    c: Ctx,
    s: Omit<Shell, "rigs" | "needs" | "now" | "rail">,
    body: string,
    vs = views(),
  ) => {
    const now = Date.now();
    // A command just sent from this page (POST /ui/commands): say so at the top.
    const sent = c.req.query("sent");
    // What a folder's form or Archive refused (on=shelf): at the top, in words.
    const shelfError = c.req.query("on") === "shelf" ? c.req.query("error") : undefined;
    if (shelfError) {
      const [head, ...rest] = shelfError.split(/(?<=\.) /);
      body = `<div class="card warn" style="margin-bottom:16px"><b class="bad">${esc(head)}</b> ${esc(rest.join(" "))}</div>${body}`;
    } else if (sent)
      body = `<div class="card sent-note" style="margin-bottom:16px"><b class="ok">${esc(sent)}</b></div>${body}`;
    const archived = archivedNames();
    const path = new URL(c.req.url).pathname;
    const current = path.startsWith("/ui/campaigns/")
      ? decodeURIComponent(path.slice("/ui/campaigns/".length).split("/")[0] ?? "")
      : undefined;
    return c.html(
      shell(
        {
          ...s,
          rigs: vs,
          needs: notArchived(
            vs,
            needs(c, vs, now).filter((n) => n.kind !== "stale"),
            archived,
          ).length,
          now,
          rail: getCookie(c, NAV_COOKIE) === "rail",
          nav: {
            folders: store.folders.list(),
            archived,
            csrf: csrf(c),
            back: backHere(c),
            current,
          },
        },
        body,
      ),
    );
  };
  /** Control's SSH to the machines it sets rigs up on. */
  const ssh = parts.machineSsh;
  /**
   * Words from another program's error (ssh, git, kubectl, a GPU cloud, an MCP server), kept on
   * control for the page a form returns to: the address carries their ID (notes.ts).
   */
  const noted = (text: string) => parts.notes.put(text);
  /** Why a form failed, from the page's address: the words a note's ID names, or those given. */
  const said = (c: Ctx, key = "error") => parts.notes.read(c.req.query(key));
  return {
    store,
    opts,
    chatgpt,
    mcpServers,
    control,
    offlineAfterMs,
    updates,
    tokenFp,
    csrfOf,
    sessionMs,
    cookie,
    sessionOf,
    csrf,
    parts,
    views,
    runOf,
    cmdForm,
    pauseMenu,
    moreMenu,
    forms,
    needs,
    archivedNames,
    notArchived,
    page,
    ssh,
    noted,
    said,
  };
}

/** The dashboard's context: what its sections share (dashboardContext). */
export type Dashboard = ReturnType<typeof dashboardContext>;
