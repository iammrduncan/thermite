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

/**
 * Edit rig's runners (goal 206): each runner process with the pool of each of its runners and
 * Take it away, then one to add that you started yourself, by its name and its runners' pools.
 * The whole list goes to the rig as its `runners` setting, which its core takes while it works.
 */
export function runnersFields(u: RigView, settings: RigSettings): string {
  const state = new Map((u.runners?.processes ?? []).map((p) => [p.name, p]));
  const now = Date.now();
  const rows = settings.runners
    .map((p) => {
      const seen = state.get(p.name);
      const pools = p.pools
        .map(
          (pool, i) =>
            `<label class="fd">${infoLabel(`Runner ${i}'s pool`, POOL_TIP)}<select name="runner_pool__${esc(p.name)}__${i}" data-label="${esc(p.name)}'s runner ${i}'s pool">${poolOptions(pool, settings.lanes)}</select></label>`,
        )
        .join("");
      return `<div class="rn"><div><b>${esc(p.name)}</b> ${seen ? stateHtml(seen, now) : `<span class="chip">joining</span>`}</div><div class="g3">${pools}</div><label class="small"><input type="checkbox" name="runner_remove__${esc(p.name)}" value="1" data-runner="${esc(p.name)}"> Take it away: its run under way fails, and the judge or its lane tries again</label></div>`;
    })
    .join("");
  return `<div class="sec-sub" id="runners"><h3>Runners</h3><p class="lead small">Changes take effect at once, while the run goes on: nothing pauses. A runner takes one run at a time; on a shared one the judge and the lanes take turns.</p>${rows ? `<div class="card flat">${rows}</div>` : `<div class="muted small">None: the rig runs on its own machine alone.</div>`}
<div class="g3" style="margin-top:10px"><label class="fd">${infoLabel("Add a runner you started yourself", "The name of a runner process started with THERMITE_ROLE=runner and THERMITE_RUNNER, with the rig's token: it registers its key with control, and the rig's core asks it once it answers. 2 to 40 lowercase letters, digits and dashes.")}<input name="runner_add_name" maxlength="40" placeholder="box-2" data-add-runner></label>
<label class="fd">${infoLabel("Its runners' pools", "One pool for each runner it serves, in its order, separated by commas: judge, shared or lane-1 to lane-16. Each GPU is one runner.")}<input name="runner_add_pools" placeholder="judge, shared"></label></div></div>`;
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
