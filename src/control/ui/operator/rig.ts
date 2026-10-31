import { type ControlStore, fingerprint } from "../../store/index.ts";
import { podStopped, type RigView, type RunView } from "../../views/index.ts";
import { card, esc, icon } from "../components/index.ts";
import { span } from "../words/index.ts";
import type { Need, NeedsContext } from "./index.ts";

/**
 * What waits for the owner on a rig rather than on a change: its report key, its run's agents
 * stopped, a rig that does not report, and a full reset to confirm.
 */

/** A rig's report key as control holds it: the pinned one, and one that waits for the owner. */
type RigKey = ReturnType<ControlStore["reportedRigs"]["key"]>;

/** A rig's report key that waits for the owner: a new rig's first, or a changed one. */
export function keyNeeds(c: NeedsContext, u: RigView, key: RigKey): Need[] {
  const { f, now } = c;
  const out: Need[] = [];
  if (key.pending) {
    const fp = esc(fingerprint(key.pending));
    out.push({
      kind: "key",
      rig: u.id,
      ...card({
        tone: "warn",
        ic: icon.key,
        kind: "New key",
        question: key.pubkey
          ? "Accept this rig's new report key?"
          : "Accept a new rig's report key?",
        headline: key.pubkey
          ? `${esc(u.id)} now signs its reports with a different key`
          : `${esc(u.id)} reported for the first time`,
        why: "Its reports are refused until you accept its key",
        chips: `<span class="chip"><code>${fp}</code></span>`,
        key: `key-${u.id}`,
        u,
        now,
        facts: `<dt>What</dt><dd>${key.pubkey ? "The rig now signs its reports with a different key than the one control pinned." : "This rig reported for the first time."} Until you accept its key, control refuses its reports, so its runs are invisible here.</dd>
<dt>Fingerprint</dt><dd><code>${fp}</code></dd>
<dt>Check</dt><dd>Compare the fingerprint with the one the rig's deployment printed. A key changes only when the rig's identity was rebuilt on purpose.</dd>`,
        choices: [
          {
            button: `<form class="inline" method="post" action="/ui/rigs/${encodeURIComponent(u.id)}/key/accept"><input type="hidden" name="csrf" value="${f.csrf}"><input type="hidden" name="fingerprint" value="${fp}"><button class="primary">Accept this key</button></form>`,
            label: "Accept this key",
            does: "Control pins this key and accepts the rig's reports from now on.",
          },
          {
            label: "Leave it",
            does: "Its reports stay refused. Do this if the fingerprint does not match: something else may be reporting as this rig.",
          },
        ],
      }),
    });
  }
  return out;
}

/** A run whose agents cannot work: a real failure, not a decision. */
export function agentsNeeds(c: NeedsContext, u: RigView, r: RunView): Need[] {
  const { f, now, back } = c;
  const out: Need[] = [];
  // The run's agents stopped on the provider's refusal, model calls that kept failing for 30
  // minutes, or a failing model check (goal 079): a real failure, not a decision; it ends by
  // itself once a model check passes.
  const stop = r.agents_stopped;
  if (stop) {
    const check = stop.kind === "check";
    const failing = stop.kind === "server" || stop.kind === "model";
    out.push({
      kind: "agents",
      rig: u.id,
      run: r.id,
      at: stop.since,
      ...card({
        tone: "bad",
        ic: icon.warn,
        kind: "Agents stopped",
        question: "The agents of this run cannot work",
        headline: check
          ? "The model check of the workers' model fails"
          : failing
            ? `The model's calls keep failing: ${esc(stop.said)}`
            : `The model provider refuses: ${esc(stop.said)}`,
        why: `No trial or plan starts until a model check passes. The provider said: ${esc(stop.words.slice(0, 200))}`,
        key: `agents-${u.id}-${r.id}`,
        u,
        r,
        since: stop.since,
        now,
        facts: `<dt>What</dt><dd>${check ? "The workers' model failed its check." : `A ${esc(stop.by)} found that ${esc(stop.said)}.`} No new trial or plan starts. Trials in progress end as they would. The judge goes on with the changes it has. A research run's clock stops.</dd>
<dt>The provider's words</dt><dd><code>${esc(stop.words)}</code></dd>
<dt>Check</dt><dd>${stop.kind === "credits" ? "Add credits at the provider, or give the rig another model on Edit rig." : stop.kind === "auth" ? "The provider's key in Settings › Providers: it may be wrong, expired or revoked." : stop.kind === "route" ? "The model's name, and whether this key may use it, in Settings › Providers; or give the rig another model on Edit rig." : failing ? "Whether the provider is up, and the provider in Settings › Providers; or give the rig another model on Edit rig. The trial whose calls kept failing has ended: when the agents go on, its lane starts a fresh one, so a conversation the provider kept refusing is left behind." : "The check's result on the rig's page, and the provider in Settings › Providers."}</dd>
<dt>When it ends</dt><dd>Thermite checks the model again after a minute, then less often (at most every 30 minutes). The agents go on once a check passes, or when the rig gets another model.</dd>`,
        choices: [
          {
            button: f.cmd({
              rig: u.id,
              kind: "rig_check",
              fields: { check: "model" },
              label: "Check the model now",
              cls: "primary",
              back,
            }),
            label: "Check the model now",
            does: "The rig checks its workers' model at once. If the check passes, the agents go on.",
          },
          {
            button: `<a class="btn" href="/ui/rigs/${encodeURIComponent(u.id)}/edit">Edit rig</a>`,
            label: "Edit rig",
            does: "Give the rig's agents another model. A new model ends the stop at once.",
          },
        ],
      }),
    });
  }
  return out;
}

