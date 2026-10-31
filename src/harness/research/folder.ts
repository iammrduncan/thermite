import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import type { ResearchFolderPaths } from "../../agents/tools/index.ts";
// The folder's files are written whole (readers never see half of one), with the modes of the
// controller's umask (022): every role reads them, and only the controller's user changes them.
import { writeAtomic } from "../../common/fs.ts";
import { BRIEF_FILE, briefFile } from "../../core/brief.ts";
import { COMPACTIONS_DIR } from "../../core/compaction.ts";
import { KB_BODY_MAX } from "../../core/kb-index.ts";
import {
  HYPOTHESES_RULE,
  hypothesisStatusWords,
  PAPER_ACCEPTED,
  questionLabel,
  REQUIRED_HYPOTHESES,
} from "../../core/research-check.ts";
import type { Role, Runner } from "../broker/index.ts";
import { countsText, type Knowledge } from "../knowledge.ts";
import type { HypothesisRow, LaneFileChange, Ledger } from "../ledger/index.ts";
import { cardFile, cardHistory } from "./cards.ts";
import { copyTree, LaneCopyRefused, regularFiles } from "./copy.ts";

/** The order hypotheses are listed in: those that need a verdict first (goal 117). */
const HYPOTHESIS_ORDER = ["author", "promoted", "pool", "merged", "retired"];

/** A text on one line, cut to n characters with an ellipsis. */
const clipWords = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The research paper's file in a research run's folder (goal 112). */
export const PAPER_FILE = "paper.md";
/** The paper's next experiments with their kinds (goal 119), beside paper.md. */
export const NEXT_EXPERIMENTS_FILE = "next-experiments.json";

/**
 * A research run's folder: everything the run has learned, as files a worker can search with
 * ordinary tools, and a working area for each lane.
 *
 *   INDEX.md, REPORT.md                 the harness writes them
 *   paper.md                            the research paper, once code accepted it (goal 112)
 *   cards/q<index>.md                   each question's answer card, with its versions (goal 117)
 *   sources/ claims/ findings/          from the harness's records, kept current as they change
 *   hypotheses/ notes/ report/
 *   lanes/LANE/                         each lane's files, as they were when its last trial ended
 *   work/LANE/                          the lane's working area: its own while its trial runs
 *   compactions/                        each agent conversation, as kept before a compaction
 *
 * The harness owns all of it but the working areas, so workers read everything and change only
 * their own area; the records stay the source of truth (the files are rebuilt from them). A
 * lane's files are saved in the harness's state when each trial ends (they survive a restart),
 * recorded in the ledger (who wrote what, and when), and shown to the other lanes under lanes/.
 */

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Where each lane's files are saved in the harness's state (stateDir/research-work/<run>/<lane>/):
 * they outlive scratch, and the teachers read them from here (run-research.ts).
 */
export const SAVED_LANES_DIR = "research-work";

/** A run's folder under the folders' root (scratch/research): its run id must be a safe name. */
export function folderRootOf(scratchRoot: string, run: string): string {
  if (!SAFE.test(run)) throw new Error(`not a run id for a folder: ${run}`);
  return join(scratchRoot, run);
}

/** A file's bytes, never through a symlink. */
export function readNoFollow(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** A file of a lane's saved area, in its manifest; `doc`: recorded as a document of the run. */
interface SavedFile {
  sha256: string;
  bytes: number;
  doc?: boolean | undefined;
}

/** The largest file a lane writes that is also kept as a document of the run (1 MiB). */
export const DOC_MAX_BYTES = 1024 * 1024;

/** A file's text when it is text (UTF-8, no NUL byte); undefined for any other file. */
function textOf(data: Buffer): string | undefined {
  if (data.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return undefined; // not UTF-8: a binary file, not a document
  }
}

/** A name safe as one path part: a section's name, say. */
const fileName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "") || "x";

/** A question's answer card in the folder, from its top: cards/q<index>.md (goal 117). */
export const cardPath = (index: number) => `cards/q${index}.md`;

/** A report section's file in the folder, from its top: report/<name>.md. */
export const sectionPath = (name: string) => `report/${fileName(name)}.md`;

const list = (json: unknown) => JSON.parse(String(json ?? "[]")) as string[];

