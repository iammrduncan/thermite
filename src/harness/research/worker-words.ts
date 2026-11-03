/**
 * What the research tools tell a worker of what it sent (goal 117): a refusal or a note, each
 * with what to do instead.
 */

/** Why a hypothesis is refused as a repeat of a live one: which, and what to do instead. */
export function repeatsWords(twin: { id: string; status: string; lane: string | null }): string {
  const id = twin.id;
  return twin.status === "author"
    ? `this hypothesis repeats ${id}, one of the author's: the review panel gives it a verdict already. Record claims for or against it instead of proposing it again`
    : `this hypothesis repeats ${id}${twin.lane ? ` (proposed by ${twin.lane})` : ""}: change that one with revise_hypothesis (id ${id}), its words, its question or its supporting claims, instead of proposing it again`;
}

/** What a worker is told of a finding it sends again once it is recorded, supported. */
export const KEPT_FINDING =
  "this finding is already recorded, supported: record a finding only for a new conclusion";

/** What a worker is told of a finding kept as a draft: how to fix it. */
export const DRAFT_FINDING =
  "recorded as a draft finding: fix these problems and send it again with the same words, which records it as supported";

/** Why a claim with no question is refused when the campaign has several. */
export const noQuestion = (n: number) =>
  `give "question": the index of the campaign question this claim answers, from 0 to ${n - 1}, as your brief names it ("Question 1 (index 0)"). A claim with no question counts toward no question's answer, and is not recorded`;
