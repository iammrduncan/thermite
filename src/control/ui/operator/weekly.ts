import { weeklyLimit } from "../../rigs/index.ts";
import type { ControlStore } from "../../store/index.ts";
import type { RigView } from "../../views/index.ts";
import { card, esc, icon, infoLabel } from "../components/index.ts";
import { runHref } from "../urls.ts";
import { span } from "../words/index.ts";
import type { Need, NeedsContext } from "./index.ts";
import { waitEnd } from "./run.ts";

/**
 * A rig whose subscription's weekly usage limit is full (rigs/weekly.ts), under Needs you until the
 * owner chooses: another model for its new trials, in the card, or the wait for the reset. Code
 * never answers the program's own menu at the limit and never switches a model by itself.
 */

/** A provider's kind, as the card names the rig's. */
const KIND: Record<string, string> = {
  claude: "Claude subscription",
  chatgpt: "ChatGPT subscription",
};

/** The weekly limit's card, while the owner has not chosen yet. */
export function weeklyLimitNeeds(c: NeedsContext, store: ControlStore, u: RigView): Need[] {
  const w = weeklyLimit(store, u, c.now);
  if (!w || w.chose) return [];
  const rig = esc(u.id);
  const at = `/ui/rigs/${encodeURIComponent(u.id)}/weekly-limit`;
  const hidden = `<input type="hidden" name="csrf" value="${c.f.csrf}"><input type="hidden" name="until" value="${esc(w.until)}">`;
  const p = w.provider ? store.modelProviders.get(w.provider) : undefined;
  const meta = [
    `since ${esc(waitEnd(w.since))}`,
    w.provider ? `${esc(KIND[p?.type ?? ""] ?? "provider")} “${esc(w.provider)}”` : "",
    w.model ? `model ${esc(w.model)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  // Each provider's models but the subscription that is full, for the rig's new trials.
  const options = store.modelProviders
    .list()
    .filter((x) => x.name !== w.provider)
    .flatMap((x) =>
      x.models.map(
        (m) =>
          `<option value="${esc(`${encodeURIComponent(x.name)}|${encodeURIComponent(m.id)}`)}">${esc(x.name)} · ${esc(m.id)}</option>`,
      ),
    )
    .join("");
  const tip = `The provider and model ${u.id}'s workers take for each trial that starts from now, and its planner when it has no model of its own. A trial under way keeps its model. Edit rig shows and changes the same setting.`;
  const modelMenu = options
    ? `<details class="menu" data-part="weekly-model"><summary class="btn primary">Give ${rig} another model…</summary><div class="menu-pop"><form method="post" action="${at}/model">${hidden}<label>${infoLabel("Model for new trials", tip)}<select name="model" required><option value="">Choose a provider's model…</option>${options}</select></label><div class="muted small">${rig} takes it within a minute. When the subscription resets, ${rig} stays on this model until you change it back.</div><div class="row" style="gap:8px"><button class="primary">Give ${rig} this model</button></div></form></div></details>`
    : `<a class="btn" href="/ui/settings">Add a provider first</a>`;
  const waitForm = `<form class="inline" method="post" action="${at}/wait">${hidden}<button>Wait for the reset</button></form>`;
  const runs = w.runs
    .map(
      (r) =>
        `${r.lane ? `the trial on ${esc(r.lane)} of ` : "a trial of "}<b><a href="${runHref({ id: r.run, campaign: r.campaign })}">${esc(r.run)}</a></b>`,
    )
    .join(" and ");
  return [
    {
      kind: "weekly_limit",
      rig: u.id,
      at: w.since,
      ...card({
        tone: "warn",
        ic: icon.clock,
        kind: "Weekly limit",
        question: `Give ${u.id} another model, or wait for the reset?`,
        headline: `${rig} waits for its subscription's weekly limit`,
        why: "The subscription reached its weekly usage limit: new trials, its planner and its advisors wait for the reset",
        chips: `<span class="chip warn">waits until ${esc(waitEnd(w.until))}</span>`,
        key: `weekly-limit-${u.id}-${w.since}`,
        where: `rig <a href="/ui/rigs/${encodeURIComponent(u.id)}">${rig}</a> · ${meta}`,
        since: w.since,
        now: c.now,
        facts: `<dt>What happened</dt><dd>The subscription reached its weekly usage limit. ${runs.charAt(0).toUpperCase()}${runs.slice(1)} ended, and its experiment went back to the top of the queue. Thermite never answers the program's own menu at the limit.</dd>
<dt>What waits</dt><dd>New trials on ${rig}, its planner and its advisors, until the limit resets: <b>${esc(waitEnd(w.until))}</b> (in ${esc(span(new Date(c.now).toISOString(), Date.parse(w.until)))}). The run stays running; nothing is lost.</dd>
<dt>Your choice</dt><dd>Wait for the reset, or give ${rig} another model meanwhile, for new trials only. Thermite never switches a model by itself.</dd>`,
        choices: [
          {
            button: modelMenu,
            label: `Give ${u.id} another model…`,
            does: `${rig}'s workers take the model you choose for new trials within a minute, as on Edit rig, and its runs stop waiting for the reset. Written to the audit log.`,
          },
          {
            button: waitForm,
            label: "Wait for the reset",
            does: `The card leaves Needs you. ${rig}'s page says it waits until the reset, and new trials start by themselves after it.`,
          },
        ],
      }),
    },
  ];
}