export class ResearchFolder {
  private readonly ledger: Ledger;
  /** Under scratch: what workers see. */
  private readonly scratchRoot: string;
  /** Under the harness's state: each lane's saved files, which outlive scratch. */
  private readonly stateRoot: string;
  private readonly runner: Runner;
  /** Files already written for records that never change, per run. */
  private readonly written = new Map<string, Set<string>>();
  /** Contents last written for files that do change. */
  private readonly last = new Map<string, string>();

  /** Past research shown under knowledge/ (the harness keeps its own copy, knowledge.ts). */
  private readonly knowledge: Pick<Knowledge, "show" | "summary"> | undefined;

  constructor(o: {
    ledger: Ledger;
    scratchRoot: string;
    stateRoot: string;
    runner: Runner;
    knowledge?: Pick<Knowledge, "show" | "summary"> | undefined;
  }) {
    this.ledger = o.ledger;
    this.scratchRoot = o.scratchRoot;
    this.stateRoot = o.stateRoot;
    this.runner = o.runner;
    this.knowledge = o.knowledge;
  }

  root(run: string): string {
    return folderRootOf(this.scratchRoot, run);
  }

  private once(run: string, path: string, make: () => string | Buffer): void {
    const done = this.written.get(run) ?? new Set<string>();
    this.written.set(run, done);
    if (done.has(path)) return;
    if (!existsSync(path)) writeAtomic(path, make());
    done.add(path);
  }

  private changed(path: string, body: string): void {
    if (this.last.get(path) === body && existsSync(path)) return;
    writeAtomic(path, body);
    this.last.set(path, body);
  }

