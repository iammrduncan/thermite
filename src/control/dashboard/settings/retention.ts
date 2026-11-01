import type { Hono } from "hono";
import { errorText } from "../../../common/errors.ts";
import {
  DAYS,
  dayWords,
  firstRunWords,
  type KeepKey,
  kindOf,
  NEVER_REMOVED,
  onRigs,
  perRig,
  RETENTION_KIND_KEYS,
  type RetentionKind,
  type RetentionSpec,
  type RetentionSpecInput,
  removeWords,
  specPart,
} from "../../../core/retention/index.ts";
import { sizeWords } from "../../../core/words.ts";
import {
  createPolicy,
  deletePolicy,
  itemsOf,
  type PolicyPreview,
  type PolicyView,
  policyOf,
  policyViews,
  previewOf,
  runPolicy,
  setPolicyOn,
  specOf,
  updatePolicy,
} from "../../retention/index.ts";
import type { ControlStore, RetentionRemovalRow } from "../../store/index.ts";
import { esc, infoLabel } from "../../ui/components/index.ts";
import { RETENTION_JS } from "../../ui/retention.ts";
import type { Dashboard } from "../context.ts";

/**
 * Settings › Retention policies (core/retention/, control/retention/): beside Space, the
 * owner's policies, each with its switch, what it would remove now, Run now (asked first, in the
 * page), Edit and Delete; the form for a new or changed policy, whose If it ran now follows the
 * design as it changes; what no policy removes; and what the policies removed. With no policy,
 * Thermite keeps everything, everywhere.
 */

/** Each label's ⓘ on the form, in the approved mockup's words. */
export const RETENTION_TIPS = {
  name: "A name for you, shown in the list, the Space table and the audit log.",
  kind: "One kind of thing Thermite keeps. Each kind shows the space it takes now. Rigs' ledgers, results repositories and exports are not in the list: no policy removes them.",
  where:
    "Which rigs it acts on. A campaign means every rig that runs it. Kinds kept on control alone have no choice here.",
  rule: "What it removes, of the kind and place above. Older than: by age. Beyond the newest: keeps a number and removes the rest. Over a size: removes the oldest until what is left fits.",
  keep: "What this policy never removes, even when the rule covers it. On by default.",
  when: "When it runs once turned on. Only by hand: it runs only when you press Run now. Times are UTC, as everywhere on control.",
  preview:
    "Worked out from what is kept now. It changes as you change the rule. Nothing is removed until the policy is on and its time comes, or you press Run now.",
} as const;

/** Back to Settings' policies, with what happened said there. */
const backUrl = (k: "ok" | "error", m: string, more = "") =>
  `/ui/settings?${k}=${encodeURIComponent(m)}&at=retention${more}#retention`;

/** What a policy's preview says of rigs that have not told control what they keep. */
const unreportedWords = (p: PolicyPreview) =>
  p.unreported.length
    ? `${p.unreported.join(", ")} ${p.unreported.length > 1 ? "have" : "has"} not said what ${p.unreported.length > 1 ? "they keep" : "it keeps"} yet: not counted.`
    : "";

/** Who started a removal, as the history says it. */
const byWords = (by: string) => (by === "schedule" ? "its schedule" : "you, Run now");

/** Each kind's items now, everywhere, for the form's list: their count and bytes. */
function kindSizes(store: ControlStore): Map<RetentionKind, { count: number; bytes: number }> {
  return new Map(
    RETENTION_KIND_KEYS.map((kind) => {
      const { items } = itemsOf(store, { kind, where: "all", rigs: [], campaigns: [] });
      const count = items.reduce((n, x) => n + x.count, 0);
      return [kind, { count, bytes: items.reduce((n, x) => n + x.bytes, 0) }] as const;
    }),
  );
}

/** A new policy's design before the owner changes it: as the mockup starts it. */
const blankSpec = (): RetentionSpec => ({
  name: "",
  kind: "builds",
  where: "all",
  rigs: [],
  campaigns: [],
  rule: "older",
  older_n: 30,
  older_unit: "days",
  newest_n: 20,
  newest_per: "rig",
  size_gib: 50,
  keep: { open: true, champions: true, newest: true },
  when: "daily",
  time: "03:00",
  day: "sunday",
});

