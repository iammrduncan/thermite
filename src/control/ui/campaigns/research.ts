import { questionName, RESEARCH_REVIEW, SATURATION_TASKS } from "../../../core/research-check.ts";
import {
  type HypothesisView,
  type ItemDecisionView,
  type MessageView,
  questionKey,
  questionYield,
  type ReviewItemView,
  type RigView,
  type RunView,
  recentShares,
  type StandingView,
  type TaskYieldView,
} from "../../views/index.ts";
import {
  ago,
  esc,
  icon,
  infoLabel,
  meter,
  moreText,
  num,
  researchCheckWords,
} from "../components/index.ts";
import { paperHref, runHref, runLiveHref } from "../urls.ts";
import { clip, decisionTone, decisionWords, itemName } from "../words/index.ts";
import type { CmdForm } from "./queue/index.ts";

/**
 * A research run on its page (goals 116 and 117): each question with its answer card, the review
 * panel's decision that stands, its gaps, its share of the work and whether it is saturated, and
 * the progress rule, on the Overview; every review with each reviewer's answers and the decision
 * on each item, on the Reviews tab (and its campaign's); and the hypotheses with their status and
 * verdict, with the owner's Promote, Return to pool and Retire, on the Hypotheses tab. Every
 * answer, reason, gap and hypothesis is an agent's words: escaped, and data.
 */

type Review = RunView["reviews"][number];

/** A moment as the dashboard says it: "2h ago (2026-10-24 03:41 UTC)". */
const when = (iso: string | null | undefined, now: number) =>
  iso
    ? `${esc(ago(iso, now))} ago <span class="muted small">(${esc(iso.slice(0, 16).replace("T", " "))} UTC)</span>`
    : "";

/** A length of time in words: "40 s", "12 min", "2 h 5 min". */
export function durationWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The words of each of the run's questions, from its newest digest, by index. */
function questionWords(r: RunView): string[] {
  const d = (r.research ?? {}) as { questions?: unknown };
  return (Array.isArray(d.questions) ? d.questions : []).map((q) =>
    String((q as { question?: unknown } | null)?.question ?? "").trim(),
  );
}

/** A research task's question as a chip, with the question's words on hover (goal 117). */
export function questionChip(r: RunView, q: number | null): string {
  if (q === null) return "";
  const words = questionWords(r)[q] ?? "";
  return `<span class="chip"${words ? ` title="${esc(words)}"` : ""}>${esc(questionName(q))}</span>`;
}

/** How many questions the run has: its digest's, or as many as its cards and decisions name. */
function questionCount(r: RunView): number {
  const keys = [
    ...r.cards.map((c) => c.question),
    ...r.standing.flatMap((s) => (s.kind === "question" ? [questionKey(s.key) ?? -1] : [])),
    ...(r.progress?.open ?? []),
  ];
  return Math.max(questionWords(r).length, ...keys.map((k) => k + 1), 0);
}

/** An item's decision as a chip, with what it means on hover. */
export function decisionChip(
  d: Pick<ItemDecisionView, "kind" | "decision" | "certainty">,
  /** The item it decides, before its words ("Question 1: answered · high"); none: words alone. */
  item = "",
  by = "The review panel",
): string {
  const tone = decisionTone(d.kind, d.decision);
  const words =
    d.kind === "question" && d.decision === "answered" && d.certainty
      ? `answered · ${d.certainty}`
      : d.decision === "insufficient"
        ? "best available, insufficient"
        : d.decision || "no decision";
  const tip =
    d.kind === "question"
      ? d.decision === "answered"
        ? `${by} found it answered, certainty ${d.certainty ?? "not given"}.`
        : d.decision === "insufficient"
          ? `${by} found it at its end: the answer is the best that sources allow, and what is missing only a measurement could settle (a next experiment).`
          : `Not answered yet: ${by.toLowerCase()} named gaps in the evidence.`
      : d.decision === "undecided"
        ? `${by} could not decide it on the evidence.`
        : `${by} found it ${d.decision}.`;
  return `<span class="chip ${tone}" title="${esc(tip)}">${esc(item ? `${item}: ${words}` : words)}</span>`;
}

/** A question's standing decision, or why it has none, as chips. */
function standingChips(s: StandingView | undefined): string {
  if (!s)
    return `<span class="chip" title="The review panel has not decided this question yet.">no decision yet</span>`;
  if (!s.stands)
    return `<span class="chip" title="${esc(`Review ${s.review} decided it ${decisionWords(s.kind, s.decision, s.certainty)} on answer card version ${s.card_version ?? "?"}. The card has a newer version (${s.newer_card}), so the review panel decides it again at its next review.`)}">to review again</span>`;
  const dissent = s.dissent.length
    ? ` <span class="chip" title="${esc(s.dissent.map((d) => `${d.reviewer}: ${decisionWords(s.kind, d.verdict, d.certainty)}`).join("; "))}">${plural(s.dissent.length, "dissent")}</span>`
    : "";
  return `${decisionChip(s)}${dissent}`;
}

/** The gl-mark of a question: answered, at the best available, or still open. */
function questionMark(s: StandingView | undefined): { tone: string; mark: string } {
  if (!s?.stands) return { tone: "off", mark: "·" };
  if (s.decision === "answered") return { tone: "ok", mark: "✓" };
  if (s.decision === "insufficient") return { tone: "warn", mark: "≈" };
  return { tone: "off", mark: "·" };
}

/** A gap list, short: the first five, and how many more. */
function gapList(gaps: { text: string }[]): string {
  const shown = gaps.slice(0, 5);
  return `<ul class="flaws small">${shown.map((g) => `<li>${moreText(g.text, 220)}</li>`).join("")}${gaps.length > shown.length ? `<li class="muted">and ${gaps.length - shown.length} more on the card</li>` : ""}</ul>`;
}