  /**
   * Brings the folder's harness-written part up to date with the records. A hill-climb or goal
   * run's folder holds what its trials recorded (sources, claims, notes) and past research; a
   * research run's holds everything above.
   */
  sync(run: string): string {
    const root = this.root(run);
    const inst = this.ledger.runs.get(run);
    if (!inst) throw new Error(`no run ${run}`);
    const research = inst.mode === "research";
    const contract = this.ledger.contracts.get(inst.campaign, inst.version) as {
      title?: string;
      topic?: string;
      questions?: string[];
      rubrics?: string[];
      quality?: { min_independent_sources?: number };
    };
    for (const d of research
      ? ["sources", "claims", "findings", "hypotheses", "notes", "report", "cards", "lanes", "work"]
      : ["sources", "claims", "notes"])
      mkdirSync(join(root, d), { recursive: true });
    this.showCompactions(run);
    // The campaign's brief from its author, whole (goal 078).
    const brief = briefFile(contract);
    if (brief) this.changed(join(root, BRIEF_FILE), brief);
    const briefLine = brief ? [`- ${BRIEF_FILE}: the campaign's brief from its author, whole`] : [];
    this.knowledge?.show(run);
    const knowledge = this.knowledge?.summary(run);
    const knowledgeLine = knowledge
      ? [
          `- knowledge/: past research from the collections this campaign may read (${countsText(knowledge.counts)}, from ${knowledge.collections.join(", ")}); README.md there says what is where`,
        ]
      : [];

    const sources = this.ledger.sources.list(run);
    const urlOf = new Map(sources.map((s) => [s.id, s.url]));
    for (const s of sources)
      this.once(run, join(root, "sources", `${s.id}.txt`), () => {
        let text = "";
        try {
          text = readFileSync(s.text_path, "utf8");
        } catch {
          text = "(the archived text is missing)";
        }
        return [
          `Source: ${s.id}`,
          `URL: ${s.url}`,
          ...(s.final_url && s.final_url !== s.url ? [`Final URL: ${s.final_url}`] : []),
          ...(s.title ? [`Title: ${s.title}`] : []),
          `Fetched: ${s.fetched_at} by ${s.fetched_by}`,
          "",
          "----- archived text (claims quote these words) -----",
          text,
        ].join("\n");
      });

    const questions = contract.questions ?? [];
    const claims = this.ledger.claims.list(run);
    for (const c of claims)
      this.once(run, join(root, "claims", `${c.id}.md`), () => {
        const quotes = JSON.parse(c.quotes) as {
          source: string;
          quote: string;
          resolved_from?: string;
        }[];
        const problems = list(c.problems);
        const q = c.question === null ? undefined : c.question;
        return [
          `# Claim ${c.id}: ${c.verified ? "verified" : "draft"}`,
          "",
          c.text,
          "",
          ...(q !== undefined
            ? [`${questionLabel(q)}: ${questions[q] ?? "(no such question)"}`]
            : []),
          ...(c.confidence !== null ? [`Confidence: ${c.confidence}`] : []),
          `Recorded: ${c.created_at} by ${c.lane ?? "research"}`,
          "",
          "## Quotes",
          "",
          ...quotes.flatMap((x) => [
            // A URL or file name the worker cited for an archived source: its id, and what was cited.
            `- ${x.source} (${urlOf.get(x.source) ?? "no such source"})${x.resolved_from ? `, cited as ${x.resolved_from}` : ""}:`,
            `  "${x.quote}"`,
          ]),
          ...(problems.length
            ? ["", "## Why it is a draft", "", ...problems.map((p) => `- ${p}`)]
            : []),
          "",
        ].join("\n");
      });

    const findings = this.ledger.claims.findings(run);
    for (const f of findings)
      this.once(run, join(root, "findings", `${f.id}.md`), () =>
        [
          `# Finding ${f.id}: ${f.supported ? "supported" : "draft"}`,
          "",
          f.text,
          "",
          "## Summary",
          "",
          f.summary,
          "",
          "## Why it matters",
          "",
          f.why_it_matters,
          "",
          "## Supporting claims",
          "",
          ...list(f.supporting).map((id) => `- ${id} (claims/${id}.md)`),
          ...(list(f.problems).length
            ? ["", "## Why it is a draft", "", ...list(f.problems).map((p) => `- ${p}`)]
            : []),
          "",
          `Recorded: ${f.created_at} by ${f.lane ?? "research"}`,
          "",
        ].join("\n"),
      );

    // The author's first, then promoted ones, the pool, merged and retired (goal 117); each file
    // follows its hypothesis's revisions.
    const rank = (s: string) => {
      const i = HYPOTHESIS_ORDER.indexOf(s);
      return i < 0 ? HYPOTHESIS_ORDER.length : i;
    };
    const hypotheses = this.ledger.hypotheses
      .list(run)
      .sort((a, b) => rank(a.status) - rank(b.status));
    const questionOf = (h: HypothesisRow) =>
      h.question === null
        ? "the whole run"
        : `${questionLabel(h.question)}: ${clipWords(questions[h.question] ?? "(no such question)", 300)}`;
    for (const h of hypotheses)
      this.changed(
        join(root, "hypotheses", `${h.id}.md`),
        [
          `# Hypothesis ${h.id}: ${hypothesisStatusWords(h.status, h.merged_into)}`,
          "",
          h.text,
          "",
          `About: ${questionOf(h)}`,
          `Supporting verified claims: ${list(h.supporting).join(", ") || "none"}`,
          `Recorded: ${h.created_at} by ${h.lane ?? "the campaign's author"}`,
          ...(h.updated_at && h.updated_at !== h.created_at ? [`Changed: ${h.updated_at}`] : []),
          "",
          HYPOTHESES_RULE,
          "",
        ].join("\n"),
      );

    const notes = this.ledger.claims.notes(run);
    for (const n of notes)
      this.once(run, join(root, "notes", `note-${String(n.id).padStart(5, "0")}.md`), () =>
        [
          `# Note ${n.id}`,
          "",
          n.text,
          "",
          `Sources: ${list(n.sources).join(", ") || "none"}`,
          `Recorded: ${n.created_at} by ${n.lane ?? "research"}`,
          "",
        ].join("\n"),
      );

    const verified = claims.filter((c) => c.verified).length;
    if (!research) {
      // A hill-climb or goal run: what its trials recorded, and past research.
      this.changed(
        join(root, "INDEX.md"),
        [
          `# ${contract.title ?? run}`,
          "",
          "This folder holds the sources, claims and notes this run's workers recorded, and past research from the collections its campaign may read. The harness writes it from its records and keeps it current. Every worker can read and search all of it, and change none of it.",
          "",
          "## What is here",
          "",
          `- sources/: ${sources.length} archived pages as text, one file each (claims quote these words)`,
          `- claims/: ${claims.length} claims, ${verified} verified and ${claims.length - verified} drafts (the first line says which)`,
          `- notes/: ${notes.length}`,
          ...briefLine,
          ...knowledgeLine,
          "",
        ].join("\n"),
      );
      return root;
    }

    // Each question's answer card (goal 117), whole, with its earlier versions: cards/q<index>.md.
    const claimText = new Map(claims.map((c) => [c.id, c.text]));
    const cardRows = questions.map((_, i) => cardHistory(this.ledger, run, i));
    const verifiedOf = (i: number) =>
      claims.filter((c) => c.verified && c.question !== null && c.question === i).length;
    for (const [i, history] of cardRows.entries())
      this.changed(
        join(root, cardPath(i)),
        cardFile({ questions, rubrics: contract.rubrics }, i, history, verifiedOf(i), (id) =>
          claimText.get(id),
        ),
      );

    const sections = this.ledger.reports.sections(run);
    for (const s of sections)
      this.changed(
        join(root, sectionPath(s.name)),
        `# ${s.name}\n\n${s.body}\n\nUpdated: ${s.updated_at} by ${s.updated_by}\n`,
      );

    const report = this.ledger.reports.newest(run);
    this.changed(
      join(root, "REPORT.md"),
      report
        ? `<!-- the ${report.kind} report of ${report.created_at}, written by the harness -->\n\n${report.body}\n`
        : "No report yet: the harness writes one at each digest and at the end.\n",
    );
    // The run's research paper, once code accepted it (goal 112): whole, with its references.
    const accepted = this.ledger.latestEventBody(PAPER_ACCEPTED, run);
    const paper = accepted?.paper;
    if (typeof paper === "string") this.changed(join(root, PAPER_FILE), paper);
    // Its next experiments, each tagged with the run it is for (goal 119), for the next campaign
    // to read: a hill climb's improvements and a goal campaign's goals.
    const next = Array.isArray(accepted?.experiments) ? accepted.experiments : [];
    if (typeof paper === "string")
      this.changed(
        join(root, NEXT_EXPERIMENTS_FILE),
        `${JSON.stringify({ run, experiments: next }, null, 2)}\n`,
      );
    const paperLine =
      typeof paper === "string"
        ? [
            `- ${PAPER_FILE}: the run's research paper, which leads its final report`,
            `- ${NEXT_EXPERIMENTS_FILE}: its next experiments, each with its kind (hill_climb or goal), measure and what it rests on`,
          ]
        : [];

    // The newest state of each file each lane wrote.
    const files = this.ledger.laneFiles.current(run, "path");
    this.changed(
      join(root, "INDEX.md"),
      [
        `# ${contract.title ?? run}`,
        "",
        ...(contract.topic ? [`Topic: ${contract.topic}`, ""] : []),
        "This folder holds what this research campaign has learned so far. The harness writes it from its records and keeps it current. Every worker can read all of it; each lane writes only in its own working area, work/LANE/.",
        "",
        "## Questions",
        "",
        "Numbered from 1; a claim's or a hypothesis's `question` field takes the index, from 0.",
        "",
        ...questions.map(
          (q, i) =>
            `- ${questionLabel(i)}: ${q.replace(/\n/g, "\n  ")} (${claims.filter((c) => c.verified && Number(c.question) === i).length} verified claims)`,
        ),
        "",
        "## What is here",
        "",
        "- REPORT.md: the newest report (a digest, or the final report)",
        ...paperLine,
        ...briefLine,
        `- sources/: ${sources.length} archived pages as text, one file each (claims quote these words)`,
        `- claims/: ${claims.length} claims, ${verified} verified and ${claims.length - verified} drafts (the first line says which)`,
        `- findings/: ${findings.length} findings (${findings.filter((f) => f.supported).length} supported)`,
        `- hypotheses/: ${hypotheses.length} (${hypotheses.filter((h) => REQUIRED_HYPOTHESES.some((s) => s === h.status)).length} that need a verdict, ${hypotheses.filter((h) => h.status === "pool").length} in the pool)`,
        `- notes/: ${notes.length}`,
        `- report/: ${sections.length} report sections`,
        `- cards/: one answer card for each question, whole with its earlier versions (cards/q0.md for question 1 (index 0), and so on); workers never edit them`,
        `- lanes/: the files each lane wrote, as they were when its last trial ended (${files.length} files)`,
        ...knowledgeLine,
        "",
        "## Answer cards",
        "",
        "The run's current answer to each question: the synthesizer writes each card from verified claims, and code checks it.",
        "",
        ...cardRows.map((history, i) => {
          const c = history.at(-1);
          return c
            ? `- ${questionLabel(i)}: ${cardPath(i)}, certainty ${c.certainty} (version ${c.version}), ${c.gaps.filter((g) => g.kind === "evidence").length} open evidence gaps`
            : `- ${questionLabel(i)}: ${cardPath(i)}, no card yet (${verifiedOf(i)} verified claims)`;
        }),
        "",
        "## Findings",
        "",
        ...(findings.length
          ? findings.map(
              (f) =>
                `- ${f.id} (${f.supported ? "supported" : "draft"}): ${f.text.replace(/\s+/g, " ").slice(0, 300)}`,
            )
          : ["None yet."]),
        "",
        "## Hypotheses",
        "",
        HYPOTHESES_RULE,
        "",
        ...(hypotheses.length
          ? hypotheses.map(
              (h) =>
                `- ${h.id} (${hypothesisStatusWords(h.status, h.merged_into)}; ${h.question === null ? "the whole run" : questionLabel(h.question)}): ${clipWords(h.text, 300)}`,
            )
          : ["None yet."]),
        "",
        "## Lanes' files",
        "",
        ...(files.length
          ? files.map((f) => `- lanes/${f.lane}/${f.path} (${f.bytes} bytes, ${f.recorded_at})`)
          : ["None yet."]),
        "",
      ].join("\n"),
    );
    return root;
  }