/** A radio button group, drawn as one segmented control. */
function seg(name: string, value: string, opts: [string, string][], label: string): string {
  return `<fieldset class="rt-seg" aria-label="${esc(label)}">${opts.map(([v, w]) => `<label><input type="radio" name="${name}" value="${v}"${v === value ? " checked" : ""}><span>${esc(w)}</span></label>`).join("")}</fieldset>`;
}

/** The form for a new policy or a change to one; `spec` is what it shows. */
function policyForm(
  store: ControlStore,
  t: string,
  spec: RetentionSpec & { id?: number | undefined },
  sizes: Map<RetentionKind, { count: number; bytes: number }>,
  preview: PolicyPreview | undefined,
  now: Date,
): string {
  const kinds = (["control", "rigs", "supervisors"] as const)
    .map(
      (on) =>
        `<optgroup label="Kept on ${on}">${RETENTION_KIND_KEYS.filter((k) => kindOf(k).on === on)
          .map(
            (k) =>
              `<option value="${k}"${k === spec.kind ? " selected" : ""}>${esc(kindOf(k).label)} — ${esc(sizeWords(sizes.get(k)?.bytes ?? 0))}</option>`,
          )
          .join("")}</optgroup>`,
    )
    .join("");
  const info = RETENTION_KIND_KEYS.map((k) => {
    const s = sizes.get(k) ?? { count: 0, bytes: 0 };
    const kk = kindOf(k);
    return `<div class="rt-kindinfo" data-kind-info="${k}"${k === spec.kind ? "" : " hidden"}>${esc(kk.words)} Kept on: ${esc(kk.on)}. ${s.count.toLocaleString("en-US")} ${esc(kk.unit)} now, ${esc(sizeWords(s.bytes))}.${kk.warn ? `<div class="card warn rt-warn">${esc(kk.warn)}</div>` : ""}</div>`;
  }).join("");
  const rigs = store.reportedRigs
    .list()
    .map((r) => r.id)
    .filter((r) => !store.retired.get(r));
  const campaigns = [...new Set(store.campaigns.versions().map((v) => v.campaign))].sort();
  const picks = (name: "rigs" | "campaigns", all: string[], chosen: string[]) =>
    all.length
      ? all
          .map(
            (x) =>
              `<label><input type="checkbox" name="${name}" value="${esc(x)}"${chosen.includes(x) ? " checked" : ""}> ${esc(x)}</label>`,
          )
          .join("")
      : `<span class="muted small">None yet.</span>`;
  const forRigs = perRig(spec.kind);
  const keeps = (["champions", "open", "newest"] as KeepKey[])
    .map((key) => {
      const words = RETENTION_KIND_KEYS.map((k) => kindOf(k).keeps[key]).find(Boolean) ?? "";
      const own = kindOf(spec.kind).keeps[key];
      const kindsWith = RETENTION_KIND_KEYS.filter((k) => kindOf(k).keeps[key]);
      // The selected kind's words for what it keeps, else the first kind's that has it; the
      // page's script changes them with the kind (data-keep-words).
      return `<label data-keep="${key}"${own ? "" : " hidden"}><input type="checkbox" name="keep_${key}" value="1"${spec.keep[key] ? " checked" : ""}> <span data-keep-words='${esc(JSON.stringify(Object.fromEntries(kindsWith.map((k) => [k, kindOf(k).keeps[key]]))))}'>${esc(own ?? words)}</span></label>`;
    })
    .join("");
  const hasKeeps = Object.keys(kindOf(spec.kind).keeps).length > 0;
  const field = (label: string, body: string, attrs = "") =>
    `<div class="rt-field"${attrs}><div class="rt-lab">${label}</div><div class="rt-ctl">${body}</div></div>`;
  const p = preview;
  return `<div class="card" id="rt-form-card"><form method="post" action="/ui/settings/retention" id="rt-form" class="rt-form" data-preview="/ui/settings/retention/preview" autocomplete="off">
<input type="hidden" name="csrf" value="${t}">${spec.id ? `<input type="hidden" name="policy" value="${spec.id}">` : ""}
<div class="rt-head"><h3>${spec.id ? "Edit policy" : "New policy"}</h3><span class="muted small">Saved policies show on the Space table beside what they remove.</span></div>
${field(`<label for="rt-name">${infoLabel("Name", RETENTION_TIPS.name)}</label>`, `<input type="text" id="rt-name" name="name" maxlength="80" value="${esc(spec.name)}" placeholder="e.g. Old builds">`)}
${field(`<label for="rt-kind">${infoLabel("What it removes", RETENTION_TIPS.kind)}</label>`, `<select id="rt-kind" name="kind">${kinds}</select>${info}`)}
${field(
  infoLabel("Where", RETENTION_TIPS.where),
  `<div data-for-rigs${forRigs ? "" : " hidden"}>${seg(
    "where",
    spec.where,
    [
      ["all", "Every rig"],
      ["rigs", "These rigs"],
      ["campaigns", "These campaigns"],
    ],
    "Where",
  )}<div class="rt-picks" data-where="rigs"${spec.where === "rigs" ? "" : " hidden"}>${picks("rigs", rigs, spec.rigs)}</div><div class="rt-picks" data-where="campaigns"${spec.where === "campaigns" ? "" : " hidden"}>${picks("campaigns", campaigns, spec.campaigns)}</div></div><span class="muted small" data-for-control${forRigs ? " hidden" : ""}>Control only.</span>`,
)}
${field(
  infoLabel("Rule", RETENTION_TIPS.rule),
  `${seg(
    "rule",
    spec.rule,
    [
      ["older", "Older than"],
      ["newest", "Beyond the newest"],
      ["size", "Over a size"],
    ],
    "Rule",
  )}
<div class="rt-row" data-rule="older"${spec.rule === "older" ? "" : " hidden"}>Remove what is older than <input type="number" min="1" name="older_n" value="${spec.older_n}" aria-label="How many"> <select name="older_unit" aria-label="Days, weeks or months">${["days", "weeks", "months"].map((u) => `<option${u === spec.older_unit ? " selected" : ""}>${u}</option>`).join("")}</select></div>
<div class="rt-row" data-rule="newest"${spec.rule === "newest" ? "" : " hidden"}>Keep the newest <input type="number" min="1" name="newest_n" value="${spec.newest_n}" aria-label="How many"> <select name="newest_per" data-for-rigs${forRigs ? "" : " hidden"} aria-label="Per rig, per run or in all">${[
    ["rig", "per rig"],
    ["run", "per run"],
    ["all", "in all"],
  ]
    .map(
      ([v, w]) => `<option value="${v}"${v === spec.newest_per ? " selected" : ""}>${w}</option>`,
    )
    .join("")}</select>, remove the rest</div>
<div class="rt-row" data-rule="size"${spec.rule === "size" ? "" : " hidden"}>Keep under <input type="number" min="0.001" step="any" name="size_gib" value="${spec.size_gib}" aria-label="GiB"> GiB<span data-for-rigs${forRigs ? "" : " hidden"}> in all</span>; the oldest go first</div>`,
)}
${field(infoLabel("Always keep", RETENTION_TIPS.keep), `<div class="rt-checks">${keeps}</div>`, ` data-keeps${hasKeeps ? "" : " hidden"}`)}
${field(
  infoLabel("When", RETENTION_TIPS.when),
  `${seg(
    "when",
    spec.when,
    [
      ["daily", "Every day"],
      ["weekly", "Every week"],
      ["hand", "Only by hand"],
    ],
    "When",
  )}<div class="rt-row" data-when="daily weekly"${spec.when === "hand" ? " hidden" : ""}><span data-when="weekly"${spec.when === "weekly" ? "" : " hidden"}>on <select name="day" aria-label="Day">${DAYS.map((d) => `<option value="${d}"${d === spec.day ? " selected" : ""}>${dayWords(d)}</option>`).join("")}</select></span> at <input type="time" name="time" value="${esc(spec.time)}" aria-label="Time, UTC"> UTC</div>`,
)}
${field(
  infoLabel("If it ran now", RETENTION_TIPS.preview),
  `<div class="rt-preview" id="rt-preview"><b data-big>${esc(p?.words ?? "It would remove nothing now.")}</b><span class="muted small" data-small>${esc(p ? `${p.stays}${unreportedWords(p) ? ` ${unreportedWords(p)}` : ""}` : "")}</span></div>`,
)}
<div class="form-end rt-foot"><button class="primary" name="save" value="on"${spec.name.trim() ? "" : ' disabled title="Give it a name first"'}>Save and turn on</button><button name="save" value="off"${spec.name.trim() ? "" : " disabled"}>Save, off</button><a class="btn" href="/ui/settings#retention">Cancel</a><span class="muted small" id="rt-first">${esc(firstRunWords(spec, now))}</span></div>
</form></div>`;
}

