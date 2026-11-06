import type { RigSettings } from "../../../core/rig-settings.ts";
import type { RigView, RunnerFetch, RunnersView } from "../../views/index.ts";
import { ago, esc, infoLabel } from "../components/index.ts";
import { jobHtml } from "../operator/index.ts";

/**
 * A rig's runners of other machines on its page (goal 206), as its core reports them: each
 * runner with its pool, whether it takes runs and why not, and what it runs now; then who waits
 * for one. A rig without runners shows none of it.
 */

type Process = RunnersView["processes"][number];

/** A pool in words, as Add a rig and Edit rig name it. */
function poolWords(pool: string): string {
  if (pool === "judge") return "the judge's";
  if (pool === "shared") return "shared";
  return `${pool}'s`;
}

/** Whether a runner process takes runs, in a chip, and since when or why not. */
function stateHtml(p: Process, now: number): string {
  if (p.up)
    return `<span class="chip ok">answers</span>${p.answered_at ? `<br><span class="small muted">last check ${esc(ago(p.answered_at, now))} ago</span>` : ""}`;
  if (p.away_since)
    return `<span class="chip bad">away ${esc(ago(p.away_since, now))}</span><br><span class="small muted">${esc(p.why ?? "it stopped answering")}; its run was tried again</span>`;
  if (p.why)
    return `<span class="chip warn">takes no runs</span><br><span class="small muted">${esc(p.why)}</span>`;
  return `<span class="chip">joining</span><br><span class="small muted">it takes runs once it answers the core</span>`;
}

/** What a runner runs now: a judge's job, a lane's run, or nothing. */
function nowHtml(u: RigView, holder: string | null): string {
  if (!holder) return `<span class="muted">Nothing</span>`;
  if (holder.startsWith("executor-")) {
    const job = u.judge.running.find((j) => j.by === holder);
    return job ? `The judge: ${jobHtml(u, job)}` : "The judge, between two steps of a job";
  }
  return `${esc(holder.replace("lane-", "Lane "))}'s run_experiment. It never counts.`;
}

/**
 * A runner's fetch of a run's model files in words (goal 213): files and GiB so far and for how
 * long, and when the core last heard, once that is more than a minute ago.
 */
function fetchWords(f: RunnerFetch, now: number): string {
  const gib = (n: number) => (n / 2 ** 30).toFixed(1);
  const heard = now - Date.parse(f.at) > 60_000 ? `, as of ${ago(f.at, now)} ago` : "";
  return `${f.done} of ${f.files} files, ${gib(f.bytes)}${f.total !== null ? ` of ${gib(f.total)}` : ""} GiB, for ${ago(f.since, now)}${heard}`;
}

/**
 * The run's status line on its fetches (goal 213): each runner of the rig that fetches the run's
 * model files, with how far it is; "" when none does.
 */
export function runFetchWords(u: RigView, run: string, now: number): string {
  const each = (u.runners?.processes ?? []).flatMap((p) =>
    p.runners.flatMap((x) =>
      x.fetch && x.fetch.run === run
        ? [`${p.runners.length === 1 ? p.name : x.name} (${fetchWords(x.fetch, now)})`]
        : [],
    ),
  );
  if (!each.length) return "";
  return `${each.length === 1 ? "Runner" : "Runners"} ${listWords(each)} ${each.length === 1 ? "fetches" : "fetch"} the run's model files before ${each.length === 1 ? "it builds or runs" : "they build or run"}.`;
}

/** A list in words: "a, b and c". */
const listWords = (xs: string[]) =>
  xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

/** What the rig's page knows of its runners besides the core's report (goal 206). */
interface RunnerPage {
  /** By runner process: where it is, and its GPU, as control set it up. */
  placed: RunnerPlaces["placed"];
  /** The runners' lines of the rig's history, oldest first. */
  lines: { at: string; ok: boolean; text: string }[];
}

/** A runner process's store, in words. */
function storeWords(p: Process): string {
  const s = p.store;
  if (!s) return `<span class="muted">not said yet</span>`;
  const disk =
    s.total_gib !== null && s.free_gib !== null
      ? `${Math.round(s.total_gib - s.free_gib)} of ${Math.round(s.total_gib)} GB used · `
      : "";
  return esc(`${disk}builds ${s.builds} · kits ${s.kits}`);
}