/** What a research task's trial added, in words. */
export function yieldWords(y: TaskYieldView, question: number | null): string {
  const mine = question === null ? undefined : y.by_question.find((q) => q.question === question);
  const verified = mine ? mine.verified_claims : y.verified_claims;
  const parts = [
    verified
      ? `${plural(verified, "verified claim")}${mine ? `, ${mine.new_domain_claims} from sites new to its question` : ""}`
      : "no verified claim",
    y.new_domains ? `${plural(y.new_domains, "site")} new to the run` : "",
    y.findings ? plural(y.findings, "finding") : "",
    y.card_changes ? plural(y.card_changes, "card change") : "",
  ].filter(Boolean);
  return parts.join(", ");
}

// ---------------------------------------------------------------- the Overview's block

/**
 * The research block of a research run's Overview: where the end stands (the answer check, each
 * question's decision, the progress rule), then each question with its answer card, its gaps,
 * its share of the recent tasks, its yield and whether it is saturated; then the paper and the
 * latest report.
 */
export function researchBlock(u: RigView, r: RunView, now: number): string {
  const d = (r.research ?? {}) as Record<string, unknown>;
  const digestQs = Array.isArray(d.questions)
    ? (d.questions as { question?: unknown; verified?: unknown }[])
    : [];
  const words = questionWords(r);
  const n = questionCount(r);
  const most = Math.max(1, ...digestQs.map((q) => num(q.verified)));
  const shares = recentShares(r);
  const progress = r.progress;
  const standing = (q: number) =>
    r.standing.find((s) => s.kind === "question" && questionKey(s.key) === q);
  const closed = r.status === "closed";

  // Each question's state, for the summary line.
  const states = Array.from({ length: n }, (_, q) => {
    const s = standing(q);
    return s?.stands ? s.decision : "none";
  });
  const answered = states.filter((s) => s === "answered").length;
  const insufficient = states.filter((s) => s === "insufficient").length;
  const open = n - answered - insufficient;
  const saturatedOpen = progress
    ? Array.from({ length: n }, (_, q) => q).filter(
        (q) =>
          states[q] !== "answered" &&
          states[q] !== "insufficient" &&
          progress.saturated.includes(q),
      ).length
    : null;
  const counts = n
    ? `<div class="small"><b>Questions:</b> ${answered} answered · ${insufficient} at the best available · ${open} open${saturatedOpen !== null && open ? ` (${saturatedOpen} saturated)` : ""}. <span class="muted">A question ends when the review panel decides it answered, or the best that sources allow.</span></div>`
    : "";

  // The progress rule (goal 117): open questions all saturated, and no improvement for a quarter
  // of the running time.
  const rule =
    progress && !closed
      ? (() => {
          const frac = progress.needed_ms > 0 ? progress.since_ms / progress.needed_ms : 0;
          const openQs = progress.open;
          const unsat = openQs.filter((q) => !progress.saturated.includes(q));
          const state = !openQs.length
            ? "Every question has an end."
            : unsat.length
              ? `It does not apply yet: ${unsat.map(questionName).join(", ")} ${unsat.length === 1 ? "is" : "are"} not saturated, so the plan still gives ${unsat.length === 1 ? "it" : "them"} tasks.`
              : frac >= 1
                ? "Every open question is saturated and nothing improved for the time it needs: the run closes with what stays open."
                : `Every open question is saturated: the run closes if nothing improves for ${durationWords(Math.max(0, progress.needed_ms - progress.since_ms))} more.`;
          return `<div class="rq-rule">${meter("Without an improvement", `${durationWords(progress.since_ms)} of ${durationWords(progress.needed_ms)}`, frac, frac >= 1 ? "warn" : "primary")}<div class="muted xs">${infoLabel("Progress rule", "When every open question is saturated, and no decision or card certainty improved for a quarter of the run's running time (and of its minimum), the run closes with a paper that says what stays open. It applies only when research stopped adding: it is not a time cap.")} Last improvement: ${progress.last_improvement ? when(progress.last_improvement, now) : "none yet"}. ${esc(state)}</div></div>`;
        })()
      : "";

  // The run's hypotheses, in one line: what needs a verdict, and the pool.
  const need = r.hypotheses.filter((h) => h.status === "author" || h.status === "promoted");
  const decidedH = need.filter((h) =>
    r.standing.some((s) => s.kind === "hypothesis" && s.key === h.id),
  ).length;
  const pool = r.hypotheses.filter((h) => h.status === "pool").length;
  const hyp = r.hypotheses.length
    ? `<div class="small"><b>Hypotheses:</b> ${plural(need.length, "needs a verdict", "need a verdict")}, ${decidedH} decided · ${pool} in the pool. <a href="${runHref(r, "hypotheses")}">Hypotheses</a></div>`
    : "";
  const research = r.reviews.filter((x) => x.goal === RESEARCH_REVIEW);
  const newest = research.at(-1);
  const reviews = research.length
    ? `<div class="small"><b>Reviews:</b> ${research.length}${newest ? `, the newest ${newest.posted_at ? `posted ${esc(ago(newest.posted_at, now))} ago` : `asked ${esc(ago(newest.requested_at, now))} ago, not posted yet`}` : ""}. <a href="${runHref(r, "reviews")}">Reviews</a></div>`
    : "";

  const rows = Array.from({ length: n }, (_, q) => {
    const s = standing(q);
    const card = r.cards.find((c) => c.question === q);
    const refused = r.card_refusals.find((x) => x.question === q);
    const verified = num(digestQs[q]?.verified);
    const m = questionMark(s);
    const ended = s?.stands && (s.decision === "answered" || s.decision === "insufficient");
    const saturated = progress?.saturated.includes(q) ?? false;
    const satChip =
      saturated && !ended
        ? ` <span class="chip warn" title="${esc(`Its last ${SATURATION_TASKS} tasks added no verified claim from a new site and did not change its answer card: the plan gives it no more tasks.`)}">saturated</span>`
        : "";
    const evidence = card?.gaps.filter((g) => g.kind !== "measurement") ?? [];
    const measurement = card?.gaps.filter((g) => g.kind === "measurement") ?? [];
    const answer = card
      ? `<div class="small"><b>Answer</b> <span class="muted">· card version ${card.version} · certainty ${esc(card.certainty)} · ${plural(card.claims.length, "claim")} cited${card.by ? ` · by ${esc(card.by)}` : ""}, ${esc(ago(card.at, now))} ago</span></div><div class="rq-ans">${moreText(card.answer, 360)}</div>`
      : `<div class="muted small">No answer card yet${verified ? ` (${plural(verified, "verified claim")})` : ""}. The synthesizer writes one once the question has a verified claim.</div>`;
    const gaps = `${evidence.length ? `<div class="small"><b>Open gaps in the evidence</b> <span class="muted">· the next tasks look for these</span></div>${gapList(evidence)}` : ""}${measurement.length ? `<div class="small"><b>Next experiments</b> <span class="muted">· only a measurement can settle these: for a goal or hill-climb run</span></div>${gapList(measurement)}` : ""}`;
    const refusal = refused
      ? `<div class="xs warn">${icon.warn} The synthesizer's newest card was refused ${esc(ago(refused.at, now))} ago${refused.problems[0] ? `: ${esc(clip(refused.problems[0], 200))}` : ""}. ${card ? "The card above stands." : ""}</div>`
      : "";
    const y = questionYield(r, q);
    const share = shares.by.get(q) ?? 0;
    const figures = [
      plural(verified, "verified claim"),
      shares.window
        ? `${share} of the last ${plural(shares.window, "task")}`
        : "no task given out yet",
      y.tasks
        ? `${plural(y.tasks, "task")} done added ${plural(y.verified, "verified claim")}, ${y.new_sites} from sites new to it`
        : "",
      progress && !ended ? (saturated ? "saturated" : "not saturated") : "",
    ].filter(Boolean);
    const qWords = words[q] ?? "";
    return `<div class="gl rq-q" data-q="${q}"><span class="gl-mark ${m.tone}">${m.mark}</span><span class="gl-main"><span class="rq-head"><span class="rq-text" title="${esc(qWords)}"><b>${esc(questionName(q))}</b> ${esc(qWords || "(no words)")}</span><span class="rq-chips">${standingChips(s)}${satChip}</span></span>${answer}${gaps}${refusal}<div class="gl-why">${esc(figures.join(" · "))}</div><div class="bar ok"><i style="width:${((verified / most) * 100).toFixed(1)}%"></i></div></span></div>`;
  }).join("");

  // The research paper, once code accepted it (goal 112): a link to it as a file, and the
  // paper itself beside the latest report.
  const paper = r.paper?.state === "in" && r.paper.text ? r.paper : undefined;
  const paperLine = paper
    ? `<div class="small"><b>Research paper:</b> by the final writer${paper.writer ? ` ${esc(paper.writer)}` : ""}, ${paper.ste_checked ? "checked against the rig's STE checker" : "not checked for STE"}; ${paper.experiments} next ${paper.experiments === 1 ? "experiment" : "experiments"} kept in the knowledge base. <a href="${esc(paperHref(r))}">paper.md</a></div>`
    : "";
  const paperText = paper
    ? `<details data-k="paper-${esc(r.id)}"><summary class="small muted" style="cursor:pointer">Research paper</summary><pre class="report" style="margin-top:8px">${esc(String(paper.text))}</pre></details>`
    : "";
  const unsupported = num(d.unsupported_numbers);
  const foot = [
    paperLine,
    unsupported
      ? `<div class="note warn" style="margin-top:0">${unsupported} ${unsupported === 1 ? "number" : "numbers"} in the latest report ${unsupported === 1 ? "appears" : "appear"} in no archived source and no verified claim. The report flags each one.</div>`
      : "",
    paperText,
    r.research
      ? `<details data-k="report-${esc(r.id)}"><summary class="small muted" style="cursor:pointer">Latest report</summary><pre class="report" style="margin-top:8px">${esc(String(d.report ?? ""))}</pre></details>`
      : "",
  ]
    .filter(Boolean)
    .join("");
  return `<div class="block" data-part="research"><div class="head"><h2>Research questions</h2><span class="n">${n}</span>${r.research ? `<span class="right">${esc(String(d.kind ?? ""))} · ${esc(ago(String(d.at ?? ""), now))} ago</span>` : ""}</div><div class="card flat"><div class="rq-sum">${counts}<div class="small rcheck"><b>Answer check:</b> ${esc(researchCheckWords(r, u))}</div>${rule}${hyp}${reviews}</div>${
    rows || `<div class="rq-sum"><div class="muted small">No question coverage yet.</div></div>`
  }${
    digestQs.length
      ? `<div class="rq-sum muted xs">A bar counts the question's verified claims, measured against the question with the most. Its share counts the last ${shares.window || "few"} research tasks given out.</div>`
      : ""
  }${foot ? `<div class="rq-sum">${foot}</div>` : ""}</div></div>`;
}

// ---------------------------------------------------------------- the Reviews tab

/** A review's outcome: its label's tone and words, and what the side of its row says. */
function outcomeOf(rv: Review): { tone: string; word: string; pill: string; icon: string } {
  if (rv.owner === "accepted")
    return { tone: "ok", word: "Accepted", pill: "accepted by you", icon: icon.check };
  if (rv.owner === "rejected")
    return { tone: "bad", word: "Rejected", pill: "rejected by you", icon: icon.x };
  if (rv.panel === "review_passed")
    return { tone: "ok", word: "Passed", pill: "passed by the review panel", icon: icon.check };
  if (rv.panel === "review_failed")
    return { tone: "warn", word: "Not passed", pill: "not passed", icon: icon.warn };
  if (rv.panel)
    return { tone: "warn", word: rv.panel.replace(/_/g, " "), pill: rv.panel, icon: icon.warn };
  return { tone: "info", word: "Waiting", pill: "waiting for the review panel", icon: icon.clock };
}

/** One review's model use (goal 116), from the run's records of the review panel's calls. */
export interface ReviewUsage {
  calls: number;
  tokens_in: number;
  tokens_out: number;
  call_ms: number | null;
  usd: number | null;
}

/** A line of the run's Live view about a review: the supervisor's words, unsigned. */
export interface ReviewLine {
  at: string;
  text: string;
}

/** What a review row reads beyond the run: its model use and its lines in Live. */
export interface ReviewSources {
  usage?: ((review: number) => ReviewUsage | undefined) | undefined;
  lines?: ((review: number) => ReviewLine[]) | undefined;
}

const short = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : String(n);

/** An item of a review for people, with its words on hover: "Question 2", "hypothesis h-1". */
function itemCell(r: RunView, kind: string, key: string, said = true): string {
  const q = kind === "question" ? questionKey(key) : null;
  const words =
    q !== null ? (questionWords(r)[q] ?? "") : (r.hypotheses.find((h) => h.id === key)?.text ?? "");
  return `<b class="nowrap"${words ? ` title="${esc(words)}"` : ""}>${esc(itemName(kind, key))}</b>${words && said ? `<div class="muted xs">${esc(clip(words, 120))}</div>` : ""}`;
}

/** The owner's messages to the review panel that a review was given, or waits to give. */
function messagesFor(r: RunView, rv: Review, research: Review[]): MessageView[] {
  const toPanel = (m: MessageView) => m.to === "review_panel" || m.to === "advisors";
  const read = (m: MessageView) => m.reads.find((x) => x.by === "review_panel")?.at;
  const posted = research.filter((x) => x.posted_at).map((x) => x.posted_at as string);
  return r.messages.filter((m) => {
    if (!toPanel(m)) return false;
    const at = read(m);
    // Not read yet: the review that waits now is given it at its next try.
    if (!at) return rv.posted_at === null && rv === research.at(-1);
    // Read when a review was posted: the newest review posted at or before the read.
    const mine = posted.filter((p) => p <= at).at(-1);
    return mine !== undefined && mine === rv.posted_at;
  });
}

/** The decision on the same item in the review that decided it before this one. */
function before(r: RunView, d: ItemDecisionView): ItemDecisionView | undefined {
  return r.decisions
    .filter((x) => x.kind === d.kind && x.key === d.key && x.review < d.review)
    .at(-1);
}

/** One reviewer's answers, as a table: each item, the verdict, why, the claims and the problems. */
function reviewerTable(r: RunView, items: ReviewItemView[]): string {
  return `<table class="ktable rv-items"><thead><tr><th>Item</th><th>Verdict</th><th>Why</th><th>Claims cited</th><th>What code found</th></tr></thead><tbody>${items
    .map(
      (x) =>
        `<tr><td>${itemCell(r, x.kind, x.key, false)}${x.card_version !== null ? `<div class="muted xs">card version ${x.card_version}</div>` : ""}</td><td>${decisionChip({ kind: x.kind, decision: x.verdict, certainty: x.certainty }, "", "This reviewer")}</td><td class="small">${x.reasons ? moreText(x.reasons, 220) : `<span class="muted">none given</span>`}</td><td class="small">${
          x.claims.length
            ? `${x.claims
                .slice(0, 6)
                .map((c) => `<code>${esc(c)}</code>`)
                .join(
                  " ",
                )}${x.claims.length > 6 ? ` <span class="muted">and ${x.claims.length - 6} more</span>` : ""}`
            : `<span class="muted">none</span>`
        }</td><td class="small">${x.problems.length ? `<ul class="flaws bad">${x.problems.map((p) => `<li>${esc(clip(p, 300))}</li>`).join("")}</ul>` : `<span class="ok">no problem</span>`}</td></tr>`,
    )
    .join("")}</tbody></table>`;
}

/** One review, as a row that opens: when, what it saw, each reviewer, each decision, its cost. */
function reviewRow(
  u: RigView,
  r: RunView,
  rv: Review,
  research: Review[],
  now: number,
  src: ReviewSources,
  where = false,
): string {
  const o = outcomeOf(rv);
  const decided = [...rv.decided].sort(
    (a, b) =>
      Number(a.kind === "hypothesis") - Number(b.kind === "hypothesis") ||
      (questionKey(a.key) ?? 0) - (questionKey(b.key) ?? 0),
  );
  const qs = decided.filter((d) => d.kind === "question");
  const hs = decided.filter((d) => d.kind === "hypothesis");
  const headline = decided.length
    ? [
        qs.length
          ? `${qs.filter((d) => d.decision === "answered").length} of ${plural(qs.length, "question")} answered${qs.some((d) => d.decision === "insufficient") ? `, ${qs.filter((d) => d.decision === "insufficient").length} at the best available` : ""}`
          : "",
        hs.length
          ? `${hs.filter((d) => d.decision === "supported" || d.decision === "refuted").length} of ${plural(hs.length, "hypothesis", "hypotheses")} given a verdict`
          : "",
      ]
        .filter(Boolean)
        .join("; ")
    : rv.panel === null
      ? "Waiting for the review panel's answers"
      : rv.answered_by?.length
        ? `${rv.answered_by.filter((q) => q.reviewers > 0 && q.reviewers === rv.counts.reviewers).length} of ${plural(rv.answered_by.length, "question")} found answered by every reviewer`
        : rv.panel === "review_passed"
          ? "Every reviewer found every question answered"
          : "The review panel found gaps";
  const saw = [
    rv.saw.verified_claims !== null ? plural(rv.saw.verified_claims, "verified claim") : "",
    rv.saw.questions !== null ? plural(rv.saw.questions, "question") : "",
    rv.saw.hypotheses !== null ? plural(rv.saw.hypotheses, "hypothesis", "hypotheses") : "",
  ].filter(Boolean);
  const why = `Asked ${esc(ago(rv.requested_at, now))} ago${saw.length ? ` on ${esc(saw.join(", "))}` : ""}; ${rv.posted_at ? `posted ${esc(ago(rv.posted_at, now))} ago${rv.counts.reviewers !== null ? ` by ${plural(rv.counts.reviewers, "reviewer")}` : ""}` : "not posted yet"}.`;
  const lines = src.lines?.(rv.review) ?? [];
  // A failed try: kept with the review when the rig reports it (review_try_failed); from an older
  // rig, the supervisor's error line for the review in Live (it posts nothing then).
  const reported = rv.failed_tries ?? [];
  const failed = reported.length
    ? reported.map((f) => ({ text: f.error }))
    : lines.filter((l) => new RegExp(`^review ${rv.review}: (?!the review panel )`).test(l.text));
  const chips = [
    ...decided.slice(0, 10).map((d) => decisionChip(d, itemName(d.kind, d.key))),
    decided.length > 10 ? `<span class="chip">and ${decided.length - 10} more</span>` : "",
    rv.tries !== null && rv.tries > 1 ? `<span class="chip warn">${rv.tries} tries</span>` : "",
    failed.length && rv.tries === null
      ? `<span class="chip warn" title="From the run's Live view: the supervisor's lines for this review.">${plural(failed.length, "failed try", "failed tries")}</span>`
      : "",
  ].join("");
  const usage = src.usage?.(rv.review);
  const failedList = reported.length
    ? `<ul class="small">${reported
        .map((f) => `<li>Try ${f.try}, ${when(f.at, now)}: ${esc(clip(f.error, 400))}</li>`)
        .join("")}</ul>`
    : "";
  const triesHtml = reported.length
    ? `${esc(rv.posted_at ? `${rv.tries ?? reported.length + 1}, as the rig reported it. The tries that failed:` : `${reported.length} failed so far; it is tried again at the review panel's next round. The tries that failed:`)}${failedList}`
    : null;
  const tries =
    rv.tries !== null
      ? `${rv.tries}, as the rig reported it.`
      : failed.length
        ? `${rv.posted_at ? `${failed.length + 1}, as far as the run's Live view shows` : `${failed.length} failed so far, as far as the run's Live view shows; it is tried again at the review panel's next round`}: ${plural(failed.length, "failed try", "failed tries")} in its lines below. The rig does not report its tries yet.`
        : lines.length
          ? `${rv.posted_at ? "1" : "None failed yet"}, as far as the run's Live view shows: its lines below have no failed try. The rig does not report its tries yet.`
          : "Not reported by the rig, and the run's Live view has no line for this review now (it keeps the rig's newest lines only).";
  const msgs = messagesFor(r, rv, research);
  const facts = [
    ["Asked", `${when(rv.requested_at, now)}${saw.length ? `, on ${esc(saw.join(", "))}` : ""}`],
    [
      "Posted",
      rv.posted_at
        ? `${when(rv.posted_at, now)}${rv.counts.reviewers !== null ? `, by ${plural(rv.counts.reviewers, "reviewer")}` : ""}`
        : "Not yet. The review panel reviews at its next round; a review whose reviewers fail to answer is tried again.",
    ],
    ["Tries", triesHtml ?? esc(tries)],
    [
      "Outcome",
      `${esc(o.pill.replace(/^./, (c) => c.toUpperCase()))}${rv.counts.decided !== null ? `: ${plural(rv.counts.decided, "item")} decided` : ""}${rv.counts.open !== null ? `, ${rv.counts.open} still open` : ""}.${rv.owner_at ? ` You ${esc(rv.owner ?? "")} it ${esc(ago(rv.owner_at, now))} ago${rv.owner_note ? `: “${esc(rv.owner_note)}”` : ""}.` : rv.panel === "review_passed" && !rv.owner && r.ask_owner.reviews ? ` It waits for your acceptance in <a href="${runHref(r)}#needs">Needs you</a>.` : ""}`,
    ],
    [
      "Cost",
      usage
        ? `${usage.usd !== null ? `<b>$${usage.usd.toFixed(2)}</b> · ` : ""}${plural(usage.calls, "call")} · ${esc(short(usage.tokens_in))} tokens in · ${esc(short(usage.tokens_out))} out${usage.call_ms !== null ? ` · ${esc(durationWords(usage.call_ms))} in calls` : ""}`
        : `<span class="muted">No model use recorded for it.</span>`,
    ],
  ]
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`)
    .join("");
  const decisions = decided.length
    ? `<div class="small"><b>What it decided</b> <span class="muted">· each item by more than half of the reviewers whose answer passed code's check; without such a majority it stays open</span></div><table class="ktable rv-items"><thead><tr><th>Item</th><th>Decision</th><th>Dissent</th><th>Before</th></tr></thead><tbody>${decided
        .map((d) => {
          const b = before(r, d);
          return `<tr><td>${itemCell(r, d.kind, d.key)}${d.card_version !== null ? `<div class="muted xs">card version ${d.card_version}</div>` : ""}</td><td>${decisionChip(d)}</td><td class="small">${d.dissent.length ? d.dissent.map((x) => `<div><b>${esc(x.reviewer)}</b>: ${esc(decisionWords(d.kind, x.verdict, x.certainty))}${x.reasons ? ` <span class="muted">· ${moreText(x.reasons, 160)}</span>` : ""}</div>`).join("") : `<span class="muted">none</span>`}</td><td class="small">${b ? `${esc(decisionWords(b.kind, b.decision, b.certainty))} <span class="muted">(review ${b.review})</span>` : `<span class="muted">first decision</span>`}</td></tr>`;
        })
        .join("")}</tbody></table>`
    : "";
  const reviewers = rv.reviewers.length
    ? rv.reviewers
        .map((x) => {
          const qs = x.items.filter((i) => i.kind === "question");
          const hs = x.items.filter((i) => i.kind === "hypothesis");
          const bad = x.items.filter((i) => i.problems.length).length;
          return `<details class="rv-who" data-k="rv-${esc(r.id)}-${rv.review}-${esc(x.reviewer)}"><summary class="small"><b>${esc(x.reviewer)}</b> <span class="muted">· ${qs.filter((i) => i.verdict === "answered").length} of ${plural(qs.length, "question")} answered${hs.length ? ` · ${hs.filter((i) => i.verdict === "supported" || i.verdict === "refuted").length} of ${plural(hs.length, "hypothesis", "hypotheses")} decided` : ""} · ${esc(ago(x.at, now))} ago</span>${bad ? ` <span class="chip bad">code found problems in ${plural(bad, "answer")}</span>` : ""}</summary>${reviewerTable(r, x.items)}</details>`;
        })
        .join("")
    : rv.answered_by?.length
      ? `<div class="small"><b>Each question</b> <span class="muted">· how many of the ${rv.counts.reviewers ?? "?"} reviewers found it answered (each reviewer's answers are in the run's Journal, under Review panel)</span></div><ul class="flaws small">${rv.answered_by
          .map(
            (q) =>
              `<li>${esc(questionName(q.question))}: ${q.reviewers} of ${rv.counts.reviewers ?? "?"}${rv.answers?.find((a) => a.question === q.question) ? ` <span class="muted">· ${moreText(rv.answers.find((a) => a.question === q.question)?.answer ?? "", 200)}</span>` : ""}</li>`,
          )
          .join("")}</ul>`
      : "";
  const gaps = rv.gaps?.length
    ? `<div class="small"><b>What the reviewers found missing</b> <span class="muted">· the next workers' briefs got the gaps in the evidence</span></div><ul class="flaws small">${rv.gaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>`
    : "";
  // The reviewers' field notes are the run's Journal's, under Review panel (goal 116): the
  // supervisor writes them once the review is posted, before the next review is.
  const posted = rv.posted_at;
  const nextPosted = research.find((x) => x.posted_at && posted && x.posted_at > posted)?.posted_at;
  const panelNotes = posted
    ? r.journal.filter(
        (n) =>
          n.by.startsWith("review_panel") && n.at >= posted && (!nextPosted || n.at < nextPosted),
      ).length
    : 0;
  const notes = panelNotes
    ? `<div class="small">${panelNotes === 1 ? "A field note" : `${panelNotes} field notes`} of the reviewers came with it: on the run's <a href="${runHref(r, "journal")}">Journal</a>, under <b>Review panel</b>.</div>`
    : "";
  const messages = msgs.length
    ? `<div class="small"><b>Your messages to the review panel</b></div>${msgs
        .map(
          (m) =>
            `<div class="qturn"><div class="qmsg you"><div class="qmh"><span class="qsrc you">you</span> <span class="muted xs">${esc(m.at.slice(0, 16).replace("T", " "))} UTC${m.to === "advisors" ? " · to all advisors" : ""}</span></div>${esc(m.text)}</div>${
              m.answers
                .filter((a) => a.role === "review_panel")
                .map(
                  (a) =>
                    `<div class="qmsg planner"><div class="qmh"><span class="qsrc auditor">${esc(a.advisor ?? "review panel")}</span> <span class="muted xs">${esc(a.at.slice(11, 16))} UTC</span></div>${esc(a.text)}</div>`,
                )
                .join("") ||
              `<div class="muted xs">${m.reads.some((x) => x.by === "review_panel") ? "Read with this review; no reviewer answered it." : "The review panel reads it at its next try."}</div>`
            }</div>`,
        )
        .join("")}`
    : "";
  const live = lines.length
    ? `<div class="small"><b>In the run's Live view</b> <span class="muted">· the supervisor's lines for this review, unsigned, while Live keeps them</span></div><div class="qhands rv-lines">${lines
        .map(
          (l) =>
            `<div class="qhand"><span class="tm">${esc(l.at.slice(11, 16))}</span><div class="small${failed.includes(l) ? " warn" : ""}">${esc(clip(l.text, 600))}</div></div>`,
        )
        .join("")}</div>`
    : "";
  return `<details class="dq dq-${o.tone}" data-k="review-${esc(u.id)}-${esc(r.id)}-${rv.review}"><summary>
<span class="dq-kind">${o.icon}Review ${rv.review}</span>
<span class="dq-main"><span class="dq-head">${esc(headline)}</span><span class="dq-why">${why}</span><span class="dq-sub">${where ? `<span class="dq-where"><a href="${runHref(r, "reviews")}">${esc(r.id)}</a> · ${esc(u.id)}</span>` : ""}${chips}</span></span>
<span class="dq-side"><span class="dq-age">${rv.posted_at ? `posted ${esc(ago(rv.posted_at, now))} ago` : `waiting ${esc(ago(rv.requested_at, now))}`}</span><span class="label ${o.tone}">${esc(o.word)}</span></span>
</summary><div class="dq-body"><dl class="dc-facts">${facts}</dl>${decisions}${reviewers}${gaps}${notes}${messages}${live}</div></details>`;
}