/** A policy's row in the list, with its Run now confirmation under it when asked. */
function policyRow(t: string, v: PolicyView, confirm: boolean): string {
  const r = v.would_remove;
  const last = v.last;
  const keep = v.keep_words ? `<div class="muted small">keeps: ${esc(v.keep_words)}</div>` : "";
  const runs = `${last ? `${esc(last.at.slice(0, 16).replace("T", " "))} UTC<div class="muted small">removed ${esc(sizeWords(last.bytes))}${last.rig ? ` on ${esc(last.rig)}` : ""}</div>` : `<span class="muted">never ran</span>`}<div class="muted small">would remove now: ${r.count ? esc(sizeWords(r.bytes)) : "nothing"}</div>`;
  const onTitle = v.on ? `On: runs ${v.when_words}` : "Off: removes nothing";
  const row = `<tr data-policy="${v.id}"><td><form method="post" action="/ui/settings/retention/${v.id}/on" class="inline"><input type="hidden" name="csrf" value="${t}"><label class="sw" title="${esc(onTitle)}"><input type="checkbox" name="on" value="1"${v.on ? " checked" : ""} data-autosubmit aria-label="Turn ${esc(v.name)} on or off"><span class="knob"></span></label><noscript><button class="sm">Save</button></noscript></form></td>
<td><b>${esc(v.name)}</b><div class="muted small">${esc(v.label)}</div></td><td>${esc(v.where_words)}</td><td>Removes ${esc(v.rule_words)}${keep}</td>
<td>${v.on ? esc(v.when_words) : `<span class="muted">off</span>`}</td><td>${runs}</td>
<td class="nowrap"><a class="btn sm" href="/ui/settings?retention=run&amp;policy=${v.id}#retention">Run now</a> <a class="btn sm" href="/ui/settings?retention=edit&amp;policy=${v.id}#retention">Edit</a> <form method="post" action="/ui/settings/retention/${v.id}/delete" class="inline"><input type="hidden" name="csrf" value="${t}"><button class="sm danger">Delete</button></form></td></tr>`;
  if (!confirm) return row;
  const ask = r.count
    ? `It removes ${esc(removeWords(v.kind, r))}${onRigs(v.kind) ? ", as its rigs last said; each rig removes what the policy covers when the command reaches it" : ""}. This can't be undone.${unreportedWords(r) ? ` ${esc(unreportedWords(r))}` : ""}`
    : `It would remove nothing now: everything it covers is inside the rule.${unreportedWords(r) ? ` ${esc(unreportedWords(r))}` : ""}`;
  const can = r.count > 0 || r.unreported.length > 0;
  return `${row}<tr class="rt-confirm-row"><td colspan="7"><div class="rt-confirm" id="rt-confirm"><b>Run “${esc(v.name)}” now?</b><span>${ask}</span><div class="act"><form method="post" action="/ui/settings/retention/${v.id}/run" class="inline"><input type="hidden" name="csrf" value="${t}"><button class="danger solid"${can ? "" : " disabled"}>Remove now</button></form><a class="btn" href="/ui/settings#retention">Cancel</a></div></div></td></tr>`;
}

