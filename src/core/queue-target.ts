import { EXPERIMENT_ID, inner } from "./ids.ts";

/**
 * A run's target queue depth, the sameness of two ideas, and the rules that may never be set
 * (goal 081).
 *
 * The target is how many queued experiments a run keeps ready for its lanes' next trials. It
 * drives ideas: when the queue is below it, the planner's round is asked to top it up with
 * distinct ideas, and when the planner can't, the teachers are asked at once. It is never a cap:
 * nothing stops adding experiments above it, and nothing ends research because of it. A
 * campaign sets it in its contract (`lanes.queue_target`); without one, it is two for each lane.
 */

/** The target's default: experiments kept ready for each lane. */
export const QUEUE_TARGET_PER_LANE = 2;

/** A run's target: the contract's own, or two for each of its lanes (`lanes`: the lanes now). */
export function queueTarget(
  contract: { lanes: { count: number; queue_target?: number | undefined } },
  lanes?: number | undefined,
): number {
  return contract.lanes.queue_target ?? QUEUE_TARGET_PER_LANE * (lanes ?? contract.lanes.count);
}

/** Where the target comes from, in words: "2 for each of 2 lanes", or the campaign's own. */
export function queueTargetNote(
  contract: { lanes: { count: number; queue_target?: number | undefined } },
  lanes?: number | undefined,
): string {
  const l = lanes ?? contract.lanes.count;
  if (contract.lanes.queue_target === 0) return "no ideas are asked for";
  if (contract.lanes.queue_target !== undefined) return "the campaign's own number";
  return `${QUEUE_TARGET_PER_LANE} for each of ${l} lane${l === 1 ? "" : "s"}`;
}

/** The target in words: "4 (2 for each of 2 lanes)", or "7 (the campaign's own number)". */
export function queueTargetWords(
  contract: { lanes: { count: number; queue_target?: number | undefined } },
  lanes?: number | undefined,
): string {
  return `${queueTarget(contract, lanes)} (${queueTargetNote(contract, lanes)})`;
}

/**
 * An idea's words for comparing it with another: its title in lowercase, letters and digits
 * only, one space between words. Two ideas with the same words are one idea.
 */
