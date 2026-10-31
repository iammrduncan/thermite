import { RESEARCH_REVIEW } from "../../../core/research-check.ts";
import type { RigView, RunView } from "../../views/index.ts";
import { card, esc, icon } from "../components/index.ts";
import { runHref } from "../urls.ts";
import { clip } from "../words/index.ts";
import { short } from "./change.ts";
import { decidedState } from "./decided.ts";
import type { Need, NeedsContext } from "./index.ts";

/**
 * The owner's word on a run's reviews and its end: a review the review panel passed (a subjective
 * goal, or a research run's questions), and the harness's proposal to end a campaign as not
 * possible.
 */

/** Each review the review panel passed that waits for the owner's word. */
export function reviewNeeds(c: NeedsContext, u: RigView, r: RunView): Need[] {
  const { ds, f, now, back } = c;
  const out: Need[] = [];
  for (const rv of r.reviews.filter((x) => x.panel === "review_passed" && !x.owner)) {
    // A research run's review (goal 112): the review panel found every question answered.
    if (rv.goal === RESEARCH_REVIEW) {
      out.push({
        kind: "review",
        rig: u.id,
        run: r.id,
        ...card({
          tone: "violet",
          ic: icon.check,
          kind: "Review",
          question: "Accept that every question is answered?",
          headline: "The review panel found every question of this research run answered",
          why: "This run asks you about reviews before it ends",
          key: `review-${u.id}-${r.id}-${rv.review}`,
          decided: decidedState(
            ds,
            { rig: u.id, run: r.id, review: rv.review },
            undefined,
            (d) => (d.accept ? "Accept" : "Reject"),
            now,
          ),
          u,
          r,
          now,
          facts: `<dt>What</dt><dd>After its minimum running time, the review panel checked whether the run's verified claims answer each of its questions and decide each hypothesis. Every reviewer found every question answered, and code checked each answer: it cites only verified claims of the run, and its numbers are in them.</dd>
<dt>Why it waits</dt><dd>This run asks you about reviews (Ask me first about: reviews), so it ends only with your word.</dd>
<dt>The answers</dt><dd>${
            (rv.answers ?? []).length
              ? `<ol class="small">${(rv.answers ?? [])
                  .map((a) => `<li value="${a.question + 1}">${esc(clip(a.answer, 300))}</li>`)
                  .join("")}</ol>`
              : "The final report holds them once the run ends."
          } Review ${rv.review}; the final report gives every answer whole, with the claims it cites.</dd>
<dt>The review</dt><dd><a href="${runHref(r, "reviews")}">Review ${rv.review} on the run's Reviews tab</a>: each reviewer's answer on each question and hypothesis, the problems code found, and the decision on each item.</dd>`,
          choices: [
            {
              button: f.cmd({
                rig: u.id,
                kind: "accept_review",
                fields: { run: r.id, review: String(rv.review), accept: "true" },
                label: "Accept",
                cls: "primary",
                back,
              }),
              label: "Accept",
              does: "The run starts no new trial, and the rig's final writer writes its research paper. Once the paper is in and its running trials end, it writes its final report, the paper first and then the review panel's answers and verdicts, and closes as completed.",
            },
            {
              button: f.cmd({
                rig: u.id,
                kind: "accept_review",
                fields: { run: r.id, review: String(rv.review), accept: "false" },
                label: "Reject",
                back,
              }),
              label: "Reject",
              does: "The run goes on researching, and your rejection goes in its journal. The review panel is asked again only on new evidence.",
            },
          ],
        }),
      });
      continue;
    }
    out.push({
      kind: "review",
      rig: u.id,
      run: r.id,
      ...card({
        tone: "violet",
        ic: icon.check,
        kind: "Review",
        question: `Accept the goal "${rv.goal}" as met?`,
        headline: `The review panel passed "${esc(rv.goal)}"`,
        why: "A subjective goal counts as met only with your word",
        key: `review-${u.id}-${r.id}-${rv.review}`,
        decided: decidedState(
          ds,
          { rig: u.id, run: r.id, review: rv.review },
          undefined,
          (d) => (d.accept ? "Accept" : "Reject"),
          now,
        ),
        u,
        r,
        now,
        facts: `<dt>What</dt><dd>"${esc(rv.goal)}" is a subjective goal: code cannot check it, so the review panel did. The review panel passed it on commit <code>${esc(short(rv.commit))}</code>.</dd>
<dt>Why it waits</dt><dd>A subjective goal counts as met only with your word.</dd>`,
        choices: [
          {
            button: f.cmd({
              rig: u.id,
              kind: "accept_review",
              fields: { run: r.id, review: String(rv.review), accept: "true" },
              label: "Accept",
              cls: "primary",
              back,
            }),
            label: "Accept",
            does: "The goal counts as met. The judge then checks the champion's goals again; if every required goal is met, the campaign completes.",
          },
          {
            button: f.cmd({
              rig: u.id,
              kind: "accept_review",
              fields: { run: r.id, review: String(rv.review), accept: "false" },
              label: "Reject",
              back,
            }),
            label: "Reject",
            does: "The goal stays unmet, and your rejection is recorded.",
          },
        ],
      }),
    });
  }
  return out;
}

/** Each proposal of the harness to end the campaign as not possible. */
export function conclusionNeeds(c: NeedsContext, u: RigView, r: RunView): Need[] {
  const { ds, f, now, back } = c;
  const out: Need[] = [];
  for (const k of r.conclusions.filter((x) => x.decision === null)) {
    out.push({
      kind: "conclusion",
      rig: u.id,
      run: r.id,
      at: k.at,
      ...card({
        tone: "warn",
        ic: icon.warn,
        kind: "Not possible?",
        question: "End this campaign as not possible?",
        headline: `The harness proposes that the goals cannot be reached`,
        why: `${k.approaches} approach families were tried and refuted; only you can end a campaign`,
        key: `conclusion-${u.id}-${r.id}-${k.proposal}`,
        decided: decidedState(
          ds,
          { rig: u.id, run: r.id, proposal: k.proposal },
          k.at,
          (d) => (d.accept ? "End it: not possible" : "Keep going"),
          now,
        ),
        u,
        r,
        since: k.at,
        now,
        facts: `<dt>What</dt><dd>The harness (not an agent) proposes that the goals cannot be reached: ${k.approaches} approach families were tried and refuted, each with several judged attempts and no progress.</dd>
<dt>Refuted</dt><dd>${k.families.length ? k.families.map((x) => `<span class="chip">${esc(x.family)} · ${x.attempts} attempts</span>`).join(" ") : `<span class="muted">${k.approaches} families</span>`}</dd>`,
        choices: [
          {
            button: f.cmd({
              rig: u.id,
              kind: "conclude",
              fields: { run: r.id, proposal: String(k.proposal), accept: "true" },
              label: "End it: not possible",
              cls: "primary",
              back,
            }),
            label: "End it: not possible",
            does: "The run closes as not possible. Its agents stop and nothing more is judged.",
          },
          {
            button: f.cmd({
              rig: u.id,
              kind: "conclude",
              fields: { run: r.id, proposal: String(k.proposal), accept: "false" },
              label: "Keep going",
              back,
            }),
            label: "Keep going",
            does: "The proposal is dismissed and the agents carry on.",
          },
        ],
      }),
    });
  }
  return out;
}
