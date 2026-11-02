import type { Hono } from "hono";
import { runBranchesOf, startFromChampion } from "../../../campaigns/index.ts";
import { ago, esc, infoLabel } from "../../../ui/components/index.ts";
import { campaignHref, RUN_ROUTES, runHref } from "../../../ui/urls.ts";
import type { RigView, RunOnRig } from "../../../views/index.ts";
import type { Ctx, Dashboard } from "../../context.ts";

/**
 * A run's work in git on its page (goal 185): the champion branch and the lanes' branches as its
 * rig last pushed them, each champion's commit with its menu (start a campaign from it, copy its
 * commit, download it as a patch), and the drawer that starts a campaign from a champion, with
 * the run's contract or a changed one.
 */

/** A web page for a branch on a code host control knows the shape of; undefined for others. */
function branchPage(git: string, branch: string): string | undefined {
  const m =
    /^https:\/\/(github\.com|gitlab\.com|codeberg\.org)\/([^/]+\/[^/]+?)(?:\.git)?$/.exec(git) ??
    /^git@(github\.com|gitlab\.com|codeberg\.org):([^/]+\/[^/]+?)(?:\.git)?$/.exec(git);
  if (!m) return undefined;
  return `https://${m[1]}/${m[2]}/${m[1] === "gitlab.com" ? "-/tree" : m[1] === "codeberg.org" ? "src/branch" : "tree"}/${branch}`;
}

