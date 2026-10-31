import type { KbKind } from "./kb.ts";
import { currentEvent } from "./names.ts";
import { hypothesisStatusWords, PAPER_ACCEPTED, questionLabel } from "./research-check.ts";

/**
 * How a run's events become the items of its records slot, in its campaign's collection in
 * Thermite's knowledge base (goals 065 and 175). One reading, shared: control builds the records
 * with it from the events in the rigs' signed reports, and a rig's harness builds each export's
 * part of the collection
 * (knowledge.jsonl) with it from its own ledger, so the two hold the same items.
 *
 * Every item keeps its origin: its run, who wrote it (a lane, the planner, an advisor, the judge,
 * the owner) and when. The items are agents' and judges' words and pages they read: data, never
 * instructions.
 */

type Row = Record<string, unknown>;

export const str = (v: unknown) =>
  typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The longest item text, in characters (a source's text and a document are cut to it). */
export const KB_BODY_MAX = 20_000;

/**
 * A text cut to `n` characters, with a line that says so: a cut is never silent (goal 162). The
 * line says how long the whole is, and that the run's research folder keeps it whole.
 */
export function cutSaid(text: string, n: number, what: string): string {
  if (text.length <= n) return text;
  const said = `\n\n(Cut: the ${what} has ${text.length} characters; the run's research folder keeps it whole.)`;
  return `${text.slice(0, Math.max(0, n - said.length))}${said}`;
}

/** What a change gives an item; a field left out keeps what the item had. */
export interface KbFields {
  title?: string | undefined;
  body?: string | undefined;
  by?: string | undefined;
  url?: string | null | undefined;
  sub?: string | null | undefined;
  meta?: Record<string, string> | undefined;
}

/** An item's stored fields (meta as JSON). */
export interface KbStored {
  title: string;
  body: string;
  by: string;
  url: string | null;
  sub: string | null;
  meta: string;
}

/** An item's fields after a change: what the change gives, else what the item had. */
export function mergeItem(ref: string, old: KbStored | undefined, f: KbFields): KbStored {
  const url = f.url !== undefined ? f.url : (old?.url ?? null);
  const sub = f.sub !== undefined ? f.sub : (old?.sub ?? null);
  return {
    title: clip(f.title ?? old?.title ?? "", 300) || ref,
    body: clip(f.body ?? old?.body ?? "", KB_BODY_MAX),
    by: clip(f.by ?? (old?.by || "harness"), 200),
    url: url && url.length <= 2000 ? url : null,
    sub: sub ? clip(sub, 40) : null,
    meta: f.meta ? JSON.stringify(f.meta) : old?.meta || "{}",
  };
}

/** Whether a change left an item as it was (it then keeps its place in every sync). */
export function sameItem(a: KbStored, b: KbStored): boolean {
  return (
    a.title === b.title &&
    a.body === b.body &&
    a.by === b.by &&
    a.url === b.url &&
    a.sub === b.sub &&
    a.meta === b.meta
  );
}

/** An item as the reading changes it: its text, and the fields its state is kept in. */
export interface KbHeld {
  body: string;
  meta: Record<string, string>;
}

/** An item's stored meta (JSON) as fields; anything else is none. */
export function metaOf(json: string | undefined): Record<string, string> {
  try {
    const m = JSON.parse(json ?? "{}") as unknown;
    return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Where the items of one reading go: control's store, or an export's. */
export interface KbIndexTarget {
  /** A run started: its campaign as its event names it (the target decides where to file it). */
  runCreated(run: string, named: string): void;
  /** An item, when the target has it. */
  item(run: string, kind: KbKind, ref: string): KbHeld | undefined;
  /** An attempt's item, found by its ref alone (a verdict names only its attempt). */
  attempt(ref: string): ({ run: string } & KbHeld) | undefined;
  /** A new item, or a change to one (the target merges it with mergeItem). */
  put(run: string, kind: KbKind, ref: string, f: KbFields, at: string): void;
}

/** One event of a run's ledger, as the reading takes it. */
export interface KbEvent {
  at: string;
  actor: string;
  kind: string;
  subject: string;
  body: Row;
}

/** The events that add an item or change one; every other event changes nothing. */
export const KB_EVENT_KINDS = [
  "run_created",
  "run_status",
  "champion_promoted",
  "champion_moved_back",
  "trial_started",
  "trial_finished",
  "journal_note",
  "research_note",
  "research_doc",
  "context_compacted",
  "experiment_added",
  "experiment_edited",
  "experiment_finished",
  "experiment_dropped",
  "attempt_recorded",
  "verdict",
  "source_fetched",
  "claim_added",
  "hypothesis_added",
  "hypothesis_revised",
  "hypothesis_merged",
  "hypothesis_status",
  "finding_added",
  "research_final",
  "research_digest",
  PAPER_ACCEPTED,
  "card_written",
  "item_decided",
] as const;

const lines = (xs: string[]) => xs.filter(Boolean).join("\n");

/** A text with its line that starts with `label: ` replaced (or added at the end). */
function setLine(body: string, label: string, line: string): string {
  const kept = body.split("\n").filter((l) => !l.startsWith(`${label}: `));
  return lines([...kept, line]).trim();
}

/** An experiment's text from its fields: the words it was given, then how it ended. */
function experimentBody(m: Record<string, string>): string {
  return lines([
    m.details ?? "",
    m.why ? `Why: ${m.why}` : "",
    m.family ? `Direction: ${m.family}` : "",
    m.about ? `About: ${m.about}` : "",
    m.result ?? "",
  ]);
}

/** An attempt's text from its fields: its hypothesis and claim, then the judge's verdict. */
function attemptBody(m: Record<string, string>): string {
  return lines([
    m.hypothesis ?? "",
    m.claim ? `Claim: ${m.claim}` : "",
    m.flaws ? `Declared flaws: ${m.flaws}` : "",
    m.refused ? `Refused before building: ${m.refused}` : "",
    m.verdict ? `Verdict: ${m.verdict}` : "",
  ]);
}

/** A research paper's next experiment's kind (goal 119), in words: the run it is for. */
const NEXT_FOR_WORDS = new Map([
  ["hill_climb", "a hill climb, an improvement to measure against its champion"],
  ["goal", "a goal campaign, an outcome to prove"],
]);

const MODE_WORD = new Map([
  ["hill_climb", "hill climb"],
  ["goal", "goal"],
  ["research", "research"],
]);

const n = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US") : str(v));

/**
 * The target with each item it puts given the lane and the trial its event names, as fields
 * (goal 176), beside the fields it had.
 */
function withOrigin(t: KbIndexTarget, b: Row): KbIndexTarget {
  const from = {
    ...(str(b.lane) ? { lane: str(b.lane) } : {}),
    ...(str(b.trial) ? { trial: str(b.trial) } : {}),
  };
  if (!Object.keys(from).length) return t;
  return {
    ...t,
    put: (run, kind, ref, f, at) =>
      t.put(
        run,
        kind,
        ref,
        { ...f, meta: { ...(f.meta ?? t.item(run, kind, ref)?.meta), ...from } },
        at,
      ),
  };
}

/** Reads one event into the items it adds or changes. */
export function indexEvent(target: KbIndexTarget, event: KbEvent): void {
  // Events written before the 2026-10-15 renames, read under their new names, for every caller.
  const e = currentEvent(event);
  const b = e.body;
  const t = withOrigin(target, b);
  const run = str(b.run) || e.subject;
  const ref = (x: unknown) => clip(str(x), 200);
  switch (e.kind) {
    // A run: its campaign, mode, seed and settings, then its status and its best so far.
    case "run_created": {
      t.runCreated(e.subject, str(b.campaign));
      const seed = b.seed && typeof b.seed === "object" ? (b.seed as Row) : {};
      const mode = MODE_WORD.get(str(b.mode)) ?? str(b.mode);
      const briefing = typeof b.briefing === "number" ? b.briefing : 0;
      t.put(
        e.subject,
        "run",
        ref(e.subject),
        {
          title: `Run ${e.subject}: ${[mode, str(b.campaign)].filter(Boolean).join(", ")}`,
          body: lines([
            `Campaign: ${str(b.campaign)}${b.version !== undefined && b.version !== null ? `, version ${str(b.version)}` : ""}`,
            mode ? `Mode: ${mode}` : "",
            str(seed.repo) || str(seed.commit)
              ? `Seed: ${str(seed.repo)}${str(seed.commit) ? ` at ${str(seed.commit).slice(0, 12)}` : ""}`
              : "",
            // The run's note (--note; the signed field keeps its old name, direction).
            str(b.direction) ? `Note: ${str(b.direction)}` : "",
            b.agents === false ? "Agents: none (a try: the judge only)" : "Agents: on",
            briefing
              ? `Briefing: ${briefing} item${briefing === 1 ? "" : "s"} from past research`
              : "",
          ]),
          by: e.actor,
        },
        e.at,
      );
      return;
    }
    case "run_status": {
      const old = t.item(e.subject, "run", ref(e.subject))?.body;
      if (old === undefined) return;
      t.put(
        e.subject,
        "run",
        ref(e.subject),
        {
          body: setLine(
            old,
            "Status",
            `Status: ${str(b.status)}${str(b.reason) ? ` (${str(b.reason)})` : ""}`,
          ),
        },
        e.at,
      );
      return;
    }
    case "champion_promoted": {
      const old = t.item(e.subject, "run", ref(e.subject))?.body;
      if (old === undefined) return;
      t.put(
        e.subject,
        "run",
        ref(e.subject),
        {
          body: setLine(
            old,
            "Best so far",
            `Best so far: attempt ${str(b.attempt)} (champion ${str(b.seq)})`,
          ),
        },
        e.at,
      );
      return;
    }
    // The owner withdrew evidence (goal 174), and the champion moved back.
    case "champion_moved_back": {
      const old = t.item(e.subject, "run", ref(e.subject))?.body;
      if (old === undefined) return;
      const best = str(b.attempt) ? `attempt ${str(b.attempt)}` : "the starting point";
      t.put(
        e.subject,
        "run",
        ref(e.subject),
        {
          body: setLine(
            old,
            "Best so far",
            `Best so far: ${best} (champion ${str(b.to)}; champion ${str(b.from)} was withdrawn: ${clip(str(b.reason), 300)})`,
          ),
        },
        e.at,
      );
      return;
    }
    // A trial: one agent session of a lane, from its start to how it ended.
    case "trial_started": {
      const what = str(b.focus) || (str(b.family) ? `the ${str(b.family)} direction` : "");
      t.put(
        e.subject,
        "trial",
        ref(b.trial),
        {
          title: `${str(b.lane) || "a lane"}${b.epoch !== undefined && b.epoch !== null ? `, round ${str(b.epoch)}` : ""}${what ? `: ${what}` : ""}`,
          body: lines([
            `Lane: ${str(b.lane)}`,
            b.epoch !== undefined && b.epoch !== null ? `Round: ${str(b.epoch)}` : "",
            str(b.family) ? `Direction: ${str(b.family)}` : "",
            str(b.focus) ? `Focus: ${str(b.focus)}` : "",
          ]),
          by: str(b.lane) || e.actor,
        },
        e.at,
      );
      return;
    }
    case "trial_finished": {
      const id = ref(b.trial);
      const had = t.item(e.subject, "trial", id)?.body;
      let body = setLine(
        had ?? `Lane: ${str(b.lane)}`,
        "Ended",
        `Ended: ${str(b.stopped).replace(/_/g, " ")}; ${n(b.turns)} turns; ${n(b.tokens_in)} tokens in, ${n(b.tokens_out)} out`,
      );
      if (str(b.attempt)) body = setLine(body, "Attempt", `Attempt: ${str(b.attempt)}`);
      if (Number(b.compactions) > 0)
        body = setLine(body, "Compactions", `Compactions: ${n(b.compactions)}`);
      if (str(b.error)) body = setLine(body, "Error", `Error: ${str(b.error)}`);
      t.put(
        e.subject,
        "trial",
        id,
        {
          // A trial whose start is not in the reading: named by its lane alone.
          ...(had === undefined
            ? { title: `${str(b.lane) || "a lane"}: a trial`, by: str(b.lane) || e.actor }
            : {}),
          body,
        },
        e.at,
      );
      return;
    }
    case "journal_note": {
      // A note always says what it is about; one recorded before that rule is about its run.
      const about =
        b.about && typeof b.about === "object" ? (b.about as Row) : { type: "run", id: run };
      t.put(
        run,
        "note",
        ref(b.id),
        {
          title: clip(str(b.text), 120),
          body: `${str(b.text)}\nAbout: ${str(about.type)} ${str(about.id)}`,
          by: str(b.by) || e.actor,
          url: b.source ? str((b.source as Row).url) || null : null,
          sub: str(b.kind) || "note",
          meta: { about_type: str(about.type), about_id: str(about.id) },
        },
        e.at,
      );
      return;
    }
    // A research note (goal 065: in any mode), apart from the field notes: its own ref.
    case "research_note": {
      const sources = Array.isArray(b.sources) ? b.sources.map(String) : [];
      t.put(
        run,
        "note",
        ref(`rn-${str(b.note)}`),
        {
          title: clip(str(b.text), 120),
          body: lines([str(b.text), sources.length ? `Sources: ${sources.join(", ")}` : ""]),
          by: str(b.by) || e.actor,
          url: str(b.url) || null,
          sub: "note",
        },
        e.at,
      );
      return;
    }
    // A document: a file a lane wrote in its working area of the run's research folder.
    case "research_doc": {
      const lane = str(b.lane);
      const id = ref(`${lane}/${str(b.path)}`);
      if (str(b.change) === "removed") {
        const old = t.item(run, "doc", id)?.body;
        if (old === undefined) return;
        t.put(
          run,
          "doc",
          id,
          {
            body: setLine(
              old,
              "Removed",
              `Removed: ${lane} took it out of its working area${str(b.trial) ? ` in trial ${str(b.trial)}` : ""}.`,
            ),
          },
          e.at,
        );
        return;
      }
      t.put(
        run,
        "doc",
        id,
        {
          title: str(b.path),
          body: lines([
            str(b.text),
            b.clipped === true ? `(Cut: the file has ${n(b.bytes)} bytes.)` : "",
          ]),
          by: lane || e.actor,
        },
        e.at,
      );
      return;
    }
    // An agent's conversation as the harness kept it before a compaction (goal 070): a document
    // of the run, as a lane's own files are. The run's research folder keeps it whole.
    case "context_compacted": {
      if (!str(b.snapshot) || !str(b.text)) return;
      const who = str(b.trial) ? `trial ${str(b.trial)}` : str(b.lane) || "an agent";
      t.put(
        run,
        "doc",
        ref(str(b.snapshot)),
        {
          title: `${who}: the conversation before compaction ${str(b.number)}`,
          // A long conversation's cut is said first: the item keeps only its beginning.
          body: lines([
            b.clipped === true
              ? `(Cut: the file has ${n(b.bytes)} bytes; the run's research folder keeps it whole, ${str(b.snapshot)}.)`
              : "",
            str(b.text),
          ]),
          by: str(b.lane) || e.actor,
        },
        e.at,
      );
      return;
    }
    case "experiment_added": {
      const meta = {
        details: str(b.details),
        why: str(b.why),
        family: str(b.family),
        // A research task's question (goal 117).
        ...(typeof b.question === "number" ? { about: questionLabel(b.question) } : {}),
      };
      t.put(
        run,
        "experiment",
        ref(b.id),
        { title: str(b.title), body: experimentBody(meta), by: str(b.by) || e.actor, meta },
        e.at,
      );
      return;
    }
    // New words for a waiting experiment: its item takes them, and keeps the rest (goal 162).
    case "experiment_edited": {
      const old = t.item(run, "experiment", ref(b.id));
      if (old === undefined) return;
      const meta = { ...old.meta };
      for (const k of ["details", "why", "family"] as const) if (k in b) meta[k] = str(b[k]);
      t.put(
        run,
        "experiment",
        ref(b.id),
        { ...("title" in b ? { title: str(b.title) } : {}), body: experimentBody(meta), meta },
        e.at,
      );
      return;
    }
    case "experiment_finished":
    case "experiment_dropped": {
      const old = t.item(run, "experiment", ref(b.id));
      if (old === undefined) return;
      // What a research task's trial added (goal 117), after its result.
      const y = b.yield && typeof b.yield === "object" ? (b.yield as Row) : undefined;
      const added = y
        ? `; it added ${n(y.verified_claims)} verified claims, ${n(y.new_domains)} new domains and ${n(y.findings)} findings`
        : "";
      // Its state is a field: the agents' own words are never read back as prose (goal 162).
      const meta = {
        ...old.meta,
        result:
          e.kind === "experiment_dropped"
            ? `Dropped: ${str(b.why)}`
            : `Result: ${str(b.attempt) ? `attempt ${str(b.attempt)}` : "no attempt"}${str(b.result) ? ` (${str(b.result)})` : ""}${added}`,
      };
      t.put(run, "experiment", ref(b.id), { body: experimentBody(meta), meta }, e.at);
      return;
    }
    case "attempt_recorded": {
      const meta = {
        hypothesis: str(b.hypothesis),
        claim: str(b.claim),
        flaws: Array.isArray(b.known_flaws) ? b.known_flaws.map(str).join("; ") : "",
        // Why the static checks refused it (goal 082), as its event bounds them.
        refused:
          Array.isArray(b.violations) && b.violations.length
            ? `${b.violations.map(str).join("; ")}${
                typeof b.violations_total === "number" && b.violations_total > b.violations.length
                  ? `; and ${b.violations_total - b.violations.length} more`
                  : ""
              }`
            : "",
      };
      t.put(
        run,
        "attempt",
        ref(e.subject || str(b.attempt)),
        {
          title: str(b.hypothesis) || e.subject,
          body: attemptBody(meta),
          by: str(b.lane) || e.actor,
          meta,
        },
        e.at,
      );
      return;
    }
    case "verdict": {
      // A verdict names its attempt (the subject); the attempt's item says which run it is in.
      const old = t.attempt(ref(e.subject));
      const verdict = str(b.verdict);
      if (old && verdict) {
        const delta =
          typeof b.delta === "number"
            ? ` (${b.delta >= 0 ? "+" : ""}${(b.delta * 100).toFixed(2)}%)`
            : "";
        // Withdrawn evidence (goal 174) says why.
        const why =
          verdict === "invalidated" && str(b.reasons)
            ? ` (withdrawn: ${clip(str(b.reasons), 300)})`
            : "";
        const meta = { ...old.meta, verdict: `${verdict}${delta}${why}` };
        t.put(old.run, "attempt", ref(e.subject), { body: attemptBody(meta), meta }, e.at);
      }
      return;
    }
    // A source: its address, then the text that was read (the archived page as text, cut).
    case "source_fetched":
      t.put(
        run,
        "source",
        ref(b.source),
        {
          title: str(b.title) || str(b.url) || str(b.domain) || str(b.source),
          body: lines([str(b.url), str(b.domain), str(b.text) ? `\n${str(b.text)}` : ""]),
          by: e.actor,
          url: str(b.url) || null,
        },
        e.at,
      );
      return;
    case "claim_added":
      t.put(
        run,
        "claim",
        ref(b.claim),
        {
          title: str(b.text) || str(b.quote) || `claim ${str(b.claim)}`,
          body: lines([
            str(b.text),
            str(b.quote) ? `“${str(b.quote)}”` : "",
            b.verified === true ? "Verified against its source." : "A draft: not verified yet.",
            // Numbered from 1 for reading, with the index the records keep (goal 117).
            typeof b.question === "number" ? questionLabel(b.question) : "",
          ]),
          by: e.actor,
          sub: b.verified === true ? "verified" : "draft",
        },
        e.at,
      );
      return;
    // A hypothesis: the author's or a research worker's proposed explanation, with the question
    // it is about, its status (goal 117) and the verified claims for it. A revision or a merge
    // gives its new state; who first wrote it stays its writer.
    case "hypothesis_added":
    case "hypothesis_revised":
    case "hypothesis_merged": {
      const supporting = Array.isArray(b.supporting) ? b.supporting.map(String) : [];
      const status = e.kind === "hypothesis_merged" ? "merged" : str(b.status);
      t.put(
        run,
        "hypothesis",
        ref(b.hypothesis),
        {
          title: clip(str(b.text), 300) || `hypothesis ${str(b.hypothesis)}`,
          body: lines([
            str(b.text),
            typeof b.question === "number" ? questionLabel(b.question) : "",
            status ? `Status: ${hypothesisStatusWords(status, str(b.into) || null)}` : "",
            supporting.length
              ? `Supporting claims: ${supporting.join(", ")}`
              : "No verified claim supports it yet.",
            e.kind === "hypothesis_added" ? "" : `Changed by ${str(b.lane) || e.actor}.`,
          ]),
          ...(e.kind === "hypothesis_added" ? { by: str(b.lane) || e.actor } : {}),
        },
        e.at,
      );
      return;
    }
    // A hypothesis promoted, returned to the pool or retired (goal 117), by the owner or the
    // planner, with why: its item's status changes; one not in the reading yet is added.
    case "hypothesis_status": {
      const id = ref(b.hypothesis);
      const status = `Status: ${hypothesisStatusWords(str(b.status))}`;
      const why = `Status set by ${str(b.by) || e.actor}: ${str(b.reason)}`;
      const old = t.item(run, "hypothesis", id)?.body;
      t.put(
        run,
        "hypothesis",
        id,
        old === undefined
          ? {
              title: clip(str(b.text), 300) || `hypothesis ${str(b.hypothesis)}`,
              body: lines([
                str(b.text),
                typeof b.question === "number" ? questionLabel(b.question) : "",
                status,
                why,
              ]),
              by: e.actor,
            }
          : { body: setLine(setLine(old, "Status", status), "Status set by", why) },
        e.at,
      );
      return;
    }
    case "finding_added":
      t.put(
        run,
        "finding",
        ref(b.finding),
        {
          title: str(b.statement) || str(b.text) || `finding ${str(b.finding)}`,
          body: lines([
            str(b.statement),
            str(b.summary),
            str(b.why) ? `Why it matters: ${str(b.why)}` : "",
            `${str(b.claims)} supporting claims${b.supported === false ? " (not all verified)" : ""}`,
          ]),
          by: e.actor,
        },
        e.at,
      );
      return;
    // A research run's paper (goal 112): each next experiment its final writer gave, as an
    // experiment of the campaign's collection, which a goal or hill-climb run can take into its queue.
    // Its details say what it rests on, in words: a run that takes it cannot read this run.
    case PAPER_ACCEPTED: {
      // The paper itself, an item of its own (the owner, goal 162).
      if (str(b.paper))
        t.put(
          run,
          "report",
          "paper",
          {
            title: "Research paper",
            body: cutSaid(str(b.paper), KB_BODY_MAX, "paper"),
            by: `writer:${str(b.writer) || "final writer"}`,
          },
          e.at,
        );
      const xs = Array.isArray(b.experiments) ? b.experiments : [];
      for (const x of xs) {
        if (!x || typeof x !== "object" || !str((x as Row).id)) continue;
        const y = x as Row;
        const rests = Array.isArray(y.rests_on) ? y.rests_on.map(str).filter(Boolean) : [];
        // Its kind (goal 119): the run it is for, a hill climb or a goal campaign, and its measure.
        const kind = str(y.kind);
        const forWords = NEXT_FOR_WORDS.get(kind) ?? "";
        const details = lines([
          str(y.details),
          rests.length
            ? `It rests on, from the research paper of run ${run}:\n${rests.map((r) => `- ${r}`).join("\n")}`
            : "",
        ]);
        t.put(
          run,
          "experiment",
          ref(y.id),
          {
            title: str(y.title) || `experiment ${str(y.id)}`,
            body: lines([
              forWords ? `For: ${forWords}.` : "",
              str(y.measure)
                ? `${kind === "goal" ? "Reached when" : "Measure"}: ${str(y.measure)}`
                : "",
              details,
              str(y.why) ? `Why: ${str(y.why)}` : "",
            ]),
            by: `writer:${str(b.writer) || "final writer"}`,
            ...(forWords
              ? { sub: kind === "goal" ? "for a goal campaign" : "for a hill climb" }
              : {}),
            meta: {
              details,
              why: str(y.why),
              family: "",
              ...(forWords ? { next_for: kind, measure: str(y.measure) } : {}),
            },
          },
          e.at,
        );
      }
      return;
    }
    case "research_final":
    case "research_digest":
      if (str(b.report))
        t.put(
          run,
          "report",
          e.kind === "research_final" ? "final" : "digest",
          {
            title: e.kind === "research_final" ? "Final report" : "Latest digest",
            body: cutSaid(str(b.report), KB_BODY_MAX, "report"),
            by: "research",
          },
          e.at,
        );
      return;
    // Each answer card and the review panel's decisions are items of their own, as the paper is
    // (the owner, goal 162), so a later run reads them whole, not at the end of a cut report.
    case "card_written":
      if (typeof b.question === "number" && str(b.answer))
        t.put(
          run,
          "report",
          `card-q${b.question}`,
          {
            title: `Answer card: ${questionLabel(b.question)}, version ${str(b.version)}`,
            body: cutSaid(
              lines([
                str(b.answer),
                `Certainty: ${str(b.certainty)}`,
                `Claims cited: ${n(b.claims)}; gaps: ${n(b.gaps)}`,
              ]),
              KB_BODY_MAX,
              "answer card",
            ),
            by: str(b.by) || e.actor,
          },
          e.at,
        );
      return;
    case "item_decided": {
      const about =
        str(b.kind) === "question" && /^\d+$/.test(str(b.key))
          ? questionLabel(Number(b.key))
          : `${str(b.kind)} ${str(b.key)}`;
      const dissent = Array.isArray(b.dissent) ? b.dissent.length : 0;
      t.put(
        run,
        "report",
        `decision-${str(b.kind)}-${str(b.key)}`,
        {
          title: `The review panel on ${about}: ${str(b.decision)}`,
          body: lines([
            `Decision: ${str(b.decision)}${str(b.certainty) ? `, ${str(b.certainty)} certainty` : ""}`,
            b.card_version !== undefined && b.card_version !== null
              ? `On answer card version ${str(b.card_version)}`
              : "",
            dissent ? `Dissent: ${dissent} reviewer${dissent === 1 ? "" : "s"}` : "",
            `Review: ${str(b.review)}`,
          ]),
          by: "review_panel",
        },
        e.at,
      );
      return;
    }
  }
}