export function ideaWords(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** A rule as an advisor gives it, for the refusals below. */
export interface RuleText {
  kind: string;
  family?: string | undefined;
  value?: string | number | undefined;
  rationale: string;
}

/** Why code refuses a rule: it freezes the queue's size, or pins an experiment. */
export interface RuleRefusal {
  reason: "freezes_queue" | "pins_experiment";
  why: string;
}

/*
 * Freezing and pinning, found by their words (goal 081). A refusal drops the rule silently for
 * the planner, which is worse than a miss, so code refuses only what is clear:
 *
 * - a rule that freezes the run's experiment queue as a whole: freeze it, stop adding to it, cap
 *   its size, or keep it as it is;
 * - a rule that pins a named experiment (`x-` and 12 hexadecimal characters): keep it first or in
 *   place, retry it, or run it again and again; or a rule whose subject is an experiment.
 *
 * A rule about a direction or a kind of idea ("do not add more unrolling experiments", "stop
 * proposing tiling ideas", any AVOID rule's direction) is not a freeze: the words must name the
 * queue's experiments or ideas with nothing that narrows them. A project's own queues ("back off
 * when the submission queue is full", "limit the queue depth") are not the run's queue. An
 * experiment cited as evidence, or asked for once ("run x-… next"), is not pinned.
 */

/** The run's queue as a whole: "the queue", "the experiment queue", "the run's backlog". */
const RUN_QUEUE = String.raw`(?:the|this|our|its|your)\s+(?:run'?s\s+)?(?:(?:experiments?|research|ideas?)\s+)?(?:queue|backlog)\b`;
/** The run's queue by a name no project queue has: "the experiment queue", "the run's queue". */
const EXPERIMENT_QUEUE = String.raw`(?:(?:the|this|our|its|your)\s+)?(?:run'?s\s+(?:experiments?\s+)?|(?:experiments?|research|ideas?)\s+)(?:queue|backlog)\b`;
/**
 * What may follow for the words to mean the whole queue: the end of a clause, or when. Anything
 * else ("… on tiling", "… per item", "… from the IRQ handler") narrows them.
 */
const ENDS = String.raw`(?=\s*(?:$|[.;:,!?)]|[-–—]\s|(?:until|till|for\s+now|for\s+a\s+while|for\s+the\s+rest|at\s+all|any\s*more|right\s+now|yet|now|this\s+(?:round|epoch)|whatsoever)\b))`;
/** Words that only count, never narrow: "any more", "new", "further". */
const COUNT = String.raw`(?:(?:any|more|new|further|additional|other|extra|fresh)\s+)*`;
/** The queue's contents: experiments, ideas or proposals, or the queue's entries or items. */
const CONTENTS = String.raw`(?:experiments?|ideas?|proposals?|queue(?:d)?\s+(?:entr(?:y|ies)|items?|experiments?|ideas?))`;
const NOT = String.raw`(?:do\s+not|don'?t|never|no\s+longer|stop|cease|quit|refrain\s+from|hold\s+off\s+on|avoid|pause|halt|suspend)`;
const ADD = `(?:add(?:ing)?|(?:en)?queu(?:e|eing|ing)|propos(?:e|ing)|insert(?:ing)?|creat(?:e|ing)|push(?:ing)?|put(?:ting)?|generat(?:e|ing)|suggest(?:ing)?)`;
const INTO = String.raw`(?:\s+(?:to|in|into|for|on)\s+${RUN_QUEUE})?`;

/** Words that freeze the run's experiment queue as a whole. */
const FREEZES: RegExp[] = [
  // Stop adding to it: "do not add queue entries", "don't propose more experiments for the queue".
  new RegExp(String.raw`\b${NOT}\s+${ADD}\s+${COUNT}${CONTENTS}${INTO}${ENDS}`, "i"),
  // "do not add anything to the queue", "don't put more into the queue".
  new RegExp(
    String.raw`\b${NOT}\s+(?:add(?:ing)?|put(?:ting)?|push(?:ing)?)\s+(?:anything|nothing|more|entries|items)(?:\s+(?:new|more|else))?\s+(?:to|in|into|on)\s+${RUN_QUEUE}${ENDS}`,
    "i",
  ),
  // "stop adding to the queue", "do not grow the queue beyond 4".
  new RegExp(
    String.raw`\b${NOT}\s+(?:add(?:ing)?\s+to|grow(?:ing)?|expand(?:ing)?|extend(?:ing)?|fill(?:ing)?|refill(?:ing)?|top(?:ping)?\s+up)\s+${RUN_QUEUE}(?:\s+(?:beyond|past|above|over)\s+(?:\d+|its\s+(?:current\s+)?size))?${ENDS}`,
    "i",
  ),
  // "No new experiments: the lanes have enough", "hold off on new experiments".
  new RegExp(
    String.raw`\b(?:no|hold\s+off\s+on|pause|halt|suspend|stop|freeze)\s+(?:(?:any|more|new|further|additional|other|extra|fresh)\s+)+${CONTENTS}${INTO}${ENDS}`,
    "i",
  ),
  // "Only work on the queued experiments, nothing new".
  new RegExp(
    String.raw`\bonly\s+(?:work\s+on|run|try|take|use|pick\s+from|draw\s+from)\s+(?:the\s+)?(?:queued|existing|current|remaining)\s+(?:experiments|ideas|entries|items)${ENDS}`,
    "i",
  ),
  new RegExp(String.raw`\bnothing\s+new\s+(?:to|in|into)\s+${RUN_QUEUE}${ENDS}`, "i"),
  // Keep it as it is: "keep the queue unchanged", "leave the backlog unchanged".
  new RegExp(
    String.raw`\b(?:keep|leave|hold|maintain|preserve)\s+${RUN_QUEUE}\s+(?:unchanged|untouched|intact|alone|frozen|fixed|static|the\s+same|as\s+(?:it\s+)?is|as\s+it\s+stands|where\s+it\s+is|at\s+(?:its\s+)?(?:current\s+)?(?:size|length|depth))${ENDS}`,
    "i",
  ),
  // Freeze it: "freeze the queue", "the queue is frozen".
  new RegExp(String.raw`\b(?:freeze|froze)\s+${RUN_QUEUE}${ENDS}`, "i"),
  new RegExp(
    String.raw`\b${RUN_QUEUE}\s+(?:is|stays|remains|should\s+(?:stay|remain|be)|must\s+(?:stay|remain|be))\s+(?:frozen|unchanged|as\s+it\s+is|closed\s+to\s+new\s+(?:experiments|ideas|entries))${ENDS}`,
    "i",
  ),
  // Cap its size: "at most 2 experiments in the queue", "cap the queue at 5 experiments".
  new RegExp(
    String.raw`\b(?:at\s+most|no\s+more\s+than|never\s+more\s+than|max(?:imum)?(?:\s+of)?|up\s+to|only)\s+\d+\s+(?:queued\s+)?(?:experiments?|ideas?)\s+(?:queued|in\s+${RUN_QUEUE}|up\s+next|ready|waiting)\b`,
    "i",
  ),
  new RegExp(
    String.raw`\b(?:keep|hold|cap|limit|restrict|shrink|trim|bound)\s+${RUN_QUEUE}\s+(?:at|to|below|under|within)\s+(?:most\s+)?\d+\s+(?:experiments?|ideas?)\b`,
    "i",
  ),
  // The queue by a name no project queue has: "cap the experiment queue", "keep it small".
  new RegExp(
    String.raw`\b(?:cap|limit|restrict|shrink|trim|bound|freeze|lock)\s+${EXPERIMENT_QUEUE}`,
    "i",
  ),
  new RegExp(
    String.raw`\b(?:keep|hold|leave|maintain)\s+${EXPERIMENT_QUEUE}\s+(?:small|short|empty|tiny|minimal|at\s+(?:most\s+)?\d+)\b`,
    "i",
  ),
];

/** An experiment's id, as a rule might name one. */
const ID = inner(EXPERIMENT_ID);
const AN_ID = String.raw`(?:experiment\s+)?(${ID})\b`;

/** Words that pin a named experiment: keep it first or in place, retry it, run it again. */
const PINS: RegExp[] = [
  // "pin x-…", "keep x-… at the top until it is measured".
  new RegExp(String.raw`\bpin(?:s|ned|ning)?\s+${AN_ID}`, "i"),
  new RegExp(
    String.raw`\b(?:keep(?:s|ing)?|hold(?:s|ing)?|leave|lock)\s+${AN_ID}[^.;]{0,60}?\b(?:at\s+the\s+(?:top|front|head)|on\s+top|first|in\s+place|queued|in\s+the\s+queue)\b`,
    "i",
  ),
  // "retry x-…", "rerun x-…", "requeue x-…".
  new RegExp(
    String.raw`\b(?:retr(?:y|ies|ied)|re-?try|re-?runs?|re-?queue|re-?measure|re-?submit|repeat)\s+${AN_ID}`,
    "i",
  ),
  // "run x-… again", "try x-… until it passes".
  new RegExp(
    String.raw`\b(?:run|try|measure|queue|test|do)\s+${AN_ID}\s+(?:again|repeatedly|every\s+(?:round|epoch|time)|each\s+(?:round|epoch)|over\s+and\s+over|until|till)\b`,
    "i",
  ),
  // "x-… stays at the top", "x-… must be retried", "x-… must run again".
  new RegExp(
    String.raw`\b(${ID})\s+(?:stays|remains|is\s+kept|should\s+(?:stay|remain)|must\s+(?:stay|remain))\s+(?:first|at\s+the\s+top|on\s+top|in\s+place|queued|in\s+the\s+queue)\b`,
    "i",
  ),
  new RegExp(
    String.raw`\b(${ID})\s+(?:must|should|has\s+to|needs\s+to)\s+(?:be\s+)?(?:retried|re-?run|re-?measured|re-?queued|kept|tried\s+again|run\s+again|measured\s+again)\b`,
    "i",
  ),
  new RegExp(
    String.raw`\b(${ID})\s+(?:must|should|has\s+to|needs\s+to)\s+(?:be\s+)?(?:run|tried|measured)\s+(?:repeatedly|until|till|every\s+(?:round|epoch))\b`,
    "i",
  ),
];

/** A rule whose subject is an experiment, not a direction: a TRY, MANDATE or PRIORITY of x-…. */
const SUBJECT = new RegExp(`^:?(${ID}):?$`, "i");

/**
 * Why a rule from the advisors is refused (goal 081), or undefined when it may stand. A rule may
 * never freeze the run's experiment queue as a whole ("do not add queue entries", "keep the queue
 * unchanged"): the queue keeps a target of ideas ready. Nor may it pin a named experiment (keep it
 * first, retry it, run it again): a rule names directions, and an experiment's place is the
 * queue's, which moves change. Each of the rule's direction, value and reasons is read alone.
 */
export function ruleRefusal(r: RuleText): RuleRefusal | undefined {
  const parts = [r.family ?? "", typeof r.value === "string" ? r.value : "", r.rationale].filter(
    (p) => p.trim(),
  );
  const frozen = parts
    .flatMap((p) => FREEZES.map((x) => x.exec(p)?.[0]))
    .find((m): m is string => !!m);
  if (frozen)
    return {
      reason: "freezes_queue",
      why: `a rule may not freeze the queue's size ("${frozen.trim().slice(0, 120)}"): the run keeps a target of experiments ready, and the planner and the teachers add ideas to it. Leave the queue's size alone; avoid a direction, or drop nothing, instead`,
    };
  const subject =
    ["try", "mandate", "priority"].includes(r.kind) &&
    [r.family ?? "", typeof r.value === "string" ? r.value : ""]
      .map((s) => SUBJECT.exec(s.trim())?.[1])
      .find(Boolean);
  const pinned =
    subject || parts.flatMap((p) => PINS.map((x) => x.exec(p)?.[1])).find((m): m is string => !!m);
  if (pinned)
    return {
      reason: "pins_experiment",
      why: `a rule may not pin an experiment (${pinned.toLowerCase()}): a rule names directions. To put an experiment first, move it in the queue (moves); the planner decides when it runs`,
    };
  return undefined;
}