/** Each item's decisions across the reviews, oldest first: how each changed. */
function trailCard(r: RunView): string {
  const items = new Map<string, ItemDecisionView[]>();
  for (const d of r.decisions) {
    const k = `${d.kind}:${d.key}`;
    items.set(k, [...(items.get(k) ?? []), d]);
  }
  if (!items.size) return "";
  const rows = [...items.entries()]
    .sort(([a], [b]) => {
      const qa = a.startsWith("question:") ? Number(a.slice(9)) : 1e9;
      const qb = b.startsWith("question:") ? Number(b.slice(9)) : 1e9;
      return qa - qb || a.localeCompare(b);
    })
    .map(([k, ds]) => {
      const s = r.standing.find((x) => `${x.kind}:${x.key}` === k);
      const first = ds[0] as ItemDecisionView;
      return `<div class="dlrow"><span>${esc(itemName(first.kind, first.key))}</span><span class="muted xs">${ds.map((d) => `${esc(decisionWords(d.kind, d.decision, d.certainty))} (${d.review})`).join(" → ")}${s && !s.stands ? " → to review again" : ""}</span></div>`;
    })
    .join("");
  return `<div class="card qcard"><h3>Each item across reviews</h3><div class="small muted">Each decision with its review's number, oldest first. A question's decision stands until its answer card changes; then the review panel decides it again.</div><div class="dlist">${rows}</div></div>`;
}

