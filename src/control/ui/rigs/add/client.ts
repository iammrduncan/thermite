import { judgeGpusByDefault } from "../../../../core/hardware.ts";

/** The CUDA field's words when control can't tell the GPU (goal 132). */
export const CUDA_UNSURE =
  "Control can't tell which GPU this is. For a DGX Spark (GB10) or another Blackwell GPU, choose 13.";

/**
 * The Add a rig page's script, served from control (/ui/assets/add-rig.js; no inline script runs
 * under the dashboard's CSP). It shows the chosen place's GPU and resource choices and says, in a
 * sentence, what control will do. Without it the form still works: every place's choices show.
 */
/**
 * The judge's share of n GPUs as the form's number gives it, as browser code: the rule of
 * judgeShareOf (clusters/resources.ts), which control applies when the form is sent, so the preview
 * refuses what control refuses. Undefined below 2 GPUs; the share; or why not, in words.
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
  const UNSURE = ${JSON.stringify(CUDA_UNSURE)};
  const form = document.getElementById("add-rig");
  if (!form) return;
  const note = document.getElementById("gpu-note");
  const sum = document.getElementById("add-sum");
  // The judge's share of n GPUs: the number typed, half rounded up, or why control refuses it.
  const share = ${JUDGE_SHARE_JS};
  const refused = (j) => typeof j === "string";
  const splitText = (n, j) => j + " for the judge, " + (n - j) + " for the agents' test runs";
  const say = () => {
    const picked = form.querySelector('input[name="place"]:checked');
    const place = picked ? picked.value : "";
    for (const el of form.querySelectorAll("[data-place]")) {
      const on = el.dataset.place === place;
      el.hidden = !on;
      if (!on) for (const box of el.querySelectorAll('input[type="checkbox"]')) box.checked = false;
    }
    const name = form.elements.rig.value.trim() || "the rig";
    // More machines (goal 205): each node or machine ticked shows its choices, and follows the rig.
    const leader = place.slice(place.indexOf(":") + 1);
    let followers = 0;
    for (const el of form.querySelectorAll("[data-follow-for]")) {
      const [kk, node] = el.dataset.followFor.split(":");
      const box = [...form.querySelectorAll('input[name="k_follow__' + kk + '"], input[name="m_follow__' + kk + '"]')].find((b) => b.value === node);
      el.hidden = !(box && box.checked);
      if (kk === leader && box && box.checked) followers++;
    }
    if (place.startsWith("cluster:")) {
      const k = place.slice(8);
      const get = (n) => { const el = form.elements[n + "__" + k]; return el ? el.value : ""; };
      const gpus = Number(get("k_gpus") || "0");
      const mode = get("k_mode");
      const how = mode.startsWith("dra:") ? "DRA (" + mode.slice(4) + ")" : "NVIDIA's device plugin";
      for (const el of form.querySelectorAll("[data-judge-for]"))
        el.hidden = !(el.dataset.judgeFor === "k_gpus__" + k && gpus >= 2);
      // The CUDA harness (goal 132): from the chosen node's GPU, else the GPU choice's, until the
      // owner picks one; hidden for a rig with no GPUs.
      const cuda = form.elements["k_cuda__" + k];
      if (cuda) {
        const picked = (n) => { const el = form.elements[n + "__" + k]; return el && el.selectedOptions ? el.selectedOptions[0] : null; };
        const hint = [picked("k_node"), picked("k_mode")].find((o) => o && o.dataset.cuda);
        if (hint && !cuda.dataset.touched) cuda.value = hint.dataset.cuda;
        const why = form.querySelector('[data-cuda-why="' + k + '"]');
        if (why) why.textContent = hint && cuda.value === hint.dataset.cuda ? hint.dataset.why : hint ? "" : UNSURE;
        const field = form.querySelector('[data-cuda-for="' + k + '"]');
        if (field) field.hidden = gpus === 0;
      }
      const j = share(gpus, get("k_judge"));
      note.textContent = refused(j) ? j :
        gpus === 0 ? "No GPU: the rig measures on the CPUs of its node." :
        gpus === 1 ? "One GPU through " + how + ": the judge and the agents share it, and the agents' test runs wait while the judge measures." :
        gpus + " GPUs through " + how + ": " + splitText(gpus, j) + ".";
      const slot = get("k_slot");
      sum.textContent = "Control will enroll " + name + " and create it on " + k + (slot ? ", in the slot " + slot : ", in a namespace of its own") +
        ": a secret with its tokens, a " + (get("k_size") || "100") + " GB volume, and the harness and supervisor pods" + (gpus ? " with " + gpus + " GPU" + (gpus > 1 ? "s" : "") : "") +
        (followers ? ", and on " + followers + " more node" + (followers > 1 ? "s" : "") + " a volume, harness and supervisor of each, which follow it and on whose GPUs the judge measures" : "") +
        ". Then it waits for the rig's first report. You need to do nothing in the cluster.";
      return;
    }
    if (place === "join:machine") {
      const gpus = form.elements.j_gpus.value.split(/[\\s,]+/).filter(Boolean).map(Number).sort((a, b) => a - b);
      const j = share(gpus.length, form.elements.j_judge.value);
      note.textContent = refused(j) ? j :
        gpus.length === 0 ? "No GPU: the rig measures on the machine's CPUs." :
        gpus.length === 1 ? "One GPU: the judge and the agents share GPU " + gpus[0] + "." :
        "Judge: GPU " + gpus.slice(0, j).join(", ") + ". Agents' test runs: GPU " + gpus.slice(j).join(", ") + ".";
      sum.textContent = "Control will show a join command for " + name + ", once. You run it on the machine within an hour: it checks the machine, fetches the rig's files and services from control, and starts them. Control then waits for the rig's first report.";
      return;
    }
    if (place === "join:namespace") {
      const gpus = Number(form.elements.j_k_gpus.value || "0");
      const dra = form.elements.j_mode.value === "dra";
      const how = dra ? "DRA (" + (form.elements.j_class.value.trim() || "a class you name") + ")" : "NVIDIA's device plugin";
      const j = share(gpus, form.elements.j_k_judge.value);
      note.textContent = refused(j) ? j :
        gpus === 0 ? "No GPU: the rig measures on the CPUs of its node." :
        gpus === 1 ? "One GPU through " + how + ": the judge and the agents share it." :
        gpus + " GPUs through " + how + ": " + splitText(gpus, j) + ".";
      const ns = form.elements.j_namespace.value.trim() || "your namespace";
      sum.textContent = "Control will show a join command for " + name + ", once. You run it within an hour where kubectl reaches the cluster: it fetches the rig's objects from control and applies them in " + ns + " with your rights. Control then waits for the rig's first report.";
      return;
    }
    const gpus = [...form.querySelectorAll('input[name="gpus"]:checked')].map((x) => Number(x.value)).sort((a, b) => a - b);
    const pick = document.getElementById("judge-pick");
    if (pick) pick.hidden = !(place.startsWith("machine:") && gpus.length >= 2);
    const j = share(gpus.length, form.elements.judge_gpus ? form.elements.judge_gpus.value : "");
    note.textContent = refused(j) ? j :
      gpus.length === 0 ? "No GPU chosen: the rig measures on the machine's CPUs." :
      gpus.length === 1 ? "One GPU: the judge and the agents share GPU " + gpus[0] + ". While the judge measures, the agents' own test runs wait, so its timings stay clean." :
      gpus.length > 16 ? "A rig takes at most 16 GPUs." :
      "Judge: GPU " + gpus.slice(0, j).join(", ") + ". Agents' test runs: GPU " + gpus.slice(j).join(", ") + ". They never wait for each other.";
    const machine = place.startsWith("machine:") ? place.slice(8) : "";
    sum.textContent = machine
      ? "Control will enroll " + name + ", write its files and services on " + machine + (gpus.length ? " with GPU" + (gpus.length > 1 ? "s " + gpus.join(" and ") : " " + gpus[0]) : " (CPU only)") + (followers ? ", and on " + followers + " more machine" + (followers > 1 ? "s" : "") + " that follow it, where the judge measures" : "") + ", start it, and wait for its first report. You need to do nothing on the machine."
      : "Choose a machine or a cluster.";
  };
  // A CUDA chosen by hand stays as chosen.
  form.addEventListener("change", (e) => {
    if (e.target && e.target.name && e.target.name.startsWith("k_cuda__")) e.target.dataset.touched = "1";
  });
  form.addEventListener("change", say);
  form.addEventListener("input", say);
  say();
})();
`;
