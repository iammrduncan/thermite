import { z } from "zod";
import { AdvisorQueueRequest } from "../../core/api/harness/advisors.ts";
import { researchDirectionRefusal } from "../../core/directions.ts";
import { StructuredDirective } from "../../core/directives.ts";
import { ideaWords, ruleRefusal } from "../../core/queue-target.ts";
import { labelledQuestion, measurementIn, measurementRefusal } from "../../core/research-check.ts";
import { LedgerError } from "../ledger/index.ts";
import type { AdvisorRole } from "../messages.ts";
import type { Experiment } from "../queue.ts";
import type { HarnessService } from "./index.ts";
import { conflictCheck, unknownIn } from "./rules.ts";
import { openRun, requireRun } from "./runs.ts";

/**
 * What the supervisor's advisors write into a run: their rules, their additions and moves for its
 * queue, their field notes, their receipts and answers for the owner's messages, and past research
 * for its folder. Nothing here can touch a verdict, a contract or a worker's brief.
 */

/**
 * addDirectives, with the rules it left out. A rule may name a direction the run doesn't have
 * yet: the planner designs it (goal 066). A research run has no planner, so there a rule for
 * another direction than a task kind is left out, recorded as a `directives_left_out` event
 * with why. A rule that freezes the queue's size or pins an experiment is left out the same
 * way (goal 081). The rest of the set stands.
 */
export function setAdvisorRules(
  svc: HarnessService,
  run: string,
  directives: unknown,
  author: string,
): { ids: number[]; left_out: { rule: string; why: string }[] } {
  const inst = requireRun(svc.ledger, run);
  if (inst.status === "closed") throw new LedgerError("invalid", `run ${run} is closed`);
  const parsed = z.array(StructuredDirective).min(1).max(20).parse(directives);
  const uncited = parsed.filter((d) => !d.citations.length);
  if (uncited.length) {
    throw new LedgerError("invalid", `${uncited.length} directive(s) without a citation`);
  }
  if (parsed.filter((d) => d.kind === "note").length > 3) {
    throw new LedgerError("invalid", "at most 3 notes per directive set");
  }
  conflictCheck(parsed);
  type Rule = (typeof parsed)[number];
  // Rules that freeze the queue's size or pin an experiment (goal 081), each with why.
  const refused = new Map(
    parsed.flatMap((d) => {
      const r = ruleRefusal(d);
      return r ? [[d, r] as const] : [];
    }),
  );
  const research = svc.contractFor(run).mode === "research";
  const known = svc.queue.directions(run);
  const unknown = research ? unknownIn(parsed, known) : [];
  const unknownWhy = unknown.length ? researchDirectionRefusal(unknown) : "";
  const isUnknown = (d: Rule) => !!d.family && unknown.includes(d.family);
  const keep = parsed.filter((d) => !isUnknown(d) && !refused.has(d));
  const named = (d: Rule) =>
    `${d.kind}${d.family ? ` ${d.family}` : ""}${typeof d.value === "string" ? ` "${d.value.slice(0, 80)}"` : ""}`;
  return svc.ledger.tx(() => {
    if (unknown.length)
      svc.ledger.appendEvent(author, "directives_left_out", run, {
        rules: parsed.filter(isUnknown),
        why: unknownWhy,
        reason: "unknown_direction",
      });
    for (const reason of ["freezes_queue", "pins_experiment"] as const) {
      const rules = parsed.filter((d) => !isUnknown(d) && refused.get(d)?.reason === reason);
      const first = rules[0];
      if (first)
        svc.ledger.appendEvent(author, "directives_left_out", run, {
          rules,
          why: refused.get(first)?.why ?? "",
          reason,
        });
    }
    return {
      ids: svc.ledger.directives.addSet(run, author, keep, true),
      left_out: parsed
        .filter((d) => !keep.includes(d))
        .map((d) => ({
          rule: named(d),
          why: isUnknown(d) ? unknownWhy : (refused.get(d)?.why ?? ""),
        })),
    };
  });
}

/**
 * An advisor's additions and moves for a run's queue (the supervisor, for the teachers or the
 * auditor; the review panel judges goals and has no way into the queue): each recorded with the
 * role as who made it. Each move is applied on its own; one that is refused (an unknown id, an
 * experiment no longer queued) is said in words and the others still apply.
 */
