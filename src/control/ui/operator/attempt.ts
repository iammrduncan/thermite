import { SCREENED_VERDICTS, WON_VERDICTS } from "../../../core/verdicts.ts";
import { type AttemptView, type RigView, type RunView, runCampaign } from "../../views/index.ts";
import { ago, esc, moreText } from "../components/index.ts";
import { liveHref, runHref } from "../urls.ts";
import { auditReason, verdictText } from "../words/index.ts";
import { cap, evidence, short } from "./change.ts";
import { heldOutBlock } from "./held-out.ts";
import type { Need } from "./index.ts";
import { outcome } from "./outcome.ts";
import { timeline } from "./timeline.ts";
import { withdrawnBlock } from "./withdraw.ts";

/**
 * Why the static checks refused a change before building (goal 082): each violation, as the
 * submitting trial got it, and how many more when the rig sent only the first 20.
 */
function refusedBlock(a: AttemptView): string {
  if (!a.violations_total) return "";
  const more = a.violations_total - a.violations.length;
  return `<div class="block"><div class="head"><h2>Refused before building</h2><span class="n">${a.violations_total}</span><span class="right">the static checks: the editable paths, the forbidden patterns, no binary files, links or submodules</span></div><div class="card flat">${a.violations
    .map((v) => `<div class="fw">${esc(v)}</div>`)
    .join(
      "",
    )}${more > 0 ? `<div class="fw muted small">and ${more} more: the rig's record of the attempt keeps them all</div>` : ""}</div></div>`;
}

/**
 * One attempt, in full: what it does and where it stands in one sentence, the decision it waits
 * for, then what happened to it, the goals it moves, the files it changes and its facts.
 */