/** What a runner runs now; for one that takes no runs, where its pool's runs go meanwhile. */
function nowCell(u: RigView, p: Process, pool: string, holder: string | null): string {
  if (holder || p.up) return nowHtml(u, holder);
  const others = (u.runners?.processes ?? [])
    .filter((x) => x.up && x.name !== p.name)
    .flatMap((x) => x.runners.filter((y) => y.pool === pool || y.pool === "shared"))
    .map((y) => y.name);
  const whose =
    pool === "judge" ? "the judge's jobs" : pool === "shared" ? "its runs" : `${pool}'s runs`;
  return `<span class="muted">${esc(
    others.length
      ? `Nothing: ${whose} go to ${listWords(others)} meanwhile, and come back once ${p.name} answers.`
      : `Nothing: ${whose} wait until ${p.name} answers${pool.startsWith("lane-") ? ", or run on the core" : ""}.`,
  )}</span>`;
}

/** A pool as a chip, coloured as Add a rig colours it. */
const poolChip = (pool: string) =>
  `<span class="chip${pool === "judge" ? " warn" : pool === "shared" ? " info" : ""}">${esc(poolWords(pool))}</span>`;

/** Who waits for a runner: a card for the judge's jobs and one for each lane, with since when. */
function waitingCards(u: RigView, now: number): string {
  const r = u.runners;
  if (!r) return "";
  const waits = r.waits.length ? r.waits : r.waiting.map((who) => ({ who, since: "" }));
  if (!waits.length) return "";
  const runnersOf = (ok: (pool: string) => boolean) =>
    r.processes.flatMap((p) =>
      p.runners
        .filter((x) => ok(x.pool))
        .map((x) => ({ name: x.name, up: p.up, holder: x.holder })),
    );
  const holderWords = (h: string) =>
    h.startsWith("executor-") ? "the judge's job" : `${h.replace("lane-", "lane ")}'s run`;
  const cards: string[] = [];
  if (waits.some((w) => w.who.startsWith("executor-"))) {
    const on = runnersOf((pool) => pool === "judge" || pool === "shared").filter((x) => x.up);
    const shared = runnersOf((pool) => pool === "shared").map((x) => x.name);
    const queued = u.judge.queued;
    const jobs = queued.length
      ? `${queued.length} judge job${queued.length === 1 ? "" : "s"}: ${queued
          .slice(0, 3)
          .map((j) => jobHtml(u, j))
          .join(", ")}${queued.length > 3 ? ", …" : ""}.`
      : "The judge's next step of its job.";
    const next = on.length
      ? `The next free one of ${listWords(on.map((x) => x.name))} takes the first${shared.length ? `, in turn with the lanes on ${listWords(shared)}` : ""}.`
      : "No runner of the judge's or shared answers now: the jobs wait for one.";
    cards.push(
      `<div class="card rq"><span>${poolChip("judge")}${shared.length ? ` and ${poolChip("shared")}` : ""}</span><span>${jobs}</span><span class="small muted">${esc(next)}</span></div>`,
    );
  }
  // Each lane once: its first wait.
  const lanes = waits.filter(
    (x, i) => !x.who.startsWith("executor-") && waits.findIndex((y) => y.who === x.who) === i,
  );
  for (const w of lanes) {
    const lane = w.who;
    const own = runnersOf((pool) => pool === lane);
    const shared = runnersOf((pool) => pool === "shared");
    const away = own.filter((x) => !x.up).map((x) => x.name);
    const next = [...own, ...shared].filter((x) => x.up);
    const busy = [...new Set(next.flatMap((x) => (x.holder ? [holderWords(x.holder)] : [])))];
    const says = `${away.length ? `Its own ${listWords(away)} ${away.length === 1 ? "is" : "are"} away; ` : ""}${
      next.length
        ? `it takes the next free one of ${listWords(next.map((x) => x.name))}${busy.length ? `, after ${listWords(busy)}` : ""}.`
        : "no runner of its pool answers now."
    }`;
    cards.push(
      `<div class="card rq"><span>${own.length ? poolChip(lane) : ""}${own.length && shared.length ? " and " : ""}${shared.length ? poolChip("shared") : ""}</span><span>${esc(`${lane.replace("lane-", "Lane ")}'s run_experiment${w.since ? `, waiting ${ago(w.since, now)}` : ""}.`)}</span><span class="small muted">${esc(says)}</span></div>`,
    );
  }
  return `<div class="sub-block"><h3>Waiting for a runner</h3><div class="rq-cards">${cards.join("")}</div></div>`;
}

