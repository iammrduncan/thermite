import { clockUtc, commandProgress } from "../command-progress.ts";
import type { ControlStore } from "../store/index.ts";
import { type RigView, type RunView, workOf } from "../views/index.ts";
import { ago, card, esc, fmtInt, icon } from "./components/index.ts";
import type { Forms, Need } from "./operator/index.ts";
import { lastDone } from "./rigs/drain.ts";
import { leaveTrialHref, runHref } from "./urls.ts";
import { clip, span } from "./words/index.ts";

/**
 * A stuck trial (goal 143): one quiet for longer than its rig's quiet setting (none by default),
 * one that repeats the same tool calls, or one that asks again and again for a page the run
 * refused for a reason that lasts (goal 136; its answer counts the asks, so it is no streak of the
 * same answer). It asks the owner under Needs you, with its details
 * behind the card and two choices, Stop this trial… and Leave it running; its lane's row gets
 * only a chip. The facts are the rig's report (at_work, work.open) and the trial's lines in Live.
 * Nothing here ends a trial: the owner decides.
 */

type AtWork = RunView["at_work"][string];

export interface StuckTrial {
  kind: "quiet" | "repeating" | "refused";
  lane: string;
  trial: string;
  /**
   * What makes this stuck spell itself, for Leave it running: the trial's last line (quiet), the
   * streak's start (repeating), or the refused page's address (refused).
   */
  since: string;
  w: AtWork;
}

/** How many asks for a refused page make a trial stuck: a threshold for asking, not a cap. */
export const REFUSED_ASKS = 10;

/** A running run's stuck trials, lane by lane. */
export function stuckTrials(u: Pick<RigView, "settings">, r: RunView, now: number): StuckTrial[] {
  if (r.status !== "running") return [];
  const quiet = u.settings?.quiet_minutes ?? null;
  const out: StuckTrial[] = [];
  for (const lane of Object.keys(r.at_work).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  )) {
    const w = r.at_work[lane] as AtWork;
    if (w.repeating)
      out.push({ kind: "repeating", lane, trial: w.trial, since: w.repeating.since, w });
    else if (w.refused_again && w.refused_again.times >= REFUSED_ASKS)
      out.push({ kind: "refused", lane, trial: w.trial, since: w.refused_again.url, w });
    // An older harness says nothing (undefined). No line yet: quiet since the trial started.
    if (quiet === null || w.last_line_at === undefined) continue;
    const last = w.last_line_at ?? w.since;
    if (now - Date.parse(last) >= quiet * 60_000)
      out.push({ kind: "quiet", lane, trial: w.trial, since: last, w });
  }
  return out;
}

/** The chip on a stuck trial's lane: it leads to its card under Needs you on the run's page. */
export function stuckChip(s: StuckTrial, r: RunView, now: number): string {
  const said =
    s.kind === "quiet"
      ? `quiet for ${span(s.since, now)}`
      : s.kind === "refused"
        ? "repeats a refused request"
        : "repeats the same calls";
  return ` <a class="chip warn" href="${runHref(r)}#needs" title="Its card is under Needs you">${esc(said)}</a>`;
}

