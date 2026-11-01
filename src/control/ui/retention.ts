import { kindOf, perRig, RETENTION_KIND_KEYS } from "../../core/retention/index.ts";

/**
 * Settings › Retention policies' script, served from control (/ui/assets/retention.js; no inline
 * script runs under the dashboard's CSP). The policy form shows only the fields its kind, place,
 * rule and time use, keeps Save off until the policy has a name, and asks control what the design
 * would remove now as it changes (POST /ui/settings/retention/preview), for If it ran now. A
 * policy's switch saves at once. Without the script every field shows, the preview is the one the
 * page came with, and the switch has a Save button.
 */

/** Each kind's place (control, rigs or supervisors) and what a policy may keep of it. */
const KINDS = Object.fromEntries(
  RETENTION_KIND_KEYS.map((k) => [k, { perRig: perRig(k), keeps: Object.keys(kindOf(k).keeps) }]),
);

export const RETENTION_JS = `
(() => {
  "use strict";
  const kinds = ${JSON.stringify(KINDS)};
  // A policy's switch: turned, its form is sent at once.
  for (const box of document.querySelectorAll("input[data-autosubmit]"))
    box.addEventListener("change", () => box.form && box.form.requestSubmit());
  const form = document.getElementById("rt-form");
  if (!form) return;
  // A field's value; for radio buttons, the checked one's (RadioNodeList's value).
  const val = (name) => {
    const el = form.elements.namedItem(name);
    return el && "value" in el ? String(el.value) : "";
  };
  const show = (sel, on) => { for (const el of form.querySelectorAll(sel)) el.hidden = !on; };
  const shape = () => {
    const kind = val("kind");
    const k = kinds[kind] || { perRig: false, keeps: [] };
    const rigs = k.perRig;
    for (const el of form.querySelectorAll("[data-kind-info]")) el.hidden = el.dataset.kindInfo !== kind;
    show("[data-for-rigs]", rigs);
    show("[data-for-control]", !rigs);
    for (const el of form.querySelectorAll("[data-where]")) el.hidden = !rigs || el.dataset.where !== val("where");
    for (const el of form.querySelectorAll("[data-rule]")) el.hidden = el.dataset.rule !== val("rule");
    for (const el of form.querySelectorAll("[data-keep]")) el.hidden = !k.keeps.includes(el.dataset.keep);
    // What a keep is called depends on the kind: "Builds of runs still open", "Records of …".
    for (const el of form.querySelectorAll("[data-keep-words]")) {
      const words = JSON.parse(el.dataset.keepWords || "{}")[kind];
      if (words) el.textContent = words;
    }
    show("[data-keeps]", k.keeps.length > 0);
    const when = val("when");
    for (const el of form.querySelectorAll("[data-when]")) el.hidden = !el.dataset.when.split(" ").includes(when);
    const named = String(val("name")).trim() !== "";
    for (const b of form.querySelectorAll("button[name=save]")) {
      b.disabled = !named;
      b.title = named ? "" : "Give it a name first";
    }
  };
  const box = document.getElementById("rt-preview");
  const first = document.getElementById("rt-first");
  let timer = 0;
  let asked = 0;
  const preview = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const n = ++asked;
      try {
        const r = await fetch(form.dataset.preview, { method: "POST", body: new FormData(form), headers: { accept: "application/json" } });
        const p = await r.json();
        if (n !== asked || !box) return;
        const big = box.querySelector("[data-big]");
        const small = box.querySelector("[data-small]");
        if (big) big.textContent = p.error ? "It can't be worked out yet." : p.words;
        if (small) small.textContent = p.error || p.stays + (p.unreported_words ? " " + p.unreported_words : "");
        if (first && p.first) first.textContent = p.first;
      } catch {
        // The preview the page came with stays.
      }
    }, 250);
  };
  form.addEventListener("change", () => { shape(); preview(); });
  form.addEventListener("input", () => { shape(); preview(); });
  shape();
})();
`;
