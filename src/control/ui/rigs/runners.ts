import type { RigSettings } from "../../../core/rig-settings.ts";
import type { RigView, RunnersView } from "../../views/index.ts";
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

/** Who waits for a runner, in words: the judge once, each lane's run. */
function waitingWords(waiting: string[]): string {
  const who = [
    ...new Set(
      waiting.map((w) =>
        w.startsWith("executor-") ? "the judge" : `${w.replace("lane-", "lane ")}'s run_experiment`,
      ),
    ),
  ];
  return who.join(", ");
}

/** The block: the runners, and who waits. Empty for a rig without runners. */
export function runnersBlock(u: RigView, now: number): string {
  const r = u.runners;
  if (!r) return "";
  const rows = r.processes
    .flatMap((p) =>
      p.runners.map(
        (x) =>
          `<tr><td><b>${esc(x.name)}</b><br><span class="small muted">runner process ${esc(p.name)}</span></td><td><span class="chip${x.pool === "judge" ? " warn" : x.pool === "shared" ? " info" : ""}">${esc(poolWords(x.pool))}</span></td><td>${stateHtml(p, now)}</td><td>${nowHtml(u, x.holder)}</td></tr>`,
      ),
    )
    .join("");
  const count = r.processes.reduce((n, p) => n + p.runners.length, 0);
  const waiting = r.waiting.length
    ? `<div class="small" style="margin-top:8px"><b>Waiting for a runner:</b> ${esc(waitingWords(r.waiting))}.</div>`
    : "";
  return `<div class="block" data-part="runners"><div class="head"><h2>Runners</h2><span class="n">${count}</span><span class="right"><a href="/ui/rigs/${encodeURIComponent(u.id)}/edit#where">Add or take away runners on Edit rig</a> · the run goes on</span></div><div class="card flat" style="overflow-x:auto"><table class="ut"><thead><tr><th scope="col">Runner</th><th scope="col">Pool</th><th scope="col">State</th><th scope="col">Now</th></tr></thead><tbody>${rows}</tbody></table></div>${waiting}<div class="small muted" style="margin-top:6px">The core keeps the run: its records, the planner, the lanes' agent programs and the judge's decisions. Each runner takes one run at a time; on a shared one the judge and the lanes take turns, first come, first served.</div></div>`;
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
 * it is, whether it answers, its GPU, its pool, what it runs now and Remove, which asks first and
 * says what happens to that run; then Add a runner, a free GPU of a machine or cluster control
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
      const ask = job
        ? `${p.name} is at work: on save, ${job}. No verdict is lost and nothing counts against the change.`
        : `${p.name} leaves the rig on save. Nothing runs there now.`;
      return `<div class="er-row" data-runner-row="${esc(p.name)}" data-job="${esc(job)}" data-product="${esc(placed?.product ?? "")}"><span class="er-what"><span><b>${esc(p.name)}</b> <span class="chip">${esc(placed?.where ?? "started by you")}</span> ${stateChip(seen, now)}</span><span class="small muted">${esc(placed?.gpu ?? `${p.pools.length} runner${p.pools.length > 1 ? "s" : ""}`)}</span></span><span class="er-pools">${pools}</span><span class="small" data-runner-now>${nowText}</span><span class="er-btns"><label class="btn er-rm"><input type="checkbox" name="runner_remove__${esc(p.name)}" value="1" data-runner="${esc(p.name)}"> Remove</label><button type="button" class="sm" data-keep hidden>Keep it</button></span><div class="er-ask" data-ask hidden role="alert"><span>${esc(ask)}</span><button type="button" class="sm" data-ask-cancel>Cancel</button><button type="button" class="sm danger" data-ask-go>Remove ${esc(p.name)}</button></div></div>`;
    })
    .join("");
  const add = at.add.length
    ? `<div class="card er-add"><label class="fd">${infoLabel("Add a runner", "A GPU of a machine or cluster control knows that no rig uses. Control sets it up on Save changes, and it joins its pool once it answers the core: a run waits for it, and none fails while it starts.")}<select name="add_at" data-add-at><option value="">Choose a GPU</option>${at.add.map((x) => `<option value="${esc(x.value)}" data-product="${esc(x.product)}">${esc(x.text)}</option>`).join("")}</select></label><label class="fd">${infoLabel("Its pool", POOL_TIP)}<select name="add_pool" data-add-pool>${poolOptions("shared", settings.lanes)}</select></label><button type="button" class="sm" data-add-btn hidden>Add</button></div>`
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
