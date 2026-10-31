import { clockUtc, commandFollowUrl, commandProgress, refusalOf } from "../../command-progress.ts";
import { harnessConfirmed } from "../../issue/index.ts";
import type { CommandRow } from "../../store/index.ts";
import type { AttemptView, JudgeJob, RunView } from "../../views/index.ts";
import { ago, esc, infoLabel } from "../components/index.ts";
import { attemptHref } from "../urls.ts";
import { jobText } from "../words/index.ts";

/**
 * Withdrawing an attempt's evidence on its page (goal 174), the owner's alone: what a withdrawal
 * reached, and when, by whom and why; the form, for the attempt itself (for good) or one of its
 * judge jobs' measurements, with why; what the rig's preview says it would reach; and the
 * confirmation, which says what it decides and names the preview's sha, so the rig does what the
 * owner saw or refuses.
 */

/** Who withdrew it, in words: the owner's channels are "you". */
const whoWords = (by: string) =>
  by === "owner" || by.startsWith("control:owner") ? "you" : by.replace(/^control:/, "");

/** What each withdrawal that reached this attempt did, newest first; "" when none did. */
export function withdrawnBlock(r: RunView, a: AttemptView, now: number): string {
  const reached = r.invalidations.filter((i) => i.attempts.includes(a.id)).reverse();
  if (!reached.length) return "";
  const rows = reached.map((i) => {
    const what =
      i.kind === "attempt"
        ? i.subject === a.id
          ? `This attempt, for good${i.attempts.length > 1 ? `, with the ${i.attempts.length - 1} attempt${i.attempts.length === 2 ? "" : "s"} built on it` : ""}.`
          : `Attempt <a href="${attemptHref(r, i.subject)}">${esc(i.subject)}</a>, for good, with every attempt built on it: this one was built on it.`
        : `The measurements of judge job ${esc(i.subject)}: what rested on them is judged again.`;
    const others = i.attempts.filter((x) => x !== a.id);
    const links = others
      .slice(0, 20)
      .map((x) => `<a href="${attemptHref(r, x)}">${esc(x)}</a>`)
      .join(", ");
    const champion = i.champion
      ? ` The run's champion moved back from #${i.champion.from} to #${i.champion.to}${i.champion.attempt ? ` (${esc(i.champion.attempt)})` : ", the starting point"}.`
      : "";
    return `<div class="fw"><b>${esc(ago(i.at, now))} ago</b> <span class="muted small">(${esc(i.at.slice(0, 16).replace("T", " "))} UTC)</span>, by ${esc(whoWords(i.by))}. Why: ${esc(i.reason)}</div>
<div class="fw">What: ${what}</div>
<div class="fw muted small">It reached ${i.attempts.length} attempt${i.attempts.length === 1 ? "" : "s"}${others.length ? ` (${links}${others.length > 20 ? ` and ${others.length - 20} more` : ""})` : ""}, recorded ${i.verdicts} invalidated verdict${i.verdicts === 1 ? "" : "s"}${i.champions.length ? ` and reopened champion${i.champions.length === 1 ? "" : "s"} ${i.champions.map((s) => `#${s}`).join(", ")}` : ""}.${champion} Nothing was deleted.</div>`;
  });
  return `<div class="block"><div class="head"><h2>Its evidence was withdrawn</h2></div><div class="card flat">${rows.join(`<div class="divider"></div>`)}</div></div>`;
}

/** What the owner's form posts with, besides its own fields. */
interface FormBase {
  csrf: string;
  rig: string;
  back: string;
}

const hidden = (fields: Record<string, string>) =>
  Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");

/** The owner's form: the subject, why, and a preview of what it reaches. */
function askForm(f: FormBase, r: RunView, a: AttemptView, jobs: JudgeJob[], open: boolean) {
  const finished = jobs.filter((j) => j.state === "done" || j.state === "failed");
  const choice = (value: string, label: string, checked = false) =>
    `<label class="row small"><input type="radio" name="subject" value="${esc(value)}"${checked ? " checked" : ""}> ${label}</label>`;
  return `<details class="card flat"${open ? " open" : ""}><summary>Withdraw its evidence…</summary><form method="post" action="/ui/commands" class="stack">${hidden(
    {
      csrf: f.csrf,
      rig: f.rig,
      kind: "invalidate_evidence",
      run: r.id,
      attempt: a.id,
      back: f.back,
    },
  )}<div class="small muted">Withdraw evidence you found bad, such as measurements taken on a card that ran slow. Nothing is deleted: the old verdicts stay in the record, marked.</div>${choice(
    "attempt",
    "<b>This attempt, for good</b>, with every attempt built on it: none is judged again, and none can become the champion",
    true,
  )}${finished
    .map((j) =>
      choice(
        `job:${j.id}`,
        `<b>The measurements of judge job ${esc(j.id)}</b> (${esc(jobText(j))}): what rests on them is measured again`,
      ),
    )
    .join(
      "",
    )}<label>${infoLabel("Why", "Why this evidence is bad. The rig's record keeps it, and every page that shows the withdrawal says it.")}<textarea name="reason" required maxlength="2000" rows="2" placeholder="such as: the device throttled during these runs"></textarea></label><button>See what it reaches</button><div class="muted small">Nothing changes yet: the rig says what withdrawing it would reach, and you confirm that.</div></form></details>`;
}