/** What the policies removed, newest first. */
function removalsTable(rows: RetentionRemovalRow[]): string {
  if (!rows.length)
    return `<div class="empty"><span class="muted">Nothing removed yet.</span></div>`;
  return `<table class="ktable"><thead><tr><th>When</th><th>Policy</th><th>Removed</th><th class="num">Space freed</th><th>Started by</th></tr></thead><tbody>${rows
    .map(
      (x) =>
        `<tr data-removal="${x.id}"><td class="nowrap">${esc(x.at.slice(0, 16).replace("T", " "))} UTC</td><td>${esc(x.name)}</td><td>${esc(removeWords(x.kind, { ...x, rigs: x.rig ? 1 : 0 }))}${x.rig ? ` on ${esc(x.rig)}` : x.count ? " on control" : ""}${x.error ? `<div class="bad small">${esc(x.error)}</div>` : ""}</td><td class="num">${esc(sizeWords(x.bytes))}</td><td>${esc(byWords(x.by))}</td></tr>`,
    )
    .join("")}</tbody></table>`;
}

/** The newest removals the page shows. */
const REMOVALS_SHOWN = 50;

/**
 * The policies, the form when asked (`retention=new`, or `edit` with `policy`), Run now's
 * confirmation (`run` with `policy`), what no policy removes, and what the policies removed.
 */