export function runGitParts(dash: Dashboard) {
  const { store, csrf } = dash;
  const branches = (x: RunOnRig) =>
    runBranchesOf(store.reportedRigs.supervisor(x.rig.id), x.run.id);

  /** The line under the Champions heading: where the branches are, and when they were pushed. */
  const gitLine = (x: RunOnRig, now: number): string => {
    const b = branches(x);
    if (!b) return "";
    const commits = Object.keys(b.champions).length;
    const page = branchPage(b.git, b.branch);
    const branch = page
      ? `<a class="mono" href="${esc(page)}" target="_blank" rel="noopener">${esc(b.branch)}</a>`
      : `<span class="mono">${esc(b.branch)}</span>`;
    const lanes = Object.keys(b.lanes).map((l) => l.split("/").pop() ?? l);
    const when = b.pushed_at ? `pushed ${esc(ago(b.pushed_at, now))} ago` : "not pushed yet";
    return `<div class="gitline" data-part="run-git"><span>In git:</span>${branch}<span class="muted small">${commits} commit${commits === 1 ? "" : "s"} · ${when}${b.waiting ? " · more to push" : ""}${lanes.length ? ` · each lane's work: ${esc(lanes.join(", "))}` : ""}</span>${b.error ? `<div class="bad small" style="flex-basis:100%">${esc(b.error)}</div>` : ""}</div>`;
  };

  /** A champion's commit and its menu, on its row; empty when it is not in git. */
  const championGit = (x: RunOnRig, seq: number, patch: string): string => {
    const b = branches(x);
    const sha = b?.champions[String(seq)];
    if (!b || !sha) return "";
    const from = `${runHref(x.run)}?from_champion=${seq}#from-champion`;
    return `<details class="menu lad-menu"><summary aria-label="More for champion #${seq}">⋯</summary><div class="menu-pop">${
      x.earlier
        ? ""
        : `<a class="mi" href="${esc(from)}">Start a campaign from #${seq}<span class="muted small">its commit as the starting point; the contract as it is, or changed</span></a>`
    }<button type="button" class="mi" data-copy="${esc(sha)}">Copy its commit, ${esc(sha.slice(0, 7))}<span class="muted small">on ${esc(b.branch)}</span></button>${patch}</div></details><span class="lad-sha mono">${esc(sha.slice(0, 7))}</span>`;
  };

  /** The rigs a campaign of this kit can run on: those with the contract's kind of target. */
  const fits = (contract: unknown, vs: RigView[]) => {
    const t = (contract as { target?: { type?: string } } | undefined)?.target?.type;
    return vs.filter((u) => !t || u.hardware?.target?.type === t);
  };

  /** The drawer: a new campaign from champion `seq` of the run, open when the page asks. */
  const fromDrawer = (c: Ctx, x: RunOnRig, vs: RigView[]): string => {
    const seq = Number(c.req.query("from_champion") ?? "");
    const b = branches(x);
    if (!b || x.earlier) return "";
    const n =
      Number.isInteger(seq) && b.champions[String(seq)]
        ? seq
        : Math.max(...Object.keys(b.champions).map(Number));
    const sha = b.champions[String(n)] ?? "";
    const campaign = x.run.campaign || x.run.id;
    const assigned = store.runRegistry.assigned(x.run.id);
    const payload = assigned ? store.commands.row(assigned.command)?.payload : undefined;
    const contract = JSON.stringify(payload?.contract ?? {}, null, 2);
    const name = `${campaign.slice(0, 48)}-from-${n}`;
    const open = Number.isInteger(seq) && seq > 0;
    const rigs = fits(payload?.contract, vs)
      .map(
        (u) =>
          `<option value="${esc(u.id)}"${u.id === x.rig.id ? " selected" : ""}>${esc(u.id)}</option>`,
      )
      .join("");
    return `<div class="drawer-wrap" id="from-champion"${open ? "" : " hidden"}><a class="drawer-bg" href="${runHref(x.run)}" data-close aria-label="Close"></a>
<aside class="drawer" aria-label="Start a campaign from a champion"><form method="post" action="${runHref(x.run)}/from-champion" class="drawer-form" autocomplete="off">
<header><h3>Start a campaign from champion #${n}</h3><span class="grow"></span><a class="btn sm ghost" href="${runHref(x.run)}" data-close>Close</a></header>
<div class="drawer-body"><input type="hidden" name="csrf" value="${esc(csrf(c))}"><input type="hidden" name="champion" value="${n}">
<p class="cp-why">Its code is commit <code>${esc(sha.slice(0, 12))}</code> on <code>${esc(b.branch)}</code>. The new campaign keeps ${esc(campaign)}'s kit and MCP servers, and its work goes where this run's went.</p>
<label class="sfd">${infoLabel("Name", "Lowercase letters, digits, dashes and underscores, at most 64. Its runs are named name-1, name-2.")}<input name="name" value="${esc(name)}" required spellcheck="false" autocapitalize="off"></label>
<fieldset class="sfd"><legend>${infoLabel("Contract", `What the judge decides by. Keep ${campaign}'s, or change it here: control checks it before anything starts, and its campaign and version become the new campaign's.`)}</legend>
<label class="chk"><input type="radio" name="contract_choice" value="same" checked> The same as this run's</label>
<label class="chk"><input type="radio" name="contract_choice" value="change"> Change it</label>
<textarea name="contract" class="mono" rows="14" spellcheck="false" data-when-change>${esc(contract)}</textarea></fieldset>
<label class="chk">${`<input type="checkbox" name="grant" value="1" checked>`} Its runs may read ${esc(campaign)}'s collection<span class="muted small">What ${esc(campaign)}'s runs found, in the knowledge base: a grant you can revoke. Untick it to start from nothing.</span></label>
<label class="sfd">${infoLabel("First run on", "A rig with the hardware the kit measures on. It fetches the champion's commit from the repository.")}<select name="rig"><option value="">None: save it only</option>${rigs}</select></label>
<details class="adv"><summary>The same over REST and MCP</summary><div><pre class="json">${esc(JSON.stringify({ name, from: { run: x.run.id, champion: n }, rig: x.rig.id, grant: true }, null, 2))}</pre><div class="muted small">POST /v1/campaigns/from-champion, or MCP's start_campaign, with "contract" for a changed one.</div></div></details>
</div>
<footer><span class="grow small muted">A new campaign, version 1, starting from champion #${n}.</span><button class="primary">Start the campaign</button></footer>
</form></aside></div>`;
  };

  return { branches, gitLine, championGit, fromDrawer };
}

/** The drawer's form: the new campaign saved, and its first run started when a rig is chosen. */
export function runGitRoutes(app: Hono, dash: Dashboard): void {
  const { parts } = dash;
  app.post(`${RUN_ROUTES.run}/from-champion`, async (c) => {
    const f = await c.req.parseBody();
    const campaign = c.req.param("campaign") ?? "";
    const run = c.req.param("run") ?? "";
    const champion = Number(f.champion ?? "");
    const back = (m: string) =>
      c.redirect(
        `${runHref({ id: run, campaign })}?from_champion=${champion}&error=${encodeURIComponent(m)}#from-champion`,
        303,
      );
    let contract: Record<string, unknown> | undefined;
    if (String(f.contract_choice ?? "") === "change") {
      try {
        contract = JSON.parse(String(f.contract ?? "")) as Record<string, unknown>;
      } catch (err) {
        return back(`The changed contract is not JSON: ${String(err).slice(0, 200)}`);
      }
      if (!contract || typeof contract !== "object" || Array.isArray(contract))
        return back("The changed contract is not a JSON object.");
    }
    const rig = String(f.rig ?? "");
    const out = await startFromChampion(
      parts,
      {
        name: String(f.name ?? "").trim(),
        from: { run, champion },
        ...(contract ? { contract } : {}),
        ...(rig ? { rig } : {}),
        grant: String(f.grant ?? "") === "1",
      },
      "owner:ui",
      true,
    );
    if (!out.ok) return back(out.error);
    if (out.run) return c.redirect(runHref({ id: out.run, campaign: out.campaign }), 303);
    const said = out.said ?? `Saved ${out.campaign}, starting from champion #${champion}.`;
    return c.redirect(`${campaignHref(out.campaign)}?ok=${encodeURIComponent(said)}`, 303);
  });
}
