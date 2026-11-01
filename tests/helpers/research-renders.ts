import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { RunView, StoredEvent } from "../../src/control/views/index.ts";
import { researchEvent } from "../../src/control/views/research.ts";
import { RESEARCH_KINDS } from "../../src/core/api/harness/research.ts";
import {
  indexEvent,
  type KbFields,
  type KbHeld,
  type KbIndexTarget,
  type KbStored,
  mergeItem,
  metaOf,
} from "../../src/core/kb-index.ts";
import { fillResearch, makeResearchRun, writeCards } from "./research-run.ts";

/**
 * Records made in the same millisecond come in an order their random ids decide: a list of
 * records, each with its id, is put in its ids' order. The order a query gives is not what these
 * renders hold equal.
 */
function inOrder(_key: string, value: unknown): unknown {
  if (!Array.isArray(value) || !value.every((x) => x && typeof x === "object" && "id" in x))
    return value;
  return [...value].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/**
 * A research run with some of every record, and what each of the four renderers of its research
 * makes of it (goal 125, T11): the research folder's files (harness/research/folder.ts), the
 * teachers' reads (harness/run-research.ts), the knowledge base's items (core/kb-index.ts and
 * kb-index-research.ts) and control's view of the run's hypotheses and decisions
 * (control/views/research.ts). Every id, time, address and hash is replaced by a stable name, so
 * two runs of it give the same JSON: tests/fixtures/research-renders.json holds it as the code
 * made it before the four took their reading from core/corpus.ts.
 */
export async function researchRenders(): Promise<unknown> {
  const r = await makeResearchRun();
  try {
    const ids = await fillResearch(r);
    writeCards(r, ids);
    const { research, run, env } = r;
    const ledger = env.service.ledger;
    // A worker's hypotheses for the pool: one revised, one merged into it, one promoted, one
    // retired, as the planner and the owner change them. Each change a few milliseconds after the
    // last, so a file's "Changed:" line never depends on the clock's resolution.
    const later = () => new Promise((done) => setTimeout(done, 5));
    const pool = research.proposeHypothesis(run, "lane-1", {
      text: "Archives outlive their workers.",
      question: 0,
      supporting: [ids.claims.verified],
    }) as { hypothesis: string };
    const twin = research.proposeHypothesis(run, "lane-2", {
      text: "Clocks keep campaigns honest.",
      question: 1,
    }) as { hypothesis: string };
    await later();
    research.reviseHypothesis(run, "lane-1", {
      id: pool.hypothesis,
      text: "Archives outlive the workers that fill them.",
      supporting: [ids.claims.verified, ids.claims.clock],
    });
    await later();
    research.reviseHypothesis(run, "lane-2", {
      id: twin.hypothesis,
      text: "Archives outlive the workers that fill them.",
    });
    await later();
    research.hypothesisStatus(
      run,
      { id: pool.hypothesis, status: "promoted", reason: "two verified claims" },
      "planner",
    );
    const idle = research.proposeHypothesis(run, null, {
      text: "Nobody reads the archive.",
    }) as { hypothesis: string };
    await later();
    research.hypothesisStatus(
      run,
      { id: idle.hypothesis, status: "retired", reason: "no source says so" },
      "control:owner",
    );
    const names = new Map<string, string>([
      [ids.sources[0] as string, "s-a"],
      [ids.sources[1] as string, "s-b"],
      [ids.claims.verified, "c-verified"],
      [ids.claims.draft, "c-draft"],
      [ids.claims.clock, "c-clock"],
      [ids.hypothesis, "h-author"],
      [pool.hypothesis, "h-pool"],
      [twin.hypothesis, "h-twin"],
      [idle.hypothesis, "h-idle"],
      [ids.findings.supported, "f-supported"],
      [ids.findings.draft, "f-draft"],
    ]);

    // The research folder: every file it writes, by path, but the lanes' working areas.
    const root = r.folder.sync(run);
    const folder: Record<string, string> = {};
    const walk = (dir: string) => {
      for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name);
        const rel = relative(root, path);
        if (rel === "work" || rel.startsWith("work/")) continue;
        if (statSync(path).isDirectory()) walk(path);
        else folder[rel] = readFileSync(path).includes(0) ? "(binary)" : readFileSync(path, "utf8");
      }
    };
    walk(root);

    // The teachers' reads: each kind's list, a source, the files and the summary.
    const rr = env.service.runResearch;
    const teachers = {
      lists: Object.fromEntries(RESEARCH_KINDS.map((k) => [k, rr.list(run, k, { limit: 50 })])),
      drafts: rr.list(run, "claim", { state: "draft" }),
      question: rr.list(run, "claim", { question: 1 }),
      source: rr.source(run, ids.sources[0] as string),
      files: ["REPORT.md", "cards/q0.md", "cards/q1.md", "report/synthesis.md"].map((p) =>
        rr.file(run, p),
      ),
      summary: rr.summary(run),
    };

    // The events as control holds them, with a review's items and its decisions, as the
    // review panel's would come.
    const events: StoredEvent[] = ledger
      .eventsAfter(0, 10_000)
      .events.map(
        (e) => ({ ...e, body: e.body as Record<string, unknown> }) as unknown as StoredEvent,
      );
    const at = "2026-10-27T06:00:00.000Z";
    const panel = [
      {
        kind: "review_items",
        body: {
          review: 1,
          reviewer: "reviewer-1",
          items: [
            {
              kind: "question",
              key: "0",
              card_version: 1,
              verdict: "answered",
              certainty: "high",
              reasons: "Two quotes agree.",
              claims: [ids.claims.verified],
              problems: [],
            },
            { kind: "hypothesis", key: pool.hypothesis, verdict: "supported", reasons: "Yes." },
            { kind: "nonsense", key: "x" },
          ],
        },
      },
      {
        kind: "item_decided",
        body: {
          review: 1,
          kind: "question",
          key: "0",
          card_version: 1,
          decision: "answered",
          certainty: "high",
          dissent: [
            { reviewer: "reviewer-2", verdict: "open", certainty: null, reasons: "One site." },
            { verdict: "no reviewer" },
          ],
        },
      },
      {
        kind: "item_decided",
        body: {
          review: 1,
          kind: "hypothesis",
          key: pool.hypothesis,
          card_version: null,
          decision: "supported",
          certainty: null,
          dissent: [],
        },
      },
    ];
    for (const [i, p] of panel.entries())
      events.push({
        id: 100_000 + i,
        at,
        actor: "supervisor",
        kind: p.kind,
        subject: run,
        body: p.body,
      } as unknown as StoredEvent);

    // The knowledge base's items, from every event.
    const items = new Map<string, KbStored>();
    const held = (s: KbStored | undefined): KbHeld | undefined =>
      s && { body: s.body, meta: metaOf(s.meta) };
    const target: KbIndexTarget = {
      runCreated: () => {},
      item: (_run, kind, ref) => held(items.get(`${kind}:${ref}`)),
      attempt: (ref) => {
        const h = held(items.get(`attempt:${ref}`));
        return h && { run, ...h };
      },
      put: (_run, kind, ref, f: KbFields) =>
        void items.set(`${kind}:${ref}`, mergeItem(ref, items.get(`${kind}:${ref}`), f)),
    };
    for (const e of events)
      indexEvent(target, {
        at: e.at,
        actor: e.actor,
        kind: e.kind,
        subject: e.subject ?? "",
        body: e.body,
      });
    const kb = Object.fromEntries([...items.entries()].sort(([a], [b]) => a.localeCompare(b)));

    // Control's view of the run's hypotheses, reviews and decisions.
    const view = {
      hypotheses: [],
      decisions: [],
      reviews: [{ review: 1, reviewers: [], decided: [], failed_tries: [] }],
      progress: null,
    } as unknown as RunView;
    for (const e of events) researchEvent(view, e);
    const control = {
      hypotheses: view.hypotheses,
      decisions: view.decisions,
      reviews: view.reviews,
    };

    // Every name that changes between two runs, made stable.
    let text = JSON.stringify({ folder, teachers, kb, control });
    for (const [id, name] of names) text = text.split(id).join(`<${name}>`);
    text = text
      .split(r.base)
      .join("<web>")
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<at>")
      .replace(/[0-9a-f]{64}/g, "<sha>")
      .replace(/"elapsed_ms":\d+/g, '"elapsed_ms":"<ms>"')
      .replace(/127\.0\.0\.1:\d+/g, "<web-host>");
    return JSON.parse(text, inOrder);
  } finally {
    await r.close();
  }
}
