import { judgeGpusByDefault } from "../../../../core/hardware.ts";

/**
 * The Add a rig page's script, served from control (/ui/assets/add-rig.js; no inline script runs
 * under the dashboard's CSP). It marks the core's place, fills in the core's size from it, shows
 * what each runner's pool means, and says, in a list, what the rig will be, with the notes that
 * keep Create the rig off (goal 206). Without it the form still works: control checks the same.
 */
/**
 * The judge's share of n GPUs as the form's number gives it, as browser code: the rule of
 * judgeShareOf (clusters/resources.ts), which control applies when the form is sent, so the preview
 * refuses what control refuses. Undefined below 2 GPUs; the share; or why not, in words. For the
 * rigs you join yourself, whose GPUs are the rig's own.
 */
export const JUDGE_SHARE_JS = `(n, typed) => {
  if (n < 2) return undefined;
  const raw = String(typed ?? "").trim();
  if (!raw) return (${judgeGpusByDefault.toString()})(n);
  const j = Number(raw);
  if (!Number.isInteger(j) || j < 1 || j > n - 1 || j > 8 || n - j > 8)
    return "With " + n + " GPUs the judge takes 1 to " + Math.min(8, n - 1) + " of them, and the agents at most 8.";
  return j;
}`;

export const ADD_RIG_JS = `
(() => {
  "use strict";
  const form = document.getElementById("add-rig");
  if (!form) return;
  const sum = document.getElementById("add-sum");
  const notesEl = document.getElementById("ar-notes");
  const create = document.getElementById("ar-create");
  const blocked = create ? create.disabled : false;
  const note = document.getElementById("gpu-note");
  const share = ${JUDGE_SHARE_JS};
  const refused = (j) => typeof j === "string";
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const list = (xs) => xs.length < 2 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1];
  const laneWords = (p) => "Lane " + p.slice(5);
  const poolSays = (p) =>
    p === "judge" ? "Only the judge measures here." :
    p === "shared" ? "The judge and every lane, in turn." :
    p.startsWith("lane-") ? "Only " + laneWords(p).toLowerCase() + ": its run_experiment. The judge never measures here." :
    "Not used: free for other rigs.";
  let lastPlace = "";
  const say = () => {
    const picked = form.querySelector('input[name="place"]:checked');
    const place = picked ? picked.value : "";
    const join = place.startsWith("join:");
    for (const row of form.querySelectorAll(".ar-place")) {
      const r = row.querySelector('input[name="place"]');
      const on = !!r && r.checked;
      row.classList.toggle("on", on);
      const chip = row.querySelector("[data-core-chip]");
      if (chip) chip.hidden = !on;
    }
    for (const el of form.querySelectorAll("[data-place]")) el.hidden = el.dataset.place !== place;
    // The core's size, from its place, each time another is chosen.
    const sized = !!(picked && picked.dataset.disk !== undefined);
    const sizeBox = form.querySelector("[data-core-size]");
    if (sizeBox) sizeBox.hidden = !sized;
    const onMachine = form.querySelector("[data-core-machine]");
    if (onMachine) onMachine.hidden = !place.startsWith("machine:");
    if (picked && place !== lastPlace && sized) {
      form.elements.core_cpus.value = picked.dataset.cpus || "";
      form.elements.core_mem.value = picked.dataset.mem || "";
      form.elements.core_disk.value = picked.dataset.disk || "100";
    }
    // The core's node: the chosen cluster's nodes only.
    const nodeSel = form.elements.core_node;
    if (nodeSel) {
      const cluster = picked ? picked.dataset.cluster || "" : "";
      for (const o of nodeSel.options) if (o.value) o.hidden = o.dataset.cluster !== cluster;
      if (nodeSel.value && nodeSel.selectedOptions[0].hidden) nodeSel.value = "";
    }
    lastPlace = place;
    const runnersSec = form.querySelector("[data-runners]");
    if (runnersSec) runnersSec.hidden = join;
    const name = form.elements.rig.value.trim() || "the rig";
    if (join) {
      if (note) note.hidden = false;
      if (place === "join:machine") {
        const gpus = form.elements.j_gpus.value.split(/[\\s,]+/).filter(Boolean).map(Number).sort((a, b) => a - b);
        const j = share(gpus.length, form.elements.j_judge.value);
        note.textContent = refused(j) ? j :
          gpus.length === 0 ? "No GPU: the rig measures on the machine's CPUs." :
          gpus.length === 1 ? "One GPU: the judge and the agents share GPU " + gpus[0] + "." :
          "Judge: GPU " + gpus.slice(0, j).join(", ") + ". Agents' test runs: GPU " + gpus.slice(j).join(", ") + ".";
        sum.innerHTML = "<li>Control will show a join command for " + esc(name) + ", once. You run it on the machine within an hour: it checks the machine, fetches the rig's files and services from control, and starts them. Control then waits for the rig's first report.</li>";
      } else {
        const gpus = Number(form.elements.j_k_gpus.value || "0");
        const dra = form.elements.j_mode.value === "dra";
        const how = dra ? "DRA (" + (form.elements.j_class.value.trim() || "a class you name") + ")" : "NVIDIA's device plugin";
        const j = share(gpus, form.elements.j_k_judge.value);
        note.textContent = refused(j) ? j :
          gpus === 0 ? "No GPU: the rig measures on the CPUs of its node." :
          gpus === 1 ? "One GPU through " + how + ": the judge and the agents share it." :
          gpus + " GPUs through " + how + ": " + j + " for the judge, " + (gpus - j) + " for the agents' test runs.";
        const ns = form.elements.j_namespace.value.trim() || "your namespace";
        sum.innerHTML = "<li>Control will show a join command for " + esc(name) + ", once. You run it within an hour where kubectl reaches the cluster: it fetches the rig's objects from control and applies them in " + esc(ns) + " with your rights. Control then waits for the rig's first report.</li>";
      }
      notesEl.innerHTML = "";
      if (create) create.disabled = blocked;
      return;
    }
    if (note) note.hidden = true;
    const core = picked ? picked.dataset.name || "" : "";
    const lanes = Math.max(1, Math.min(16, Math.floor(Number(form.elements.lanes.value) || 1)));
    // Each runner row: its machine shows that machine's GPUs, a GPU another row took is taken,
    // and its pool says what it means.
    const rows = [...form.querySelectorAll("[data-runner-row]")];
    const taken = rows.map((r) => r.querySelector("[data-gpu-pick]").value).filter(Boolean);
    const used = [];
    const besides = [];
    for (const row of rows) {
      const machine = row.querySelector("[data-machine]");
      const gpu = row.querySelector("[data-gpu-pick]");
      const sel = row.querySelector("select.ar-pool");
      for (const o of gpu.options) {
        if (!o.value) continue;
        o.hidden = o.dataset.group !== machine.value || (o.value !== gpu.value && taken.includes(o.value));
      }
      if (gpu.value && gpu.selectedOptions[0].hidden) gpu.value = "";
      if (!gpu.value && machine.value) {
        const free = [...gpu.options].find((o) => o.value && !o.hidden && !o.disabled);
        if (free) { gpu.value = free.value; taken.push(free.value); }
      }
      for (const o of sel.options)
        if (o.value.startsWith("lane-")) o.hidden = Number(o.value.slice(5)) > Math.max(4, lanes) && !o.selected;
      row.classList.remove("judge", "shared", "lane");
      const says = row.querySelector("[data-pool-says]");
      if (!gpu.value) { if (says) says.textContent = machine.value ? "This machine has no free GPU left." : ""; continue; }
      const o = gpu.selectedOptions[0];
      const pool = sel.value;
      row.classList.add(pool.startsWith("lane-") ? "lane" : pool);
      if (says) says.textContent = o.dataset.says + ": " + poolSays(pool);
      used.push({ pool, label: o.dataset.says, product: o.dataset.product, cuda: o.dataset.cuda });
      const m = machine.selectedOptions[0];
      if (place && m && (m.dataset.coreOf || "").split(" ").includes(place)) besides.push(o.dataset.says);
    }
    const none = form.querySelector("[data-runner-none]");
    if (none) none.hidden = rows.length > 0;
    const count = document.getElementById("ar-count");
    if (count) count.textContent = used.length + " chosen";
    const judgeOn = used.filter((u) => u.pool === "judge" || u.pool === "shared");
    const shared = used.filter((u) => u.pool === "shared").map((u) => u.label);
    const kinds = [...new Set(used.map((u) => u.product).filter(Boolean))];
    const lines = [];
    lines.push("<b>The core</b> runs on " + esc(core || "the place you choose") + ": the run's records, the planner, " + lanes + " lane" + (lanes > 1 ? "s'" : "'s") + " agent programs and the judge's decisions.");
    lines.push("<b>The judge</b> measures on " + esc(
      judgeOn.length ? list(judgeOn.map((u) => u.label + (u.pool === "shared" ? " (shared)" : ""))) :
      used.length ? "no runner yet" : (core || "the core") + "'s CPUs, as no GPU is chosen") + ".");
    for (let i = 1; i <= lanes; i++) {
      const own = used.filter((u) => u.pool === "lane-" + i).map((u) => u.label);
      lines.push("<b>Lane " + i + "</b> tries its changes on " + esc(
        own.length ? "its own " + list(own) + (shared.length ? ", then the shared " + list(shared) : "") :
        shared.length ? "the shared " + list(shared) : (core || "the core") + ", the core's own machine") + ".");
    }
    if (used.length)
      lines.push(shared.length
        ? "On a shared runner, the judge and the lanes take turns, first come, first served."
        : "No runner is shared: the judge and the lanes never wait for each other.");
    lines.push('<span class="muted">Runners can be added and taken away later on Edit rig, while a run goes on.</span>');
    sum.innerHTML = lines.map((l) => "<li>" + l + "</li>").join("");
    const notes = [];
    let stop = false;
    if (used.length && !judgeOn.length) {
      notes.push("Give the judge a runner, its own or a shared one: the core has no GPU to measure on.");
      stop = true;
    }
    if (kinds.length > 1) {
      notes.push("The runners are of " + (kinds.length === 2 ? "two" : kinds.length) + " kinds, " + list(kinds) + ": a rig measures on one kind of target, so its verdicts compare. Use one kind, or make a rig for each.");
      stop = true;
    }
    for (const u of used)
      if (u.pool.startsWith("lane-") && Number(u.pool.slice(5)) > lanes)
        notes.push(u.label + " is " + laneWords(u.pool).toLowerCase() + "'s, and the rig has " + lanes + " worker" + (lanes > 1 ? "s" : "") + " at a time: it would stay idle.");
    if (besides.length)
      notes.push(place.startsWith("machine:")
        ? core + " is the core and a runner: the agents' programs and builds run beside its GPU's runs, which can make the judge's timings noisier."
        : "The core and " + list(besides) + " share the slot " + core + ": they share its quota, so leave the runners room, and the core may run beside a GPU's runs on one node, which can make the judge's timings noisier.");
    notesEl.innerHTML = notes.map((n) => '<div class="card warn ar-note">' + esc(n) + "</div>").join("");
    // The images: the core's CPU one, and the runners' CUDA one for their GPUs.
    const img = document.getElementById("ar-run-img");
    if (img) {
      const cudas = [...new Set(used.map((u) => u.cuda))].sort();
      img.textContent = cudas.length ? cudas.map((v) => form.dataset["imgCuda" + v] || "no CUDA " + v + " harness image configured").join(", ") : "none chosen";
    }
    if (create) create.disabled = blocked || !picked || stop;
  };
  // + Add a runner: a row from the page's template, its fields numbered; the first one the
  // judge's, the next ones shared. Remove takes a row away.
  const runnerList = form.querySelector("[data-runner-list]");
  const tpl = document.getElementById("ar-row");
  const add = form.querySelector("[data-add-runner]");
  let next = 0;
  if (add && tpl && runnerList) {
    add.hidden = false;
    add.addEventListener("click", () => {
      const holder = document.createElement("div");
      holder.innerHTML = tpl.innerHTML.replace(/__N"/g, "__" + next++ + '"');
      const row = holder.firstElementChild;
      const judged = [...runnerList.querySelectorAll("select.ar-pool")].some((x) => x.value === "judge" || x.value === "shared");
      row.querySelector("select.ar-pool").value = judged ? "shared" : "judge";
      runnerList.append(row);
      say();
      row.querySelector("[data-machine]").focus();
    });
  }
  form.addEventListener("click", (e) => {
    const t = e.target.closest ? e.target.closest("[data-remove-runner]") : null;
    if (!t) return;
    t.closest("[data-runner-row]").remove();
    say();
  });
  form.addEventListener("change", say);
  form.addEventListener("input", say);
  say();
})();
`;