export function advisorQueue(
  svc: HarnessService,
  input: AdvisorQueueRequest,
): {
  added: string[];
  moved: string[];
  refused: string[];
} {
  const p = AdvisorQueueRequest.parse(input);
  openRun(svc.ledger, p.run);
  const actor = `supervisor:${p.role}`;
  const out = { added: [] as string[], moved: [] as string[], refused: [] as string[] };
  // A teacher's idea that repeats one waiting in the queue (up next, a lane's idea, or in
  // progress) is refused, with the one it repeats (goal 081): the portfolio is new ideas.
  const waiting = new Map(
    svc.queue
      .all(p.run)
      .filter((x) => x.state === "queued" || x.state === "proposed" || x.state === "assigned")
      .map((x) => [ideaWords(x.title), x] as const),
  );
  const where: Record<string, string> = {
    queued: "up next",
    proposed: "a lane's idea",
    assigned: "in progress",
  };
  // A research run measures nothing (goal 117): an item that asks for a measurement is a next
  // experiment for the run's report, never a task for its queue.
  const research = svc.ledger.runs.get(p.run)?.mode === "research";
  for (const a of p.add) {
    const same = p.role === "teacher" ? waiting.get(ideaWords(a.title)) : undefined;
    if (same) {
      out.refused.push(
        `add "${a.title.slice(0, 120)}": it repeats ${same.id} (${where[same.state] ?? same.state})`,
      );
      continue;
    }
    const measures = research
      ? measurementIn([a.title, a.details ?? "", a.why].join("\n"))
      : undefined;
    if (measures) {
      out.refused.push(`add "${a.title.slice(0, 120)}": ${measurementRefusal(measures)}`);
      continue;
    }
    // A research run's task serves one question (goal 117): an item that names none, in its
    // question or a title labelled "Question N (index K)", is refused in words.
    if (research && a.question === undefined && labelledQuestion(a.title) === undefined) {
      out.refused.push(
        `add "${a.title.slice(0, 120)}": a research run's task names the question it serves (question, an index from 0)`,
      );
      continue;
    }
    // A question the run does not have, or one in a run whose tasks name none: refused in words.
    let x: Experiment;
    try {
      x = svc.queue.add(p.run, { ...a, by: p.role, position: a.position }, actor);
    } catch (err) {
      if (!(err instanceof LedgerError)) throw err;
      out.refused.push(`add "${a.title.slice(0, 120)}": ${err.message}`);
      continue;
    }
    waiting.set(ideaWords(x.title), x);
    out.added.push(x.id);
  }
  for (const m of p.move) {
    try {
      svc.queue.move(p.run, m.id, { by: p.role, position: m.position, why: m.why }, actor);
      out.moved.push(m.id);
    } catch (err) {
      if (!(err instanceof LedgerError)) throw err;
      out.refused.push(`move ${m.id}: ${err.message}`);
    }
  }
  return out;
}

/**
 * An advisor's field notes (the supervisor, after the advisor's review, audit or verdict was
 * posted): each recorded as written by `<role>:<name>`, leniently (journal.ts, writeAll).
 */
export function advisorNotes(
  svc: HarnessService,
  input: { run: string; role: AdvisorRole; by: string; notes: unknown[] },
): {
  recorded: number[];
  problems: string[];
} {
  requireRun(svc.ledger, input.run);
  return svc.journal.writeAll(input.run, input.notes, {
    by: `${input.role}:${input.by}`,
    actor: "supervisor",
    source: "supervisor",
  });
}

/**
 * Past research for a run's folder (the supervisor, from control's knowledge base): each item
 * a file under the run's knowledge/, overwritten when it changed. With `collections` (those the
 * run's campaign may read now), the folder of one no longer among them is removed.
 */
export function writeKnowledge(
  svc: HarnessService,
  run: string,
  items: unknown[],
  collections?: string[] | undefined,
): { written: number; updated: number; removed: string[]; skipped: number } {
  requireRun(svc.ledger, run);
  return svc.knowledge.write(run, items, collections);
}

/** An advisor role's receipts and answers for the owner's messages in a run. */
export interface AdvisorReceipts {
  run: string;
  role: AdvisorRole;
  read: number[];
  answers: { message: number; text: string; advisor?: string | undefined }[];
}

/**
 * The advisors' receipts and answers (the supervisor, after an advisor ran with the messages
 * in its brief or package): every message must be in the run and addressed to the role.
 */
export function advisorMessages(
  svc: HarnessService,
  input: AdvisorReceipts,
): { read: number; answers: number } {
  requireRun(svc.ledger, input.run);
  const ids = [...new Set([...input.read, ...input.answers.map((a) => a.message)])];
  for (const id of ids) svc.messages.requireFor(input.run, input.role, id);
  svc.messages.read(input.read, input.role);
  for (const a of input.answers) svc.messages.answer({ run: input.run, role: input.role, ...a });
  return { read: ids.length, answers: input.answers.length };
}