/**
 * The block, as the approved mockup has it: each runner with where it is and its GPU, its pool,
 * whether it answers, what it runs now and its store; who waits, by pool; and the runners' lines
 * of the rig's history. Empty for a rig without runners.
 */
export function runnersBlock(
  u: RigView,
  now: number,
  more: RunnerPage = { placed: {}, lines: [] },
): string {
  const r = u.runners;
  if (!r) return "";
  const rows = r.processes
    .flatMap((p) =>
      p.runners.map((x) => {
        const placed = more.placed[p.name];
        const name = p.runners.length === 1 ? p.name : x.name;
        const sub = placed
          ? `${placed.gpu} · ${placed.where}`
          : `runner process ${p.name}, started by you`;
        // A fetch of a run's model files (goal 213), which its first build or run waits for.
        const fetch = x.fetch
          ? `<br><span class="small" data-fetch>Fetching the model files of ${esc(x.fetch.run)} first: ${esc(fetchWords(x.fetch, now))}.</span>`
          : "";
        return `<tr><td><b>${esc(name)}</b><br><span class="small muted">${esc(sub)}</span></td><td>${poolChip(x.pool)}</td><td>${stateHtml(p, now)}</td><td>${nowCell(u, p, x.pool, x.holder)}${fetch}</td><td class="small muted">${storeWords(p)}</td></tr>`;
      }),
    )
    .join("");
  const count = r.processes.reduce((n, p) => n + p.runners.length, 0);
  const lines = more.lines
    .slice(-8)
    .reverse()
    .map(
      (l) =>
        `<span${l.ok ? "" : ' class="bad"'}><span class="muted mono">${esc(l.at.slice(11, 16))}</span> ${esc(l.text)}</span>`,
    )
    .join("");
  return `<div class="block" data-part="runners"><div class="head"><h2>Runners</h2><span class="n">${count}</span><span class="right"><a href="/ui/rigs/${encodeURIComponent(u.id)}/edit#where">Add or take away runners on Edit rig</a> · the run goes on</span></div><div class="card flat" style="overflow-x:auto"><table class="ut"><thead><tr><th scope="col">Runner</th><th scope="col">Pool</th><th scope="col">State</th><th scope="col">Now</th><th scope="col">Its store</th></tr></thead><tbody>${rows}</tbody></table></div>${waitingCards(u, now)}${lines ? `<div class="sub-block"><h3>History <span class="muted small">the runners' lines</span></h3><div class="card rh">${lines}</div></div>` : ""}<div class="small muted" style="margin-top:6px">Each runner takes one run at a time; on a shared one the judge and the lanes take turns, first come, first served.</div></div>`;
}

/** The rig's core, as the approved mockup has it: where it runs, its facts, and what it keeps. */
export function coreBlock(c: {
  name: string;
  where: string;
  chips: string;
  facts: string[];
  keeps: string;
}): string {
  return `<div class="block" data-part="core"><div class="head"><h2>The core</h2></div><div class="card rc"><div><b>${esc(c.name)}</b> <span class="chip">${esc(c.where)}</span> ${c.chips}</div>${c.facts.length ? `<div class="rc-facts">${c.facts.map((f) => `<span>${esc(f)}</span>`).join("")}</div>` : ""}<div class="small">${esc(c.keeps)}</div></div></div>`;
}

/** A pool's choice in a select: the judge's, shared, or one of the rig's lanes'. */
function poolOptions(now: string, lanes: number): string {
  const n = Math.max(lanes, now.startsWith("lane-") ? Number(now.slice(5)) : 0);
  const opts = [
    ["judge", "The judge's"],
    ["shared", "Shared: the judge and the lanes"],
    ...Array.from({ length: n }, (_, i) => [`lane-${i + 1}`, `Lane ${i + 1}'s`]),
  ];
  return opts
    .map(([v, t]) => `<option value="${v}"${v === now ? " selected" : ""}>${esc(t ?? "")}</option>`)
    .join("");
}