/** The side of a Reviews tab: how reviews work, and where to write to the review panel. */
function howCard(r: RunView): string {
  return `<div class="card qcard"><h3>How the review panel decides</h3><div class="small">The review panel reviews each question's answer card and each hypothesis that needs a verdict, as items. Each reviewer answers each item; code checks each answer (every claim it cites is a verified claim of the run, every number is in them). An item's decision is the verdict of more than half of the reviewers whose answer passed; without such a majority it stays open, and dissent is kept. A question ends when it is decided answered, or the best that sources allow.</div><div class="small">To tell the review panel something, write to it from <a href="${runLiveHref(r, { compose: true })}">Live</a> (To: the review panel). It reads your message with its next review, and its answer shows here.</div></div>`;
}

/** A research run's Reviews tab (goal 116): every review, newest first, each opening to its detail. */
export function reviewsTab(o: { u: RigView; r: RunView; now: number } & ReviewSources): string {
  const { u, r } = o;
  const research = r.reviews.filter((x) => x.goal === RESEARCH_REVIEW);
  const list = [...research]
    .reverse()
    .map((rv) => reviewRow(u, r, rv, research, o.now, o))
    .join("");
  return `<div class="qcols"><div>
<div class="head"><h2>Reviews</h2><span class="n">${research.length}</span><span class="right">newest first; open one for what it saw, each reviewer's answers and what it decided</span></div>
${list ? `<div class="dqs" data-part="reviews">${list}</div>` : `<div class="card"><div class="empty">No review yet. After the run's minimum running time, the harness asks the review panel at a digest when the evidence changed.</div></div>`}
</div><div class="qside">${trailCard(r)}${howCard(r)}</div></div>`;
}

/** A research campaign's Reviews tab (goal 116): every review of each of its runs, by run. */
export function campaignReviewsTab(o: {
  runs: { u: RigView; r: RunView; state: string }[];
  now: number;
  sources: (u: RigView, r: RunView) => ReviewSources;
}): string {
  const runs = o.runs.filter((x) => x.r.reviews.some((rv) => rv.goal === RESEARCH_REVIEW));
  if (!runs.length)
    return `<div class="card"><div class="empty">No review yet in any run of this campaign.</div></div>`;
  return runs
    .map(({ u, r, state }) => {
      const research = r.reviews.filter((x) => x.goal === RESEARCH_REVIEW);
      const src = o.sources(u, r);
      return `<div class="block"><div class="head"><h2><a href="${runHref(r, "reviews")}">${esc(r.id)}</a></h2><span class="n">${plural(research.length, "review")}</span><span class="right">on ${esc(u.id)} · ${state}</span></div><div class="dqs">${[
        ...research,
      ]
        .reverse()
        .map((rv) => reviewRow(u, r, rv, research, o.now, src))
        .join("")}</div></div>`;
    })
    .join("");
}

// ---------------------------------------------------------------- the Hypotheses tab

/** What a status means, for its chip's hover. */
const STATUS_TIP: Record<string, string> = {
  author:
    "The author's, from the campaign's brief: the review panel must give it a verdict. It changes only with the brief.",
  promoted: "Promoted from the pool by you or the plan: the review panel must give it a verdict.",
  pool: "Proposed by a worker. No review waits on it; the paper lists it as proposed by the run.",
  merged: "Its words repeated another hypothesis, so it was merged into that one.",
  retired: "Retired: no review waits on it, and workers no longer work on it.",
};

/** The owner's three moves for a hypothesis (goal 117): what each does, in words. */
const MOVES = {
  promoted: {
    label: "Promote",
    send: "Promote it",
    does: "The review panel must give it a verdict, like the author's hypotheses. The run does not end until it has one.",
  },
  pool: {
    label: "Return to pool",
    send: "Return it to the pool",
    does: "No review waits on it. The paper lists it as proposed by the run, and workers may still revise it.",
  },
  retired: {
    label: "Retire",
    send: "Retire it",
    does: "No review waits on it, and workers no longer work on it. It stays in the record as retired.",
  },
} as const;

const WHY_TIP =
  "Why you change it, up to 2,000 characters. The run keeps it with the change: it shows here and in the run's History.";

/** One of the owner's moves for a hypothesis: a menu with why, what it does and the button. */
function move(
  u: RigView,
  r: RunView,
  h: HypothesisView,
  to: keyof typeof MOVES,
  cmd: CmdForm,
  back: string,
): string {
  const m = MOVES[to];
  return `<span class="hy-move"><details class="menu"><summary class="btn sm ghost">${esc(m.label)}</summary><div class="menu-pop qedit">${cmd(
    {
      rig: u.id,
      kind: "hypothesis_status",
      fields: { run: r.id, id: h.id, status: to },
      label: m.send,
      cls: `sm${to === "retired" ? " danger" : to === "promoted" ? " primary" : ""}`,
      back,
      extra: `<label class="sfd">${infoLabel("Why", WHY_TIP)}<input name="reason" required maxlength="2000" placeholder="such as: the questions turn on it"></label><div class="muted small">${esc(m.does)}</div>`,
    },
  )}</div></details><i class="ii" tabindex="0" data-tip="${esc(`${m.label}: ${m.does}`)}">i</i></span>`;
}

/** One hypothesis: its words, its question, its status and verdict, and the owner's moves. */
function hypothesisRow(
  u: RigView,
  r: RunView,
  h: HypothesisView,
  now: number,
  cmd: CmdForm,
  back: string,
): string {
  const s = r.standing.find((x) => x.kind === "hypothesis" && x.key === h.id);
  const required = h.status === "author" || h.status === "promoted";
  const verdict = s
    ? `${decisionChip(s)} <span class="muted xs">review ${s.review}${s.dissent.length ? ` · ${plural(s.dissent.length, "dissent")}` : ""}</span>`
    : required
      ? `<span class="chip" title="The review panel gives it a verdict at its next review.">no verdict yet</span>`
      : "";
  const by =
    h.by === "brief"
      ? `<span class="qsrc you" title="From the campaign's brief">the brief</span>`
      : `<span class="qsrc lane">${esc(h.by)}</span>`;
  const change = h.status_change
    ? `<div class="muted xs">${esc(h.status_change.by.startsWith("planner") ? "The planner" : /owner/.test(h.status_change.by) ? "You" : h.status_change.by)} set it to ${esc(h.status_change.status)} ${esc(ago(h.status_change.at, now))} ago${h.status_change.reason ? `: “${esc(clip(h.status_change.reason, 300))}”` : ""}</div>`
    : "";
  const moves =
    r.status === "closed"
      ? []
      : h.status === "pool"
        ? (["promoted", "retired"] as const)
        : h.status === "promoted"
          ? (["pool", "retired"] as const)
          : h.status === "retired"
            ? (["pool"] as const)
            : [];
  const acts = moves.map((to) => move(u, r, h, to, cmd, back)).join("");
  return `<div class="qrule hy" data-h="${esc(h.id)}"><span class="qkind ${esc(h.status)}" title="${esc(STATUS_TIP[h.status] ?? h.status)}">${esc(h.status)}</span><div><div>${moreText(h.text, 320)}</div><div class="qmeta"><span class="chip">${h.question === null ? "the whole run" : esc(questionName(h.question))}</span>${verdict}${by}<span class="muted xs">${plural(h.supporting.length, "verified claim")} support it · <code>${esc(h.id)}</code> · ${esc(ago(h.at, now))} ago${h.status === "merged" && h.merged_into ? ` · merged into <code>${esc(h.merged_into)}</code>` : ""}</span></div>${change}${h.status === "author" ? `<div class="muted xs">The author's: it changes only with the campaign's brief.</div>` : ""}</div><div class="qb">${acts}</div></div>`;
}

/** The pool, in order: by question, then by how many verified claims support each, newest first. */
const poolOrder = (a: HypothesisView, b: HypothesisView) =>
  (a.question ?? 1e9) - (b.question ?? 1e9) ||
  b.supporting.length - a.supporting.length ||
  b.at.localeCompare(a.at);

/** How many of the pool the tab draws; get_run has them all. */
export const POOL_SHOWN = 150;

/** A research run's Hypotheses tab (goal 117). */
export function hypothesesTab(o: {
  u: RigView;
  r: RunView;
  now: number;
  cmd: CmdForm;
  back: string;
}): string {
  const { u, r } = o;
  const by = (st: string) => r.hypotheses.filter((h) => h.status === st);
  const need = r.hypotheses
    .filter((h) => h.status === "author" || h.status === "promoted")
    .sort(
      (a, b) =>
        Number(a.status === "promoted") - Number(b.status === "promoted") || poolOrder(a, b),
    );
  const pool = by("pool").sort(poolOrder);
  const rest = r.hypotheses.filter((h) => h.status === "merged" || h.status === "retired");
  const row = (h: HypothesisView) => hypothesisRow(u, r, h, o.now, o.cmd, o.back);
  const decided = need.filter((h) =>
    r.standing.some((s) => s.kind === "hypothesis" && s.key === h.id),
  ).length;
  const n = Math.max(0, ...r.hypotheses.map((h) => (h.question ?? -1) + 1));
  const perQ = Array.from({ length: n }, (_, q) => {
    const hs = r.hypotheses.filter((h) => h.question === q);
    const req = hs.filter((h) => h.status === "author" || h.status === "promoted").length;
    const inPool = hs.filter((h) => h.status === "pool").length;
    return `<div class="dlrow"><span>${esc(questionName(q))}</span><span class="muted xs">${req} need a verdict · ${inPool} in the pool</span></div>`;
  }).join("");
  const stat = (k: string, v: number) => `<span>${esc(k)}</span><b>${v}</b>`;
  return `<div class="qcols"><div data-part="hypotheses">
<div class="head"><h2>Need a verdict</h2><span class="n">${need.length}</span><span class="right">the author's and promoted ones: the run does not end until the review panel gives each a verdict</span></div>
<div class="qrules">${need.map(row).join("") || `<div class="card"><div class="empty">None. The campaign's brief has no hypothesis, and none was promoted.</div></div>`}</div>
<div class="head" style="margin-top:26px"><h2>The pool</h2><span class="n">${pool.length}</span><span class="right">proposed by the workers, by question, the best supported first; no review waits on them</span></div>
<div class="qrules">${pool.slice(0, POOL_SHOWN).map(row).join("") || `<div class="card"><div class="empty">None yet. Workers propose hypotheses as they research.</div></div>`}${pool.length > POOL_SHOWN ? `<div class="muted small">The first ${POOL_SHOWN} of ${pool.length}. MCP's get_run lists them all.</div>` : ""}</div>
${rest.length ? `<details class="howcheck" data-k="hy-rest-${esc(r.id)}" style="margin-top:22px"><summary>Merged and retired: ${rest.length}</summary><div class="qrules" style="margin-top:10px">${rest.map(row).join("")}</div></details>` : ""}
</div><div class="qside">
<div class="card qcard"><h3>Hypotheses</h3><div class="jstat">${stat("Need a verdict", need.length)}${stat("Decided", decided)}${stat("In the pool", pool.length)}${stat("Merged", by("merged").length)}${stat("Retired", by("retired").length)}</div></div>
<div class="card qcard"><h3>How they work</h3><div class="small">The author's hypotheses, from the campaign's brief, are the run's obligations: the review panel gives each a verdict, and the run does not end without one. Workers propose more to the pool, each tied to a question and kept once. Only promoted ones need a verdict; the paper lists the rest as proposed by the run.</div><div class="small"><b>Promote</b> one when the questions turn on it; <b>Return to pool</b> or <b>Retire</b> one that no longer needs a verdict. Each goes to the rig as a signed command, with your reason.</div></div>
${perQ ? `<div class="card qcard"><h3>By question</h3><div class="dlist">${perQ}</div></div>` : ""}
</div></div>`;
}
