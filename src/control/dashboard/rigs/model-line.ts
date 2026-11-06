import { compactAtWords } from "../../../core/compaction.ts";
import {
  checkRow,
  checkRowsOf,
  checkWaits,
  modelFollowUrl,
  takingModel,
} from "../../command-progress.ts";
import { capWords } from "../../providers/index.ts";
import { HARNESS_NAMES } from "../../rigs/index.ts";
import type { ControlStore } from "../../store/index.ts";
import { esc } from "../../ui/components/index.ts";
import { checkFollowUrl, modelCheckHtml } from "../../ui/rigs/checks.ts";
import type { RigView } from "../../views/index.ts";

/**
 * What a rig's agents run, on the rig's page (goal 203; Settings › Rigs' models said it before):
 * the harness, model and provider control gave it, with its context cap and compaction point, or
 * the rig's own settings; whether it is taking a new model; and its model check, followed while
 * it runs. The model is changed on Edit rig.
 */
export function agentsModelBlock(store: ControlStore, u: RigView, now: number): string {
  const m = u.model;
  const want = store.agentModels.byRig()[u.id];
  // A cap on the model's context window (goal 070), once the rig runs that model.
  const same = want && m?.name === want.provider && m.model === want.model;
  const capped =
    same && want.contextCap
      ? capWords(
          store.modelProviders.get(want.provider)?.models.find((x) => x.id === want.model)
            ?.context_window ?? 0,
          want.contextCap,
        )
      : undefined;
  // Its compaction point (goal 070), with the model it was set with.
  const compacts = same
    ? ` Its conversations are compacted at ${compactAtWords(want.compactAt)}.`
    : "";
  const uses = !m
    ? "Its harness does not report its model (it needs a newer image)."
    : m.source === "control"
      ? `Its agents run under ${HARNESS_NAMES[m.harness]} with ${m.model} from ${m.name}.${capped ? ` Its context window: ${capped}.` : ""}${compacts}`
      : m.source === "environment"
        ? `Its agents use the rig's own settings (${m.model}, under ${HARNESS_NAMES[m.harness]}).`
        : "Its agents have no model: they wait.";
  const taking = takingModel(m, want);
  const moving = !taking
    ? ""
    : want
      ? ` <span class="chip info">taking ${esc(want.model)} under ${esc(HARNESS_NAMES[want.harness])}</span>`
      : ` <span class="chip info">going back to its own settings</span>`;
  // The model check in its state now: sent, running, its result, or why it did not run.
  const chk =
    checkRowsOf(store, u.id, u.checks, now).model ?? checkRow("model", undefined, undefined, now);
  const bad = chk.state === "failed" || chk.state === "refused" || chk.state === "expired";
  // The block follows the rig while it takes the model, then its check (goal 080).
  const follow = taking
    ? ` data-follow="${esc(modelFollowUrl(u.id))}" data-follow-state="taking"`
    : checkWaits(chk)
      ? ` data-follow="${esc(checkFollowUrl(u.id, "model"))}" data-follow-state="${chk.state}"`
      : "";
  return `<div class="block" data-part="agents-model"><div class="head"><h2>The agents' model</h2><span class="right"><a href="/ui/rigs/${encodeURIComponent(u.id)}/edit">Change it on Edit rig</a></span></div><div class="card flat"><div class="ck rr-route"${follow}><span class="ck-main"><span>${esc(uses)}${moving}</span><span class="ck-sum ${bad ? "bad" : ""}">${modelCheckHtml(chk, now)}</span></span></div></div></div>`;
}