/** What control knows of a runner process it set up, and the GPUs Edit rig can add. */
export interface RunnerPlaces {
  /** By runner process: where it is, and its GPU in words, with the GPU's name. */
  placed: Record<string, { where: string; gpu: string; product: string }>;
  /** Each free GPU: the form's value (name=place), its words, and its GPU's name. */
  add: { value: string; text: string; product: string }[];
  /** The core judges on its runners alone: with none of the judge's, its jobs wait. */
  judgeOnRunners: boolean;
}

/** Whether a runner process takes runs, as one chip, with since when or why not as its title. */
function stateChip(p: Process | undefined, now: number): string {
  if (!p) return `<span class="chip" title="It takes runs once it answers the core">joining</span>`;
  if (p.up)
    return `<span class="chip ok"${p.answered_at ? ` title="last check ${esc(ago(p.answered_at, now))} ago"` : ""}>answers</span>`;
  if (p.away_since)
    return `<span class="chip bad" title="${esc(p.why ?? "it stopped answering")}">away ${esc(ago(p.away_since, now))}</span>`;
  if (p.why) return `<span class="chip warn" title="${esc(p.why)}">takes no runs</span>`;
  return `<span class="chip" title="It takes runs once it answers the core">joining</span>`;
}

/** What happens to the run a runner holds when it leaves or changes pool, in words. */
function jobWords(holder: string | null): string {
  if (!holder) return "";
  if (holder.startsWith("executor-"))
    return "the judge's job goes back to the judge's queue and starts again on another of its runners";
  const lane = holder.replace("lane-", "lane ");
  return `${lane}'s run_experiment stops, and ${lane} is told to run it again`;
}

/**
 * Edit rig's runners (goal 206), as the approved mockup has them: each runner process with where
 * it is, whether it answers, its GPU, its pool, what it runs now and Remove, which marks it to
 * leave on Save changes and says in its row what happens to that run, with Keep it to undo it
 * (the form's own Save changes and Cancel decide); then Add a runner, a free GPU of a machine or cluster control
 * knows in a pool, set up on Save changes; then one you started yourself, by its name. The whole
 * list goes to the rig as its `runners` setting, which its core takes while it works.
 */
