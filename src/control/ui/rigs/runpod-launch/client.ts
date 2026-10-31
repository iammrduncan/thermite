import { judgeGpusByDefault } from "../../../../core/hardware.ts";
import { RIG_ID, RIG_ID_SENTENCE } from "../../../../core/ids.ts";

/**
 * The Launch on RunPod page's script, served from control (/ui/assets/runpod-launch.js; no inline
 * script runs under the dashboard's CSP). The price follows every choice, choices that cannot apply
 * are hidden, and the summary says in a sentence what the launch starts and what stops it. The
 * button stays off while a field is wrong. Without it the form still works: control checks it all.
 */
export const RUNPOD_LAUNCH_JS = `
(() => {
  "use strict";
  const form = document.getElementById("rp");
  if (!form) return;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const money = (n) => "$" + n.toFixed(2);
  const minIdle = Number(form.dataset.minIdle || "5");
  const draw = () => {
    const picked = form.querySelector('input[name="gpu"]:checked');
    const row = picked ? picked.closest("[data-price]") : null;
    form.querySelectorAll(".gtab[data-price]").forEach((r) => r.classList.toggle("on", r === row));
    const cnt = $("cnt");
    const n = Number(cnt.value) || 1;
    const name = row ? row.dataset.name : "";
    // The count's options name the GPU chosen.
    for (const o of cnt.options) o.textContent = o.value + (name ? " × " + name : "");
    $("judge-f").hidden = n < 2;
    const jRaw = $("judge").value.trim();
    const jNum = Number(jRaw);
    const jOk = n < 2 || !jRaw || (Number.isInteger(jNum) && jNum >= 1 && jNum < n);
    const j = n < 2 ? 1 : jRaw && jOk ? jNum : (${judgeGpusByDefault})(n);
    $("split").innerHTML = n < 2
      ? "<b>One GPU.</b> The judge and the agents share it. While the judge measures, the agents' own test runs wait, so its timings stay clean."
      : (jOk ? "" : '<b class="bad">The judge needs 1 to ' + (n - 1) + " GPUs.</b> ") + "<b>GPU" + (j > 1 ? "s 0–" + (j - 1) : " 0") + "</b> for the judge, <b>GPU" + (n - j > 1 ? "s " + j + "–" + (n - 1) : " " + j) + "</b> for the agents.";
    const own = $("img").value === "own";
    $("own-f").hidden = !own;
    const price = row ? Number(row.dataset.price) * n : 0;
    $("price").textContent = row ? money(price) + " an hour" : "–";
    $("price-s").textContent = row ? "for " + n + " × " + name + " at RunPod's list price on Secure cloud. RunPod also bills the container disk and the volume by the GB." : "";
    const gb = Number($("gb").value.trim());
    const lim = $("lim").value.trim().replace(/^\\$/, "");
    const limN = Number(lim);
    const idle = $("idle").value.trim();
    const idleN = Number(idle);
    const nm = $("nm").value.trim();
    const dc = $("dc").value;
    const bad = [];
    if (!row) bad.push("Choose a GPU.");
    if (!jOk) bad.push("Fix the judge's GPUs.");
    if (!(Number.isInteger(gb) && gb >= 10 && gb <= 10000)) bad.push("The volume is 10 to 10000 GB.");
    if (lim && !(limN > 0)) bad.push("The spend limit is an amount in US dollars, such as 40.");
    if (idle && !(Number.isInteger(idleN) && idleN >= minIdle)) bad.push("The idle stop is a whole number of minutes, " + minIdle + " or more.");
    if (nm && !/${RIG_ID.source}/.test(nm)) bad.push("${RIG_ID_SENTENCE}");
    if (own && !$("own").value.trim()) bad.push("Give your image's name and tag.");
    const hour = row ? price : 0;
    $("sum").innerHTML = row
      ? "Start <b>" + esc(nm || "the rig") + "</b>: " + n + " × <b>" + esc(name) + " " + esc(row.dataset.mem) + " GB</b> on Secure cloud, " + (dc ? "in <b>" + esc(dc) + "</b>" : "in a data center RunPod picks") + ", with a " + esc(gb || "?") + " GB pod volume. " +
        (lim && limN > 0 ? "Control stops it at <b>" + money(limN) + "</b> in total" + (hour > 0 ? ": about " + Math.floor(limN / hour) + " hours of work" : "") + ". " : "<b>No spend limit.</b> ") +
        (idle && idleN > 0 ? "It stops after <b>" + idleN + " minutes</b> with no run at work. " : "<b>It never stops by itself.</b> ") +
        (bad.length ? '<br><span class="bad">' + bad.join(" ") + "</span>" : "")
      : '<span class="bad">' + bad.join(" ") + "</span>";
    $("go").textContent = row ? "Launch · " + money(price) + "/h" : "Launch";
    $("go").disabled = bad.length > 0;
  };
  form.addEventListener("input", draw);
  form.addEventListener("change", draw);
  form.addEventListener("submit", () => { const b = $("go"); b.textContent = "Launching…"; setTimeout(() => (b.disabled = true), 0); });
  // Another RunPod account: its own list and prices.
  document.querySelectorAll("select[data-submit-on-change]").forEach((s) => s.addEventListener("change", () => s.form.submit()));
  draw();
})();
`;