  private saved(run: string, lane: string): string {
    return join(this.stateRoot, run, lane);
  }

  /**
   * An agent's conversation before one of its compactions (goal 070): kept whole in the harness's
   * state, and shown under compactions/, where every agent of the run may read it and none may
   * change it. Returns its path as the agents see it.
   */
  keepCompaction(run: string, name: string, markdown: string): string {
    if (!SAFE.test(name)) throw new Error(`not a file name for a compaction: ${name}`);
    writeAtomic(join(this.stateRoot, run, COMPACTIONS_DIR, name), markdown);
    const shown = join(this.root(run), COMPACTIONS_DIR, name);
    writeAtomic(shown, markdown);
    return shown;
  }

  /** The folder the kept conversations are shown in, as the agents see it (made when one is kept). */
  compactionsDir(run: string): string {
    return join(this.root(run), COMPACTIONS_DIR);
  }

  /** A kept conversation's text (the harness's own copy), for its event. */
  readCompaction(run: string, name: string): string {
    if (!SAFE.test(name)) throw new Error(`not a file name for a compaction: ${name}`);
    return readFileSync(join(this.stateRoot, run, COMPACTIONS_DIR, name), "utf8");
  }

  /** The kept conversations under compactions/, where scratch lost them (after a restart). */
  private showCompactions(run: string): void {
    const kept = join(this.stateRoot, run, COMPACTIONS_DIR);
    if (!existsSync(kept)) return;
    for (const name of readdirSync(kept)) {
      const shown = join(this.root(run), COMPACTIONS_DIR, name);
      if (SAFE.test(name) && !existsSync(shown)) writeAtomic(shown, readNoFollow(join(kept, name)));
    }
  }