export function runnersFields(u: RigView, settings: RigSettings, at: RunnerPlaces): string {
  const state = new Map((u.runners?.processes ?? []).map((p) => [p.name, p]));
  const now = Date.now();
  const rows = settings.runners
    .map((p) => {
      const seen = state.get(p.name);
      const placed = at.placed[p.name];
      const holders = p.pools.map((_, i) => seen?.runners[i]?.holder ?? null);
      const job = holders.map(jobWords).filter(Boolean).join("; ");
      const pools = p.pools
        .map(
          (pool, i) =>
            `<select class="ar-pool" name="runner_pool__${esc(p.name)}__${i}" data-runner-pool="${esc(p.name)}" aria-label="${esc(`The pool of ${p.name}${p.pools.length > 1 ? `'s runner ${i}` : ""}`)}">${poolOptions(pool, settings.lanes)}</select>`,
        )
        .join("");
      const busy = holders.filter(Boolean);
      const nowText = busy.length ? busy.map((h) => nowHtml(u, h)).join("<br>") : "Nothing now.";
      const leaves = job
        ? `Leaves when you save: ${job}. No verdict is lost and nothing counts against the change.`
        : "Leaves when you save. Nothing runs there now.";
      return `<div class="er-row" data-runner-row="${esc(p.name)}" data-job="${esc(job)}" data-leaves="${esc(leaves)}" data-product="${esc(placed?.product ?? "")}"><span class="er-what"><span><b>${esc(p.name)}</b> <span class="chip">${esc(placed?.where ?? "started by you")}</span> ${stateChip(seen, now)}</span><span class="small muted">${esc(placed?.gpu ?? `${p.pools.length} runner${p.pools.length > 1 ? "s" : ""}`)}</span></span><span class="er-pools">${pools}</span><span class="small" data-runner-now>${nowText}</span><span class="er-btns"><label class="btn er-rm"><input type="checkbox" name="runner_remove__${esc(p.name)}" value="1" data-runner="${esc(p.name)}"> Remove</label><button type="button" class="sm" data-keep hidden>Keep it</button></span></div>`;
    })
    .join("");
  const add = at.add.length
    ? `<div class="card er-add"><label class="fd">${infoLabel("Add a runner", "A GPU of a machine or cluster control knows that no rig uses. Control sets it up on Save changes, and it joins its pool once it answers the core: a run waits for it, and none fails while it starts.")}<select name="add_at" data-add-at><option value="">Choose a GPU</option>${at.add.map((x) => `<option value="${esc(x.value)}" data-product="${esc(x.product)}">${esc(x.text)}</option>`).join("")}</select></label><label class="fd">${infoLabel("Its pool", POOL_TIP)}<select name="add_pool" data-add-pool>${poolOptions("shared", settings.lanes)}</select></label><label class="fd">${infoLabel("Volume, in GB", "On a cluster, the volume of each runner added on this save, for its builds and a run's model files: 100 when left empty. A volume can't grow later; for a bigger one, remove the runner, save, and add it again.")}<input name="add_storage_gi" type="number" min="1" max="10000" step="1" placeholder="100" inputmode="numeric"></label><label class="fd">${infoLabel("CPUs", "On a cluster, the CPUs of each runner added on this save, with its memory: its supervisor takes half a CPU and its harness the rest. Empty: the namespace's defaults, which may be far too small for a model's engine.")}<input name="add_cpus" type="number" min="1.5" step="0.5" placeholder="the namespace's" inputmode="decimal"></label><label class="fd">${infoLabel("Memory, in GiB", "On a cluster, the memory of each runner added on this save, with its CPUs: its supervisor takes 2 GiB and its harness the rest, where the judge's runs and the lanes' run_experiment load the model. Empty: the namespace's defaults.")}<input name="add_memory_gib" type="number" min="6" step="1" placeholder="the namespace's" inputmode="numeric"></label><button type="button" class="sm" data-add-btn hidden>Add</button></div>`
    : `<div class="muted small" style="margin-top:10px">No free GPU that control knows: add a machine or a cluster under <a href="/ui/settings/machines">Settings › Machines</a>.</div>`;
  return `<div class="sec-sub" id="runners"><div class="sec-head"><h3>Runners <span class="muted small" data-runner-count>${settings.runners.length}</span></h3><span class="small muted">Changes take effect at once, while the run goes on: nothing pauses.</span></div><div class="card flat" data-runner-list data-judge-on-runners="${at.judgeOnRunners ? "1" : ""}">${rows || `<div class="empty" data-runner-none>None yet: the rig runs on its core alone.</div>`}</div>${add}<div data-runner-notes></div>
<details class="adv"><summary>A runner process you started yourself</summary><div class="g3"><label class="fd">${infoLabel("Its name", "The name of a runner process started with THERMITE_ROLE=runner and THERMITE_RUNNER, with the rig's token: it registers its key with control, and the rig's core asks it once it answers. 2 to 40 lowercase letters, digits and dashes.")}<input name="runner_add_name" maxlength="40" placeholder="box-2" data-add-runner></label>
<label class="fd">${infoLabel("Its runners' pools", "One pool for each runner it serves, in its order, separated by commas: judge, shared or lane-1 to lane-16. Each GPU is one runner.")}<input name="runner_add_pools" placeholder="judge, shared"></label></div></details></div>`;
}

/** What a pool means, beside each pool's field. */
const POOL_TIP =
  "The judge's: only the judge measures there. Shared: the judge and every lane, in turn, first come, first served. A lane's: only that lane runs its run_experiment there, and the judge never measures on it.";

/**
 * The rig's runner processes as Edit rig's form asks for them: each kept with its runners' pools
 * as chosen, those taken away left out, and one added by name with its pools. The rig_settings
 * payload checks the result, so a bad name or pool is refused in its words.
 */
export function runnersWanted(
  settings: RigSettings,
  f: Record<string, unknown>,
): { name: string; pools: string[] }[] {
  const kept = settings.runners
    .filter((p) => f[`runner_remove__${p.name}`] !== "1")
    .map((p) => ({
      name: p.name,
      pools: p.pools.map((pool, i) => {
        const v = f[`runner_pool__${p.name}__${i}`];
        return typeof v === "string" && v ? v : pool;
      }),
    }));
  const name = String(f.runner_add_name ?? "").trim();
  if (!name) return kept;
  const pools = String(f.runner_add_pools ?? "")
    .split(/[\s,+]+/)
    .filter(Boolean);
  return [...kept, { name, pools: pools.length ? pools : ["shared"] }];
}