/** The preview's answer, as the harness gave it. */
interface Previewed {
  sha: string;
  words: string[];
  reach: {
    attempts: {
      attempt: string;
      then: string;
      lifecycle: string;
      verdict: { verdict: string } | null;
    }[];
    attempts_total: number;
  };
}

const THEN: Record<string, string> = {
  withdrawn: "withdrawn for good",
  judged_again: "judged again",
  stays_withdrawn: "stays withdrawn",
};

/** The rig's preview of a withdrawal, and the confirmation that says what it decides. */
function confirmCard(f: FormBase, r: RunView, cmd: CommandRow, p: Previewed): string {
  const job = typeof cmd.payload.job === "number" ? String(cmd.payload.job) : "";
  const subject: Record<string, string> = job
    ? { job, subject: `job:${job}` }
    : { attempt: String(cmd.payload.attempt ?? ""), subject: "attempt" };
  const rows = p.reach.attempts
    .map(
      (x) =>
        `<div class="fw small"><a href="${attemptHref(r, x.attempt)}">${esc(x.attempt)}</a> <span class="muted">${esc(x.verdict?.verdict ?? "no verdict yet")}, ${esc(x.lifecycle.replace(/_/g, " "))}</span> → <b>${esc(THEN[x.then] ?? x.then)}</b></div>`,
    )
    .join("");
  const more =
    p.reach.attempts_total > p.reach.attempts.length
      ? `<div class="fw muted small">and ${p.reach.attempts_total - p.reach.attempts.length} more</div>`
      : "";
  return `<div class="card warn"><div class="small"><b>What withdrawing it decides</b> <span class="muted">(the rig worked it out at ${esc(clockUtc(cmd.acked_at ?? cmd.issued_at))})</span></div><ul class="small">${p.words.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>${rows}${more}<div class="small">Why: ${esc(String(cmd.payload.reason ?? ""))}</div><form method="post" action="/ui/commands" class="stack">${hidden(
    {
      csrf: f.csrf,
      rig: f.rig,
      kind: "invalidate_evidence",
      run: r.id,
      ...subject,
      reason: String(cmd.payload.reason ?? ""),
      reach: p.sha,
      back: f.back,
    },
  )}<button class="danger">Withdraw the evidence</button><div class="muted small">If what it reaches changes before the rig takes this, the rig refuses it, and you see the new reach first.</div></form></div>`;
}

/**
 * The owner's part of the page for withdrawing this attempt's evidence: the form, or the newest
 * withdrawal command about it (`cmd`) while the rig works on it, its refusal, or its preview to
 * confirm. "" for an attempt withdrawn for good, which has nothing more to withdraw.
 */
export function withdrawBlock(
  f: FormBase,
  r: RunView,
  a: AttemptView,
  jobs: JudgeJob[],
  cmd: CommandRow | undefined,
  now: number,
): string {
  if (r.invalidations.some((i) => i.kind === "attempt" && i.attempts.includes(a.id))) return "";
  const head = `<div class="head"><h2>Withdraw evidence</h2><span class="right">the owner's alone</span></div>`;
  const ask = (open: boolean) => askForm(f, r, a, jobs, open);
  if (!cmd) return `<div class="block">${head}${ask(false)}</div>`;
  const p = commandProgress(cmd, now);
  const preview = cmd.payload.preview === true;
  if (!p.final)
    return `<div class="block" data-follow="${esc(commandFollowUrl(cmd.id))}" data-follow-state="${esc(p.state)}">${head}<div class="card flat small">${preview ? "The rig is working out what it would reach." : "The rig is withdrawing it."} ${esc(p.said)}</div></div>`;
  const why = refusalOf(cmd);
  if (why !== null)
    return `<div class="block">${head}<div class="card flat small"><b class="bad">${preview ? "The rig could not say what it reaches" : "The rig refused to withdraw it"}:</b> ${esc(why)}</div>${ask(true)}</div>`;
  const result = (cmd.outcome as { result?: Previewed } | null)?.result;
  if (preview && harnessConfirmed(cmd.outcome) && result?.sha)
    return `<div class="block">${head}${confirmCard(f, r, cmd, result)}${ask(false)}</div>`;
  return `<div class="block">${head}${ask(false)}</div>`;
}
