import type { Hono } from "hono";
import { z } from "zod";
import {
  ADVISOR_MESSAGES,
  AUDITS,
  AUDITS_PENDING,
  BRIEF,
  CARDS,
  CARDS_PENDING,
  CODE_DIFF,
  CODE_FILE,
  CODE_FILES,
  DIRECTIVES,
  DiffQuery,
  EVIDENCE,
  EvidenceQuery,
  JOURNAL,
  LinesQuery,
  PAPER,
  PAPER_CHECK,
  PAPERS_PENDING,
  PageQuery,
  QUEUE,
  RESEARCH_FILE,
  RESEARCH_SEARCH,
  RESEARCH_SOURCE,
  REVIEW,
  REVIEW_KINDS,
  REVIEW_TRIES,
  REVIEWS_PENDING,
  RUNS,
  researchList,
  SearchQuery,
  SourceQuery,
} from "../../core/api/harness/advisors.ts";
import { RESEARCH_KINDS } from "../../core/api/harness/research.ts";
import { ADVISORS, KB } from "../../core/api/harness/supervisor.ts";
import { additionsOf } from "../../core/role-additions.ts";
import { type ApiContext, limitOf } from "./context.ts";

/**
 * The supervisor's advisors (the teachers, the auditor, the review panel, the synthesizer and the
 * final writer): their reads of a run, the packages they decide on, and where their rules,
 * decisions, cards, papers, receipts, queue changes, notes and past research go.
 */