  /**
   * A lane's trial is about to start: the folder brought up to date, and its working area (its
   * saved files back after a restart) handed to the role the trial runs as.
   */
  async prepareLane(run: string, lane: string, role: Role): Promise<ResearchFolderPaths> {
    if (!/^lane-\d+$/.test(lane)) throw new Error(`not a lane: ${lane}`);
    const root = this.sync(run);
    this.showLanes(run);
    const work = join(root, "work", lane);
    if (!existsSync(work)) {
      const saved = this.saved(run, lane);
      if (existsSync(saved)) copyTree(saved, work);
      else mkdirSync(work, { recursive: true });
    }
    await this.runner.handOver(work, role);
    return { root, work };
  }

  /** Each lane's saved files under lanes/, where the scratch copy is missing (after a restart). */
  private showLanes(run: string): void {
    const base = join(this.stateRoot, run);
    if (!existsSync(base)) return;
    for (const lane of readdirSync(base)) {
      if (!/^lane-\d+$/.test(lane)) continue;
      const shown = join(this.root(run), "lanes", lane);
      if (!existsSync(shown)) copyTree(join(base, lane), shown);
    }
  }

  /**
   * A lane's trial has ended (its processes are gone): its working area is taken back, its files
   * saved and recorded (what changed since the last save), and shown to the other lanes. Each
   * text file it wrote (UTF-8, up to DOC_MAX_BYTES) is also a document of the run: one
   * `research_doc` event with its text, cut to an item's length, which the campaign's folder in
   * the knowledge base keeps; a document taken out of the area is said removed the same way.
   */
  async captureLane(
    run: string,
    lane: string,
    trial: string | null,
  ): Promise<{ written: number; removed: number }> {
    if (!/^lane-\d+$/.test(lane)) throw new Error(`not a lane: ${lane}`);
    const root = this.root(run);
    const work = join(root, "work", lane);
    if (!existsSync(work)) return { written: 0, removed: 0 };
    await this.runner.reclaim(work);
    const saved = this.saved(run, lane);
    const manifestPath = `${saved}.json`;
    const before = existsSync(manifestPath)
      ? (JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, SavedFile>)
      : {};
    const tmp = `${saved}.tmp-${randomUUID().slice(0, 8)}`;
    let now: Map<string, SavedFile>;
    try {
      now = copyTree(work, tmp);
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      if (!(err instanceof LaneCopyRefused)) throw err;
      throw new Error(
        `${lane}'s files are not saved: its working area holds ${err.message}. They stay in its working area for its next trials, until the rig restarts`,
      );
    }
    // The documents: text files, read from the saved copy (the lane can no longer change it).
    const docs = new Map<string, { text: string; clipped: boolean }>();
    for (const [rel, f] of now) {
      if (before[rel]?.sha256 === f.sha256) {
        if (before[rel]?.doc) f.doc = true;
        continue;
      }
      const text = f.bytes <= DOC_MAX_BYTES ? textOf(readNoFollow(join(tmp, rel))) : undefined;
      if (text === undefined) continue;
      f.doc = true;
      docs.set(rel, {
        text: text.length > KB_BODY_MAX ? `${text.slice(0, KB_BODY_MAX - 1)}…` : text,
        clipped: text.length > KB_BODY_MAX,
      });
    }
    const changes: LaneFileChange[] = [];
    let written = 0;
    let removed = 0;
    this.ledger.tx(() => {
      for (const [rel, f] of now) {
        if (before[rel]?.sha256 === f.sha256) continue;
        changes.push({ path: rel, change: "written", bytes: f.bytes, sha256: f.sha256 });
        written++;
        const doc = docs.get(rel);
        if (doc)
          this.ledger.appendEvent(lane, "research_doc", run, {
            lane,
            trial,
            path: rel,
            change: "written",
            bytes: f.bytes,
            sha256: f.sha256,
            text: doc.text,
            ...(doc.clipped ? { clipped: true } : {}),
          });
      }
      for (const [rel, f] of Object.entries(before)) {
        if (now.has(rel)) continue;
        changes.push({ path: rel, change: "removed", bytes: null, sha256: null });
        removed++;
        if (f.doc)
          this.ledger.appendEvent(lane, "research_doc", run, {
            lane,
            trial,
            path: rel,
            change: "removed",
          });
      }
      this.ledger.laneFiles.record(run, lane, trial, changes);
      if (written || removed)
        this.ledger.appendEvent(lane, "research_files_saved", run, {
          trial,
          written,
          removed,
          files: now.size,
        });
    });
    rmSync(saved, { recursive: true, force: true });
    renameSync(tmp, saved);
    writeAtomic(manifestPath, JSON.stringify(Object.fromEntries(now)));
    // What the other lanes see.
    const shown = join(root, "lanes", lane);
    const shownTmp = `${shown}.tmp-${randomUUID().slice(0, 8)}`;
    copyTree(saved, shownTmp);
    rmSync(shown, { recursive: true, force: true });
    renameSync(shownTmp, shown);
    this.sync(run);
    return { written, removed };
  }

  /**
   * The folder for an export, without the working areas and without past research (knowledge/
   * holds other runs' records, which their own exports carry): rebuilt from the records and the
   * saved files when scratch was cleared. Relative paths of its regular files.
   */
  exportFiles(run: string): { root: string; files: string[] } {
    const root = this.sync(run);
    this.showLanes(run);
    return {
      root,
      files: regularFiles(
        root,
        (rel) => rel === "work" || rel === "knowledge" || /\.tmp-[0-9a-f]{8}$/.test(rel),
      ),
    };
  }
}
