import type { Hono } from "hono";
import { KB_SETTING_WORDS, kbSettingsOf, setKbSettings } from "../../kb/index.ts";
import type { ControlStore } from "../../store/index.ts";
import { infoLabel } from "../../ui/campaigns/new/index.ts";
import { ago, esc } from "../../ui/components/index.ts";
import type { Dashboard } from "../context.ts";

/**
 * Settings › Knowledge base: the knowledge base's settings on control (control/kb/settings.ts),
 * the largest file it takes and how long a file no item names stays, in one form that says what
 * Save does before it is pressed.
 */

/** Back to Settings, with what happened said in this block (at=kb). */
const kbUrl = (k: "ok" | "error", m: string) =>
  `/ui/settings?${k}=${encodeURIComponent(m)}&at=kb#kb`;

/** A field's value as the form shows it: empty for its default. */
const shown = (n: number | null) => (n === null ? "" : String(n));

/** The block, with what its form did when the page came back to it. */
export function kbSettingsBlock(
  store: ControlStore,
  orphanHoursDefault: number,
  t: string,
  now: number,
  q: (k: string) => string | undefined,
): string {
  const s = kbSettingsOf(store, orphanHoursDefault);
  const said = q("at") === "kb" ? (q("error") ?? q("ok")) : undefined;
  const note = said
    ? q("error")
      ? `<div class="card warn" style="margin-bottom:10px"><b class="bad">Not saved.</b> ${esc(said)}</div>`
      : `<div class="card" style="margin-bottom:10px"><b class="ok">${esc(said)}</b></div>`
    : "";
  const hoursDefault = `${orphanHoursDefault} (THERMITE_CONTROL_KB_ORPHAN_HOURS)`;
  const last = s.set_by && s.set_at ? `set by ${esc(s.set_by)} ${esc(ago(s.set_at, now))} ago` : "";
  return `<div class="block" id="kb"><div class="head"><h2>Knowledge base</h2><span class="right">its files: the largest it takes, and how long an orphan stays</span></div>${note}<div class="card">
<p class="small" style="margin-top:0">The knowledge base keeps each file once, with its text searched when it is Markdown, plain text, a web page or a PDF. It takes files of any size, and keeps every file for good, unless you set otherwise here.</p>
<form method="post" action="/ui/settings/kb" class="form-grid" autocomplete="off"><input type="hidden" name="csrf" value="${t}">
<label>${infoLabel("Largest file, in MiB", KB_SETTING_WORDS.max_file_mib)}<input name="max_file_mib" inputmode="decimal" maxlength="20" value="${esc(shown(s.max_file_mib || null))}" placeholder="no limit"></label>
<label>${infoLabel("Orphan files kept, in hours", KB_SETTING_WORDS.orphan_hours)}<input name="orphan_hours" inputmode="decimal" maxlength="20" value="${esc(shown(s.orphan_hours_from === "setting" ? s.orphan_hours : null))}" placeholder="${esc(hoursDefault)}"></label>
<div class="form-end"><span class="muted small">Save keeps both. A limit applies to the files that come from then on. Control looks for orphan files at its start and every hour.${last ? ` <span class="muted xs">${last}</span>` : ""}</span><button>Save the settings</button></div></form></div></div>`;
}

/** A field as the form gives it: empty is its default (null); else a number of 0 or more. */
function fieldOf(raw: unknown, label: string): number | null | string {
  const text = String(raw ?? "").trim();
  if (text === "") return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? n : `${label} takes a number, 0 or more, not "${text}".`;
}

/** The block's form: both settings saved at once. */
export function kbSettingsRoutes(app: Hono, dash: Dashboard): void {
  const { store, opts } = dash;
  app.post("/ui/settings/kb", async (c) => {
    const f = await c.req.parseBody();
    const max = fieldOf(f.max_file_mib, "Largest file");
    const hours = fieldOf(f.orphan_hours, "Orphan files kept");
    const bad = [max, hours].find((v) => typeof v === "string");
    if (typeof bad === "string") return c.redirect(kbUrl("error", bad), 303);
    const o = setKbSettings(
      store,
      { max_file_mib: max, orphan_hours: hours },
      opts.kbFiles?.orphanHoursDefault ?? 0,
      "owner:ui",
    );
    return c.redirect(o.ok ? kbUrl("ok", o.said) : kbUrl("error", o.error), 303);
  });
}