export function advisorRoutes(app: Hono, { service, supervisor }: ApiContext): void {
  app.post(DIRECTIVES.path, supervisor, limitOf(DIRECTIVES), async (c) => {
    const body = DIRECTIVES.body.parse(await c.req.json());
    // Rules naming a direction the run doesn't have are left out, each with why (goal 066).
    return c.json(service.setAdvisorRules(body.run, body.directives, "supervisor"));
  });

  // The supervisor's deterministic inputs for its teachers, auditor and review panel, and
  // where their outputs go. None of these can set a verdict, a contract or a champion.
  app.get(RUNS.path, supervisor, (c) =>
    c.json({
      runs: service.ledger.runs.list().map((i) => ({
        id: i.id,
        campaign: i.campaign,
        mode: i.mode,
        status: i.status,
        // The owner's messages each advisor role has not read yet (their ids): a new one for the
        // teachers starts their round at once, not at the next hour.
        owner_messages_waiting: service.messages.waitingIds(i.id),
        // The MCP servers its kit names, with the agents that get each: the advisors' share is
        // the supervisor's to call (goal 068).
        mcp_servers: service.mcpUses(i.id),
        // The campaign's own context settings, which the advisors' calls for the run take too
        // (goal 070); null: none.
        agents_context: service.ledger.contracts.get(i.campaign, i.version)?.agents_context ?? null,
        // The owner's additions to its roles, which the advisors' prompts carry (goal 166).
        role_additions: additionsOf(service.ledger.contracts.get(i.campaign, i.version)),
        // The planner's round left the queue below its target (goal 081): the teachers' round
        // starts at once, not on the clock. Null: the queue is at its target, or none applies.
        queue_low: service.queueLow(i.id),
      })),
    }),
  );

  app.get(BRIEF.path, supervisor, (c) => {
    const run = z.string().min(1).parse(c.req.query("run"));
    return c.json(service.brief(run) as object);
  });

  // The teachers' reads of a run's code and evidence (goal 081), read only: the champion's tree,
  // one of its files by lines, an attempt's diff in parts, and the judge's public findings.
  // Nothing here reads the kit, a held-out cell or a measurement, and nothing writes: a failed
  // held-out check is only its kind in fixed words (goal 082).
  const runOf = (c: { req: { query(k: string): string | undefined } }) =>
    z.string().min(1).max(100).parse(c.req.query("run"));
  const numberOf = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));
  app.get(CODE_FILES.path, supervisor, async (c) =>
    c.json(await service.codeFiles(runOf(c), c.req.query("path") ?? "")),
  );
  app.get(CODE_FILE.path, supervisor, async (c) => {
    const q = LinesQuery.parse({
      path: c.req.query("path"),
      offset: numberOf(c.req.query("offset")),
      limit: numberOf(c.req.query("limit")),
    });
    return c.json(await service.codeFile(runOf(c), q.path, q.offset, q.limit));
  });
  app.get(CODE_DIFF.path, supervisor, async (c) => {
    const q = DiffQuery.parse({
      attempt: c.req.query("attempt"),
      offset: numberOf(c.req.query("offset")),
    });
    return c.json(await service.attemptDiff(runOf(c), q.attempt, q.offset));
  });
  app.get(EVIDENCE.path, supervisor, (c) => {
    const attempt = EvidenceQuery.parse(c.req.query("attempt"));
    return c.json(service.evidence(runOf(c), attempt) as object);
  });

  // The teachers' reads of a run's own research (goal 098), read only: each kind a page at a
  // time, one source's archived text in parts, one file of its research folder by lines, and a
  // search of all of it by words. Every answer is cut to a size and marked as data. A worker's
  // token reads none of it: workers read the research folder itself.
  for (const kind of RESEARCH_KINDS)
    app.get(researchList(kind).path, supervisor, (c) => {
      const q = PageQuery.parse({
        offset: numberOf(c.req.query("offset")),
        limit: numberOf(c.req.query("limit")),
        question: numberOf(c.req.query("question")),
        state: c.req.query("state") || undefined,
      });
      return c.json(service.runResearch.list(runOf(c), kind, q));
    });
  app.get(RESEARCH_SOURCE.path, supervisor, (c) => {
    const q = SourceQuery.parse({
      source: c.req.query("source"),
      offset: numberOf(c.req.query("offset")),
      limit: numberOf(c.req.query("limit")),
    });
    return c.json(service.runResearch.source(runOf(c), q.source, q.offset, q.limit));
  });
  app.get(RESEARCH_FILE.path, supervisor, (c) => {
    const q = LinesQuery.parse({
      path: c.req.query("path"),
      offset: numberOf(c.req.query("offset")),
      limit: numberOf(c.req.query("limit")),
    });
    return c.json(service.runResearch.file(runOf(c), q.path, q.offset, q.limit));
  });
  app.get(RESEARCH_SEARCH.path, supervisor, (c) => {
    const q = SearchQuery.parse({
      q: c.req.query("q") ?? undefined,
      kinds: c.req.query("kinds") || undefined,
      limit: numberOf(c.req.query("limit")),
    });
    return c.json(
      service.runResearch.search(runOf(c), q.q, {
        kinds: q.kinds?.split(",").map((k) => k.trim()),
        limit: q.limit,
      }),
    );
  });

  app.get(AUDITS_PENDING.path, supervisor, async (c) =>
    c.json({ audits: await service.auditPackages() }),
  );

  app.post(AUDITS.path, supervisor, limitOf(AUDITS), async (c) => {
    const body = AUDITS.body.parse(await c.req.json());
    return c.json(
      (await service.decideAudit({ ...body, auditor: `supervisor:${body.auditor}` })) as object,
    );
  });

  // Goal reviews; research reviews (goal 112) only when the caller asks for them with
  // ?kinds=goal,research, so a supervisor from before them never gets a package it cannot answer.
  app.get(REVIEWS_PENDING.path, supervisor, (c) => {
    const asked = (c.req.query("kinds") ?? "goal")
      .split(",")
      .map((k) => k.trim())
      .filter((k): k is (typeof REVIEW_KINDS)[number] =>
        (REVIEW_KINDS as readonly string[]).includes(k),
      );
    return c.json({ reviews: service.reviewPackages(asked) });
  });

  // A research review's answers are larger than a goal review's verdicts: one for each question
  // and hypothesis, from each reviewer.
  // A try of a review that the supervisor could not post (goal 116): kept with the review, so the
  // run's Reviews tab and get_run say each failed try and why. Nothing else changes.
  app.post(REVIEW_TRIES.path, supervisor, limitOf(REVIEW_TRIES), async (c) => {
    const id = z.coerce.number().int().positive().parse(c.req.param("id"));
    const body = REVIEW_TRIES.body.parse(await c.req.json());
    return c.json(service.recordReviewTry(id, body.try, body.error, "supervisor"));
  });
  app.post(REVIEW.path, supervisor, limitOf(REVIEW), async (c) => {
    const id = z.coerce.number().int().positive().parse(c.req.param("id"));
    const body = REVIEW.body.parse(await c.req.json());
    return c.json({ review: id, ...service.recordReviewPanel(id, body.results, "supervisor") });
  });

  // Answer cards (goal 117): for each running research run, the questions whose evidence changed
  // since their card, each with its card, its new verified claims, its rubric and the problems of
  // its last refused card, as the synthesizer's request. Only a supervisor from goal 117 asks.
  app.get(CARDS_PENDING.path, supervisor, (c) => c.json({ runs: service.cardPackages() }));
  // The synthesizer's cards for a run: each checked by code, then kept as its question's next
  // version or refused with its problems.
  app.post(CARDS.path, supervisor, limitOf(CARDS), async (c) =>
    c.json(
      service.submitCards(c.req.param("run"), CARDS.body.parse(await c.req.json()), "supervisor"),
    ),
  );

  // The research runs that wait for their paper (goal 112), each as the final writer's package:
  // the review panel's checked answers and verdicts, the brief, the corpus figures and the rules
  // the paper is checked against. Only a supervisor from goal 112 asks for it.
  app.get(PAPERS_PENDING.path, supervisor, (c) => c.json({ papers: service.paperPackages() }));
  // A draft checked by the harness's code, for the final writer's check_paper tool: each problem
  // with its line. Nothing is recorded.
  app.post(PAPER_CHECK.path, supervisor, limitOf(PAPER_CHECK), async (c) => {
    const body = PAPER_CHECK.body.parse(await c.req.json());
    return c.json(service.papers.check(c.req.param("run"), body.paper, body.experiments));
  });
  // The final writer's paper, with the STE checker's result the supervisor ran on its text:
  // accepted, or refused with its problems (goal 112).
  app.post(PAPER.path, supervisor, limitOf(PAPER), async (c) =>
    c.json(
      service.submitPaper(
        c.req.param("run"),
        PAPER.body.parse(await c.req.json()),
        "supervisor",
      ) as object,
    ),
  );

  // The supervisor says which advisors it has (goal 079): whether an auditor decides this rig's
  // audits, its review panel's size, and whether a final writer writes research runs' papers
  // (goal 112; left out by a supervisor from before it: none). Without an auditor, the audits
  // held go on by the run's rules.
  app.put(ADVISORS.path, supervisor, limitOf(ADVISORS), async (c) => {
    const body = ADVISORS.body.parse(await c.req.json());
    return c.json({ released: await service.setAdvisors(body, "supervisor") });
  });

  // The advisors' receipts and answers for the owner's messages: which messages an advisor role
  // was given (in its brief or package) and what it answered. Each message must be in the run and
  // addressed to that role.
  app.post(ADVISOR_MESSAGES.path, supervisor, limitOf(ADVISOR_MESSAGES), async (c) =>
    c.json(service.advisorMessages(ADVISOR_MESSAGES.body.parse(await c.req.json()))),
  );

  // The advisors' additions and moves for a run's experiment queue, each recorded with the
  // advisor role as who made it. Advisors add and reorder; they don't drop or give out work.
  app.post(QUEUE.path, supervisor, limitOf(QUEUE), async (c) =>
    c.json(service.advisorQueue(QUEUE.body.parse(await c.req.json()))),
  );

  // The advisors' field notes, posted after their review, audit or verdict: each recorded as
  // written by `<role>:<name>`. Each note is checked on its own; a refused one is said.
  app.post(JOURNAL.path, supervisor, limitOf(JOURNAL), async (c) =>
    c.json(service.advisorNotes(JOURNAL.body.parse(await c.req.json()))),
  );

  // Past research for a run's folder, from control's knowledge base (the supervisor syncs it):
  // each item a file under the run's knowledge/. `collections` (those the run's campaign may read
  // now) removes the folder of a collection whose grant was revoked.
  app.post(KB.path, supervisor, limitOf(KB), async (c) => {
    const body = KB.body.parse(await c.req.json());
    return c.json(service.writeKnowledge(body.run, body.items, body.collections));
  });
}