export function retentionBlocks(
  store: ControlStore,
  t: string,
  q: (k: string) => string | undefined,
  draft: Record<string, unknown> | undefined,
  now = new Date(),
): string {
  const views = policyViews(store, now);
  const asked = q("retention");
  const id = Number(q("policy"));
  const said = q("at") === "retention" ? (q("error") ?? q("ok")) : undefined;
  const note = said
    ? q("error")
      ? `<div class="card warn"><b class="bad">Not done.</b> ${esc(said)}</div>`
      : `<div class="card"><b class="ok">${esc(said)}</b></div>`
    : "";
  let form = "";
  if (asked === "new" || (asked === "edit" && views.some((v) => v.id === id))) {
    const was = asked === "edit" ? policyOf(store, id) : undefined;
    const spec = { ...blankSpec(), ...specPart({ ...was, ...draft }), id: was?.id };
    let preview: PolicyPreview | undefined;
    try {
      const design = specPart({ ...spec, name: spec.name || "preview" });
      preview = previewOf(store, specOf(store, design), now);
    } catch {
      preview = undefined;
    }
    form = policyForm(store, t, spec as RetentionSpec, kindSizes(store), preview, now);
  }
  const list = views.length
    ? `<div class="card flat" style="overflow-x:auto"><table class="ktable"><thead><tr><th>On</th><th>Policy</th><th>Where</th><th>Rule</th><th>When</th><th>Runs</th><th></th></tr></thead><tbody>${views.map((v) => policyRow(t, v, asked === "run" && v.id === id)).join("")}</tbody></table></div>${form ? "" : `<div><a class="btn primary" href="/ui/settings?retention=new#retention">New policy</a></div>`}`
    : `<div class="card empty rt-empty"><b>No policy. Thermite keeps everything, everywhere.</b><span class="muted">A policy removes one kind of thing, where you say, by the rule you set, on the days you choose. Each is off until you turn it on, and shows what it would remove before it does.</span>${form ? "" : `<a class="btn primary" href="/ui/settings?retention=new#retention">New policy</a>`}</div>`;
  const never = NEVER_REMOVED.map(
    (n) =>
      `<div><b>${esc(n.label)}</b><span class="muted">${n.label === "Exports" ? `Removed only by hand, on the <a href="/ui/exports">Exports</a> page.` : esc(n.words)}</span></div>`,
  ).join("");
  return `<div class="block" id="retention"><div class="head"><h2>Retention policies</h2><span class="n">${views.length}</span><span class="right">each removes only what it says, where and when it says</span></div>${note}${list}${form}</div>
<div class="block" id="never-removed"><div class="head"><h2>Never removed by a policy</h2></div><div class="card rt-never">${never}</div></div>
<div class="block" id="removals"><div class="head"><h2>What policies removed</h2><span class="right">also in the audit log</span></div><div class="card flat" style="overflow-x:auto">${removalsTable(store.retention.removals(REMOVALS_SHOWN))}</div></div>
<script src="/ui/assets/retention.js" defer></script>`;
}