/** What a Pi worker's open model call has sent so far, in words; "" when nothing. */
function replyParts(r: NonNullable<AtWork["reply"]>): string {
  return [
    r.tool_args ? `${fmtInt(r.tool_args)} characters of a tool call's arguments` : "",
    r.thinking ? `${fmtInt(r.thinking)} characters of thinking` : "",
    r.text ? `${fmtInt(r.text)} characters of text` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/** Each stuck trial of a running run as a card under Needs you. */
export function stuckNeeds(
  store: ControlStore,
  u: RigView,
  r: RunView,
  f: Forms,
  now: number,
  back: string,
): Need[] {
  const open = workOf(u.summary)?.open ?? [];
  const stops = store.commands.latest(u.id, "stop_trial", 20);
  return stuckTrials(u, r, now).flatMap((s): Need[] => {
    if (store.liveLines.trialLeft(u.id, s.trial, s.kind) === s.since) return [];
    // A stop sent for it: the card leaves at once, and comes back with the reason if refused.
    const stop = stops.find((c) => c.payload.trial === s.trial);
    const progress = stop ? commandProgress(stop, now) : undefined;
    const decided = progress
      ? progress.tone === "bad"
        ? {
            sent: false,
            html: `<span class="bad">Your stop was not taken. ${esc(progress.said)}</span>`,
          }
        : {
            sent: true,
            html: `Stop sent at ${esc(clockUtc(stop?.issued_at ?? ""))}. ${esc(progress.said)}`,
          }
      : undefined;
    const lane = esc(s.lane);
    const reply = s.w.reply;
    const quiet = s.kind === "quiet";
    const counters = open.find((t) => t.trial === s.trial);
    const last = lastDone({ store, rig: u.id, now }, s);
    const facts = [
      ["Running for", `${esc(span(s.w.since, now))}, since ${esc(clockUtc(s.w.since))}`],
      ["Last did something", last.at ? last.html : "nothing in Live from it yet"],
      ...(quiet && reply
        ? [
            [
              "Its model call",
              `In one reply since ${esc(clockUtc(reply.since))}, for ${esc(span(reply.since, now))}: ${esc(replyParts(reply) || "nothing sent yet")} so far. Its worker last reported it ${esc(ago(reply.reported_at, now))} ago.`,
            ],
          ]
        : []),
      ...(s.kind === "refused" && s.w.refused_again
        ? [
            [
              "Same request",
              `This trial asked ${fmtInt(s.w.refused_again.times)} times for a page the run refused before: <code>${esc(clip(s.w.refused_again.url, 160))}</code>, ${esc(s.w.refused_again.reason)}. The run has asked for it ${fmtInt(s.w.refused_again.asked)} times, the last ${esc(ago(s.w.refused_again.at, now))} ago. The harness answers each ask at once, with no download.`,
            ],
          ]
        : []),
      ...(s.w.repeating
        ? [
            [
              "Same calls",
              `${fmtInt(s.w.repeating.count)} since ${esc(clockUtc(s.w.repeating.since))}, ${s.w.repeating.different} different calls. The most repeated:<ul class="stuck-calls">${s.w.repeating.calls.map((c) => `<li><code>${esc(clip(c.call, 160))}</code> ×${fmtInt(c.times)}</li>`).join("")}</ul>`,
            ],
          ]
        : []),
      ...(counters
        ? [
            [
              "Work so far",
              [
                `${fmtInt(counters.turns)} turns`,
                `${fmtInt(counters.tool_calls)} tool calls`,
                `${fmtInt(counters.tokens_in)} tokens in`,
                ...(counters.claims === null ? [] : [`${fmtInt(counters.claims)} verified claims`]),
              ].join(" · "),
            ],
          ]
        : []),
    ]
      .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
      .join("");
    // In the row, Stop this trial… opens the card (a click in a row opens it); the card's foot asks
    // to confirm, with the form, so that nothing in the row's popover folds the card.
    const stopOpen = `<span class="btn sm danger">Stop this trial…</span>`;
    const words = {
      quiet: {
        headline: `${lane}'s trial has sent nothing for ${esc(span(s.since, now))}`,
        why: `Nothing ends a trial for that, so it waits for you.${reply ? ` Its model has been in one reply for ${esc(span(reply.since, now))}.` : ""}`,
        reason: "stopped from Needs you: it was quiet",
        leave:
          "The card goes away. It comes back if the trial sends a line and is then quiet again for as long.",
      },
      repeating: {
        headline: `${lane}'s trial repeats the same tool calls: ${fmtInt(s.w.repeating?.count ?? 0)} since ${esc(clockUtc(s.since))}`,
        why: "It may be stuck. Nothing ends a trial for that, so it waits for you.",
        reason: "stopped from Needs you: it repeated the same calls",
        leave: "The card goes away. A new streak of the same calls brings it back.",
      },
      refused: {
        headline: `${lane}'s trial asks again and again for a page the run refused: ${fmtInt(s.w.refused_again?.times ?? 0)} times`,
        why: "The harness answers each ask at once, with no download, but the trial may be stuck on it. Nothing ends a trial for that, so it waits for you.",
        reason: "stopped from Needs you: it asked again for a refused page",
        leave: "The card goes away. Asks for another refused page bring it back.",
      },
    }[s.kind];
    const stopConfirm = `<div class="stuck-stop"><div class="small"><b>Stop ${lane}'s trial now?</b> It ends as interrupted. Its sources, claims and counters stay. Its task goes back to the top of the run's queue, so a lane takes it up again.</div>${f.cmd({ rig: u.id, kind: "stop_trial", fields: { run: r.id, trial: s.trial, reason: words.reason }, label: "Stop the trial", cls: "danger sm", back })}</div>`;
    const hidden = (k: string, v: string) => `<input type="hidden" name="${k}" value="${esc(v)}">`;
    const leaveForm = `<form class="inline" method="post" action="${esc(leaveTrialHref(r, s.trial))}">${hidden("csrf", f.csrf)}${hidden("kind", s.kind)}${hidden("since", s.since)}${hidden("back", back)}<button class="sm">Leave it running</button></form>`;
    const c = card({
      tone: "warn",
      ic: icon.warn,
      kind: quiet ? "Stuck?" : "Repeats",
      question: `Stop ${s.lane}'s trial, or leave it running?`,
      headline: words.headline,
      why: words.why,
      key: `stuck-${u.id}-${s.trial}-${s.kind}`,
      u,
      r,
      lane: s.lane,
      // A refused page's spell is known by its address: the card gives no age for it.
      since: s.kind === "refused" ? undefined : s.since,
      now,
      facts,
      choices: [
        {
          button: stopOpen,
          label: "Stop this trial",
          does: "It ends as interrupted. Its sources, claims and counters stay, and its task goes back to the top of the run's queue, so a lane takes it up again.",
        },
        {
          button: leaveForm,
          label: "Leave it running",
          does: words.leave,
        },
      ],
      more: stopConfirm,
      decided,
    });
    const at = s.kind === "refused" ? (s.w.refused_again?.at ?? s.w.since) : s.since;
    return [{ kind: "stuck", rig: u.id, run: r.id, at, ...c }];
  });
}