/** A rig that does not report: control cannot see its runs. */
export function staleNeeds(c: NeedsContext, u: RigView, key: RigKey): Need[] {
  const { now } = c;
  const out: Need[] = [];
  // A rig whose first key waits for the owner has its own card above: not reporting is why.
  // A stopped RunPod pod can't report, and nothing waits for the owner there.
  const never = !(Date.parse(u.last_seen) > 0);
  if (u.stale && !(never && key.pending) && !podStopped(u)) {
    out.push({
      kind: "stale",
      rig: u.id,
      at: u.last_seen,
      ...card({
        tone: "bad",
        ic: icon.x,
        kind: "Not reporting",
        question: never ? "This rig has not reported yet" : "This rig stopped reporting",
        headline: never ? `${esc(u.id)} has not reported yet` : `${esc(u.id)} stopped reporting`,
        why: never
          ? "Its first report has not come in; control cannot see it yet"
          : `No report for ${esc(span(u.last_seen, now))}; control cannot see its runs`,
        key: `stale-${u.id}`,
        u,
        since: u.last_seen,
        now,
        facts: `<dt>What</dt><dd>${never ? "No report yet." : `No report for ${esc(span(u.last_seen, now))}.`} Its runs may still be working, but control cannot see them, and your commands wait until it reports again.</dd>
<dt>Check</dt><dd>The rig's supervisor and harness containers, and its network path to control.</dd>`,
        choices: [
          {
            button: `<a class="btn" href="/ui/rigs/${encodeURIComponent(u.id)}">Open the rig</a>`,
            label: "Open the rig",
            does: "Its last known state, hardware and actions (restart, full reset).",
          },
        ],
      }),
    });
  }
  return out;
}

/** Each full reset that waits for the owner to confirm its wipe. */
export function resetNeeds(c: NeedsContext, store: ControlStore, vs: RigView[]): Need[] {
  const { f, now } = c;
  const out: Need[] = [];
  for (const rs of store.fullResets.list(20).filter((x) => String(x.state) === "awaiting_owner")) {
    const u = vs.find((x) => x.id === String(rs.rig));
    if (!u) continue;
    out.push({
      kind: "reset",
      rig: u.id,
      at: String(rs.updated_at),
      ...card({
        tone: "bad",
        ic: icon.warn,
        kind: "Wipe",
        question: "Wipe this rig's state?",
        headline: `The full reset of ${esc(u.id)} waits for your confirmation`,
        why: "The rig is paused and its export has left the rig; the wipe cannot be undone",
        key: `reset-${String(rs.id)}`,
        u,
        since: String(rs.updated_at),
        now,
        facts: `<dt>What</dt><dd>You started a full reset. The rig is paused, and its export${rs.export_name ? ` <code>${esc(rs.export_name)}</code>` : ""} has left the rig.</dd>
<dt>Check</dt><dd>Find the export in the results repository before you confirm. A rig without one sent it to control: find it there.</dd>`,
        choices: [
          {
            button: `<form class="inline" method="post" action="/ui/resets/${esc(rs.id)}/confirm"><input type="hidden" name="csrf" value="${f.csrf}"><button class="danger">Confirm the wipe</button></form>`,
            label: "Confirm the wipe",
            does: "The rig's ledger, builds and workspaces are deleted. This cannot be undone; the export is what remains.",
          },
          {
            button: `<form class="inline" method="post" action="/ui/resets/${esc(rs.id)}/cancel"><input type="hidden" name="csrf" value="${f.csrf}"><button>Cancel the reset</button></form>`,
            label: "Cancel the reset",
            does: "Nothing is wiped. The rig stays paused until you resume its run.",
          },
        ],
      }),
    });
  }
  return out;
}