/** A form's fields as a policy's design (the form's names are the design's). */
function designOf(f: Record<string, string | File | (string | File)[]>): RetentionSpecInput {
  const one = (k: string) => {
    const v = f[k];
    return typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : "";
  };
  const all = (k: string) => {
    const v = f[k];
    return (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter(
      (x): x is string => typeof x === "string",
    );
  };
  const num = (k: string) => (one(k).trim() === "" ? undefined : Number(one(k)));
  return {
    name: one("name"),
    kind: one("kind") as RetentionKind,
    where: (one("where") || "all") as RetentionSpecInput["where"],
    rigs: all("rigs"),
    campaigns: all("campaigns"),
    rule: (one("rule") || "older") as RetentionSpecInput["rule"],
    older_n: num("older_n"),
    older_unit: (one("older_unit") || undefined) as RetentionSpecInput["older_unit"],
    newest_n: num("newest_n"),
    newest_per: (one("newest_per") || undefined) as RetentionSpecInput["newest_per"],
    size_gib: num("size_gib"),
    keep: {
      open: one("keep_open") === "1",
      champions: one("keep_champions") === "1",
      newest: one("keep_newest") === "1",
    },
    when: (one("when") || undefined) as RetentionSpecInput["when"],
    time: one("time") || undefined,
    day: (one("day") || undefined) as RetentionSpecInput["day"],
  };
}

export function retentionRoutes(app: Hono, dash: Dashboard): void {
  const { store, opts, parts } = dash;
  const by = "owner:ui";
  const deps = { store, privateKeyPem: opts.privateKeyPem };

  app.get("/ui/assets/retention.js", (c) =>
    c.body(RETENTION_JS, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );

  // The form's If it ran now, for its script: what the design would remove now.
  app.post("/ui/settings/retention/preview", async (c) => {
    const design = designOf(await c.req.parseBody({ all: true }));
    const now = new Date();
    try {
      const spec = specOf(store, { ...design, name: design.name || "preview" });
      const p = previewOf(store, spec, now);
      return c.json({
        ...p,
        unreported_words: unreportedWords(p),
        first: firstRunWords(spec, now),
      });
    } catch (err) {
      return c.json({ error: errorText(err) });
    }
  });

  // Save and turn on, or Save, off: a new policy, or the one the form names.
  app.post("/ui/settings/retention", async (c) => {
    const f = await c.req.parseBody({ all: true });
    const design = designOf(f);
    const on = f.save === "on";
    const id = Number(f.policy);
    try {
      const p = id ? updatePolicy(store, id, design, on, by) : createPolicy(store, design, on, by);
      return c.redirect(
        backUrl("ok", `Saved “${p.name}”${p.on ? " and turned it on" : ", off"}.`),
        303,
      );
    } catch (err) {
      const draft = parts.notes.put(JSON.stringify(design));
      const again = id ? `&retention=edit&policy=${id}` : "&retention=new";
      return c.redirect(backUrl("error", errorText(err), `${again}&draft=${draft}`), 303);
    }
  });

  app.post("/ui/settings/retention/:id/on", async (c) => {
    const f = await c.req.parseBody();
    try {
      const p = setPolicyOn(store, Number(c.req.param("id")), f.on === "1", by);
      return c.redirect(
        backUrl("ok", `“${p.name}” is ${p.on ? "on" : "off: it removes nothing"}.`),
        303,
      );
    } catch (err) {
      return c.redirect(backUrl("error", errorText(err)), 303);
    }
  });

  app.post("/ui/settings/retention/:id/delete", (c) => {
    try {
      const p = deletePolicy(store, Number(c.req.param("id")), by);
      return c.redirect(backUrl("ok", `Deleted “${p.name}”. What it removed stays below.`), 303);
    } catch (err) {
      return c.redirect(backUrl("error", errorText(err)), 303);
    }
  });

  // Run now's Remove now, after the confirmation in the page said what it removes.
  app.post("/ui/settings/retention/:id/run", async (c) => {
    try {
      const r = await runPolicy(deps, Number(c.req.param("id")), "hand", by);
      return c.redirect(backUrl("ok", r.said), 303);
    } catch (err) {
      return c.redirect(backUrl("error", errorText(err)), 303);
    }
  });
}

/** A draft the form sent back after a refusal, from its page note; undefined when none. */
export function draftOf(
  dash: Dashboard,
  value: string | undefined,
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const text = dash.parts.notes.read(value);
    const d = text ? JSON.parse(text) : undefined;
    return d && typeof d === "object" ? (d as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
