import { BUS_KEY_CHANGE_STEPS, BUS_KEYS_SEEN_STEP, busUsersOf } from "../../bus/index.ts";
import { clockUtc } from "../../command-progress.ts";
import { STEP_WORDS } from "../../rigs/index.ts";
import type { ControlStore } from "../../store/index.ts";
import type { RigView } from "../../views/index.ts";
import { card, esc, icon } from "../components/index.ts";
import { span } from "../words/index.ts";
import type { Need, NeedsContext } from "./index.ts";

/**
 * What the message bus shows the owner, with nothing to approve: a rig's keys on the bus that
 * changed or were refused since the owner last saw them, and the bus's server that keeps not
 * taking control's users file.
 */

/** A rig's keys on the bus that changed, or were refused, since the owner pressed Seen. */
export function busKeyNeeds(c: NeedsContext, store: ControlStore, u: RigView): Need[] {
  const steps = store.rigHistory.latest(u.id, [...BUS_KEY_CHANGE_STEPS, BUS_KEYS_SEEN_STEP], 10);
  const seen = steps.findIndex((s) => s.step === BUS_KEYS_SEEN_STEP);
  const changes = (seen < 0 ? steps : steps.slice(0, seen)).reverse();
  const last = changes.at(-1);
  if (!last) return [];
  const refused = changes.some((s) => !s.ok);
  const rows = changes
    .map(
      (s) =>
        `${esc(clockUtc(s.at))}: ${esc(STEP_WORDS[s.step] ?? s.step)}${s.detail ? ` (${esc(s.detail)})` : ""}.`,
    )
    .join("<br>");
  const seenForm = `<form class="inline" method="post" action="/ui/rigs/${encodeURIComponent(u.id)}/bus-keys/seen"><input type="hidden" name="csrf" value="${c.f.csrf}"><input type="hidden" name="back" value="${esc(c.back)}"><button>Seen</button></form>`;
  return [
    {
      kind: "bus_key",
      rig: u.id,
      at: last.at,
      ...card({
        tone: refused ? "bad" : "warn",
        ic: icon.key,
        kind: refused ? "Key refused" : "Key changed",
        question: refused
          ? "Control refused a key this rig registered on the message bus"
          : "This rig's key on the message bus changed",
        headline: refused
          ? `${esc(u.id)}'s new key on the message bus was refused ${esc(span(last.at, c.now))} ago`
          : `${esc(u.id)}'s key on the message bus changed ${esc(span(last.at, c.now))} ago`,
        why: refused
          ? "Another rig or control holds that key, so the rig can't use the bus with it. Nothing waits for your approval"
          : "The new key took effect at once, and the old one no longer works. Nothing waits for your approval",
        key: `bus-key-${u.id}-${last.at}`,
        u,
        since: last.at,
        now: c.now,
        facts: `<dt>What</dt><dd>${rows}</dd>
<dt>Check</dt><dd>A rig's supervisor makes its keys in its home, once, so they change only when that home was emptied or the rig was set up again. If neither happened, look at who holds the rig's token. A refused key belongs to another rig or to control: the rig needs a home of its own.</dd>`,
        choices: [
          {
            button: seenForm,
            label: "Seen",
            does: "The card leaves Needs you. The changes stay in the rig's history, on its page.",
          },
          {
            button: `<a class="btn" href="/ui/rigs/${encodeURIComponent(u.id)}">Open the rig</a>`,
            label: "Open the rig",
            does: "Its keys on the bus and their history.",
          },
        ],
      }),
    },
  ];
}

/** The bus's server that keeps not taking control's users file: control tries again by itself. */
export function busUsersNeeds(c: NeedsContext, store: ControlStore): Need[] {
  const t = busUsersOf(store)?.keepsFailing();
  if (!t) return [];
  const what =
    t.step === "write"
      ? "Control can't write the bus's users file"
      : "The bus's server does not reload its users";
  return [
    {
      kind: "bus_users",
      rig: "",
      at: t.since,
      ...card({
        tone: "bad",
        ic: icon.warn,
        kind: "Bus users",
        question: `${what}`,
        headline: `${esc(what)} since ${esc(clockUtc(t.since))}`,
        why: "A new or changed key, a retired rig and a new run's live lines wait until it does; users signed in already go on. Control tries again every 5 seconds",
        key: `bus-users-${t.since}`,
        where: "control",
        since: t.since,
        now: c.now,
        facts: `<dt>What</dt><dd>${esc(what)} for ${esc(span(t.since, c.now))}.</dd>
<dt>The last error</dt><dd><code>${esc(t.error)}</code></dd>
<dt>Check</dt><dd>${t.step === "write" ? "That control may write to THERMITE_NATS_CONFIG_DIR, and that its disk has room." : "That the bus's server (the nats service) runs, that control reaches it at THERMITE_NATS_URL, and its own log, which says why it did not take the file."} The card goes away by itself once the server takes the file.</dd>`,
        choices: [
          {
            label: "Leave it",
            does: "Control goes on trying every 5 seconds. Nothing waits for your approval.",
          },
        ],
      }),
    },
  ];
}