export function attemptDetail(
  u: RigView,
  r: RunView,
  a: AttemptView,
  now: number,
  opts: {
    decision?: Need | undefined;
    patch?: string | undefined;
    /** The owner's form to withdraw its evidence, or its preview (goal 174). */
    withdraw?: string | undefined;
  } = {},
): string {
  const o = outcome(r, a, u);
  const base = r.champion.filter((c) => !c.reopened && c.commit === a.parent).at(-1);
  const champ = r.champion.find((c) => c.attempt === a.id && !c.reopened);
  const audit = r.audits.filter((x) => x.attempt === a.id).at(-1);
  const on = base ? `, on champion #${base.seq}` : "";
  // It waited for a decision when its run closed (goal 087): no buttons, and why.
  const leftOpen = o.word === "Run closed";
  const closedAt = leftOpen
    ? r.timeline
        .filter(
          (e) => e.kind === "run_status" && (e.body as { status?: unknown }).status === "closed",
        )
        .at(-1)?.at
    : undefined;
  const state = champ
    ? `It became champion #${champ.seq}: the lanes build on it.`
    : o.word === "Withdrawn"
      ? "Its evidence was withdrawn: it can't become the champion."
      : opts.decision
        ? "It waits for your decision."
        : leftOpen
          ? "The run closed while this change waited for a decision. It does not become the champion, and the rig refuses a decision on it."
          : a.lifecycle === "declined"
            ? "You declined it: it never becomes the champion."
            : audit?.decision === "block"
              ? "The auditor blocked it."
              : "";
  const said = `${esc(a.lane ?? "Someone")} submitted it ${esc(ago(a.recorded_at, now))} ago${a.lane ? "" : " by hand"}${esc(on)}. ${esc(evidence(r, a))}${state ? ` <b class="${o.tone === "ok" ? "ok" : o.tone === "bad" ? "bad" : "warn"}">${esc(state)}</b>` : ""}`;

  // What happened to it, in order: submitted, each verdict, its audit, its promotion.
  const steps = [
    { at: a.recorded_at, text: `Submitted${a.lane ? ` by ${a.lane}` : " by hand"}`, tone: "" },
    ...a.history.map((h) => ({
      at: h.at,
      text: cap(verdictText(h.verdict, h.delta)),
      tone: WON_VERDICTS.includes(h.verdict)
        ? "ok"
        : [...SCREENED_VERDICTS, "neutral", "no_progress"].includes(h.verdict)
          ? ""
          : "bad",
    })),
    ...(audit
      ? [
          {
            at: audit.at,
            text:
              audit.decision === "block"
                ? `The auditor blocked it: ${audit.reasons ?? "no reasons given"}`
                : audit.decision === null
                  ? `Held for an audit: ${auditReason(audit.reason)}`
                  : audit.decision === "clear"
                    ? "The auditor cleared it"
                    : audit.decision === "skipped"
                      ? "This rig has no auditor: the audit was skipped"
                      : "The auditor passed it to you",
            tone:
              audit.decision === "block"
                ? "bad"
                : audit.decision === "clear"
                  ? "ok"
                  : audit.decision === "skipped"
                    ? ""
                    : "warn",
          },
        ]
      : []),
    ...(r.pending_promotions.includes(a.id) || (leftOpen && a.lifecycle === "awaiting_approval")
      ? [
          {
            at: r.promotion_waits[a.id]?.at ?? a.updated_at,
            text: leftOpen ? "Waited for your approval" : "Waits for your approval",
            tone: leftOpen ? "" : "warn",
          },
        ]
      : []),
    ...(closedAt ? [{ at: closedAt, text: "The run closed: no decision now", tone: "" }] : []),
    ...(a.lifecycle === "declined"
      ? [{ at: a.updated_at, text: "Declined by you", tone: "" }]
      : []),
    ...(champ ? [{ at: champ.at, text: `Became champion #${champ.seq}`, tone: "ok" }] : []),
  ].sort((x, y) => x.at.localeCompare(y.at));
  const stepper = `<ol class="stepper">${steps.map((x) => `<li class="${x.tone}"><span class="sd"></span><span class="st">${esc(x.text)}</span><span class="sa">${esc(ago(x.at, now))}</span></li>`).join("")}</ol>`;
  const history = r.timeline.filter(
    (e) =>
      e.subject === a.id ||
      (e.kind.startsWith("job_") &&
        u.judge.jobs.find((j) => j.id === e.subject)?.attempt === a.id) ||
      (e.kind === "trial_finished" && (e.body as { attempt?: unknown }).attempt === a.id),
  );

  // The goals it moves, against the champion it was measured on.
  const goals =
    r.mode === "goal" && r.goals.length
      ? `<div class="block"><div class="head"><h2>Goals</h2><span class="right">against the champion it was measured on${base ? ` (#${base.seq})` : ""}</span></div><div class="card flat">${r.goals
          .map((g) => {
            const gained = a.gained?.includes(g.goal);
            const lost = a.lost.includes(g.goal);
            const unsure = a.unsure.includes(g.goal);
            const [tone, mark, word] = gained
              ? ["ok", "✓", "newly met"]
              : lost
                ? ["bad", "✕", "lost"]
                : unsure
                  ? ["off", "·", "could not check"]
                  : g.status === "met"
                    ? ["ok", "✓", "met by the champion too"]
                    : ["off", "·", "not met yet"];
            return `<div class="gl"><span class="gl-mark ${tone}">${mark}</span><span class="gl-main"><span><b>${esc(g.goal)}</b> ${gained || lost ? `<span class="chip ${tone}">${esc(word)}</span>` : `<span class="muted small">${esc(word)}</span>`}</span>${g.description ? `<div class="muted">${moreText(g.description, 200)}</div>` : ""}</span></div>`;
          })
          .join("")}</div></div>`
      : "";

  // The files it changes, with their line counts as bars.
  const most = Math.max(1, ...a.files.map((f) => (f.added ?? 0) + (f.removed ?? 0)));
  const bar = (n: number) => `${Math.round((n / most) * 120)}px`;
  const files = a.files.length
    ? `${a.files
        .map(
          (f) =>
            `<div class="fl"><code>${esc(f.path)}</code>${
              f.added === null
                ? `<span class="fl-bar"></span><span class="muted small">binary</span>`
                : `<span class="fl-bar"><i class="add" style="width:${bar(f.added)}"></i><i class="rem" style="width:${bar(f.removed ?? 0)}"></i></span><span class="fl-n"><span class="ok">+${f.added}</span> <span class="bad">−${f.removed ?? 0}</span></span>`
            }</div>`,
        )
        .join(
          "",
        )}${a.files_total > a.files.length ? `<div class="fl muted small">and ${a.files_total - a.files.length} more</div>` : ""}`
    : `<div class="empty">The rig did not report its files (an older harness).</div>`;

  const facts = [
    ["Run", `<a href="${runHref(r)}">${esc(runCampaign(r))} › ${esc(r.id)}</a> on ${esc(u.id)}`],
    ["Lane", esc(a.lane ?? "none: submitted by hand")],
    ...(a.family ? [["Direction", esc(a.family)]] : []),
    [
      "Made on",
      `${base ? `champion #${base.seq} ` : ""}<code class="muted" title="${esc(a.parent ?? "")}">${esc(short(a.parent))}</code>`,
    ],
    ["Commit", `<code>${esc(a.commit ?? "?")}</code>`],
    [
      "Submitted",
      `${esc(ago(a.recorded_at, now))} ago <span class="muted small">(${esc(a.recorded_at.slice(0, 16).replace("T", " "))} UTC)</span>`,
    ],
    ...(a.trial
      ? [
          [
            "Trial",
            `<a href="${liveHref(u.id, `trial:${a.trial}`)}"><code>${esc(a.trial)}</code></a> <span class="muted small">(its session, while the live log keeps it)</span>`,
          ],
        ]
      : []),
  ]
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`)
    .join("");

  return `<div class="att-head"><div class="att-crumb"><span class="chip ${o.tone}">${esc(o.word)}</span>${esc(runCampaign(r))} › ${esc(r.id)} › attempt ${esc(a.id)}</div><h1 class="att-title">${esc(a.hypothesis ?? "(no hypothesis given)")}</h1>${opts.patch ? `<div class="small">${opts.patch}</div>` : ""}</div>
<p class="run-said">${said}</p>
${opts.decision ? `<div class="block"><div class="head"><h2>Your decision</h2></div>${opts.decision.box}</div>` : ""}
<div class="cols run-cols"><div>
${refusedBlock(a)}
${a.known_flaws.length ? `<div class="block"><div class="head"><h2>Flaws its author declared</h2><span class="n">${a.known_flaws.length}</span></div><div class="card flat">${a.known_flaws.map((f) => `<div class="fw">${esc(f)}</div>`).join("")}</div></div>` : ""}
<div class="block"><div class="head"><h2>What happened to it</h2></div><div class="card">${stepper}</div>
<details class="card flat matrix" data-k="events-${esc(a.id)}" style="margin-top:10px"><summary>Every event <span class="muted small">${history.length}</span></summary>${timeline(
    history.map((e) => ({ u, e })),
    now,
    { limit: 100 },
  )}</details></div>
${withdrawnBlock(r, a, now)}
${heldOutBlock(a, now)}
${goals}
<div class="block"><div class="head"><h2>Files it changes</h2><span class="n">${a.files_total}</span><span class="right">the diff stays on the rig: <code>attempts/${esc(a.id)}.patch</code> in its exports</span></div><div class="card flat">${files}</div></div>
</div><div class="side">
<div class="block"><div class="head"><h2>Facts</h2></div><div class="card"><dl class="facts">${facts}</dl></div></div>
${a.reasons ? `<div class="block"><div class="head"><h2>The judge's reasons</h2></div><div class="card small">${esc(a.reasons)}</div></div>` : ""}
${opts.withdraw ?? ""}
</div></div>`;
}
