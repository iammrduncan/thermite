import type { CliCompacted, KeptAt } from "../agents/compaction/index.ts";
import { errorText } from "../common/errors.ts";
import { scrubSecrets } from "../common/scrub.ts";
import type { Harness } from "../core/agents.ts";
import { COMPACTIONS_DIR, compactionFile } from "../core/compaction.ts";
import type { KbItemFile } from "../core/kb.ts";
import type { LiveLog } from "../core/live.ts";
import type { Ledger } from "./ledger/index.ts";

/**
 * The harness's record of each compaction (goal 070), whichever harness the agent runs in. The
 * conversation before it is scrubbed (common/scrub.ts: the values the harness gave agents, and
 * anything shaped like a key, a token or a password), then kept in the run's research folder
 * (compactions/), where every agent of the run may read it and none may change it, and where the
 * run keeps it: the harness's state holds it whole, it is exported with the run's folder, and it
 * is a document of the run's records in the knowledge base, whole, as its item's file (goal 175).
 * Each compaction is one `context_compacted` event and lines in the live view, with the summary
 * when there is one.
 */

/** Whose conversation: a trial's (its lane's), or the planner's (no trial). */
export interface CompactionOf {
  run: string;
  lane: string;
  trial: string | null;
  /** The file names' stem: the trial's id, or the planner's call. */
  who: string;
  /** The live view's source: `trial:<id>` or `planner`. */
  source: string;
}

/** A trial's conversation: its own file names and live source. */
export const compactionOf = (t: { id: string; run: string; lane: string }): CompactionOf => ({
  run: t.run,
  lane: t.lane,
  trial: t.id,
  who: t.id,
  source: `trial:${t.id}`,
});

/** How the conversation was compacted: Pi's summary or its fallback, or the harness's own. */
export type CompactionHow = "summary" | "trimmed" | "harness";

export interface CompactionRecord {
  number: number;
  /** Tokens before and after; null when the harness does not say. */
  tokensBefore: number | null;
  tokensAfter: number | null;
  how: CompactionHow;
  harness: Harness;
  summary?: string | undefined;
  error?: string | undefined;
  /** Whether the conversation was kept (by `keep`, under the same number). */
  kept: boolean;
}

const HARNESS: Record<Harness, string> = {
  pi: "The harness",
  opencode: "OpenCode",
  codex: "Codex",
  "claude-code": "Claude Code",
};

/** The largest conversation kept (characters): far more than any model's window holds. */
export const KEPT_MAX = 16 * 1024 * 1024;

const words = (n: number) => n.toLocaleString("en-US");

export class Compactions {
  private readonly ledger: Ledger;
  private readonly live: LiveLog;
  private readonly folder: {
    keepCompaction(run: string, name: string, markdown: string): string;
    readCompaction(run: string, name: string): string;
    /** The folder the kept conversations go in, as the agents see it. */
    compactionsDir(run: string): string;
    /** A file kept in the outbox for the knowledge base, by its SHA-256. */
    kbFile(bytes: Uint8Array, name: string, type: string): KbItemFile;
  };

  /** Told of each compaction recorded: the harness's watch of its trials (goal 143). */
  private readonly recorded: ((of: CompactionOf) => void) | undefined;

  constructor(o: {
    ledger: Ledger;
    live: LiveLog;
    folder: Compactions["folder"];
    recorded?: (of: CompactionOf) => void;
  }) {
    this.ledger = o.ledger;
    this.live = o.live;
    this.folder = o.folder;
    this.recorded = o.recorded;
  }

  /** The kept file's path in the run's folder, for compaction `n`. */
  rel(of: CompactionOf, n: number): string {
    return `${COMPACTIONS_DIR}/${compactionFile(of.who, n)}`;
  }

  /**
   * Where the conversation is kept before each compaction, as the agent sees it: for OpenCode's,
   * Codex's and Claude Code's own summaries to name it, set before the agent starts. `readable`:
   * the agent has tools to read it (a worker does).
   */
  keptAt(of: CompactionOf, readable: boolean): KeptAt {
    return { dir: this.folder.compactionsDir(of.run), stem: of.who, readable };
  }

  /**
   * Keeps the conversation before compaction `n`, scrubbed first: every copy of it, here, in the
   * run's export and in the knowledge base, is the scrubbed one. Returns its path as the agents
   * see it, and in the run's folder.
   */
  keep(of: CompactionOf, n: number, markdown: string): { path: string; rel: string } {
    if (!Number.isInteger(n) || n < 1)
      throw new Error("a compaction's number is a whole number from 1");
    const kept =
      markdown.length > KEPT_MAX
        ? `${markdown.slice(0, KEPT_MAX)}\n\n[Cut here: the conversation had ${words(markdown.length)} characters.]\n`
        : markdown;
    const text = scrubSecrets(kept);
    const path = this.folder.keepCompaction(of.run, compactionFile(of.who, n), text);
    return { path, rel: this.rel(of, n) };
  }

  /** Records compaction `n`: its event, and its lines in the live view with the summary. */
  record(of: CompactionOf, r: CompactionRecord): void {
    const rel = this.rel(of, r.number);
    let text: string | undefined;
    let error = r.error;
    if (r.kept) {
      try {
        text = this.folder.readCompaction(of.run, compactionFile(of.who, r.number));
      } catch (err) {
        // Said in the event and the live view: the compaction stands either way.
        error = [error, `the kept conversation could not be read: ${String(err)}`]
          .filter(Boolean)
          .join("; ");
      }
    }
    const summary = r.summary?.trim() ? scrubSecrets(r.summary.trim()) : undefined;
    // The conversation whole, for the run's records in the knowledge base: kept in the outbox by
    // its SHA-256, which the supervisor puts on the message bus (goal 175).
    const file =
      text !== undefined
        ? this.folder.kbFile(
            new TextEncoder().encode(text),
            compactionFile(of.who, r.number),
            "text/markdown",
          )
        : undefined;
    this.ledger.appendEvent("harness", "context_compacted", of.run, {
      trial: of.trial,
      lane: of.lane,
      harness: r.harness,
      number: r.number,
      tokens_before: r.tokensBefore,
      tokens_after: r.tokensAfter,
      how: r.how,
      snapshot: text !== undefined ? rel : null,
      ...(text !== undefined && file ? { bytes: file.bytes, file } : {}),
      summary: summary ? summary.slice(0, 4000) : null,
      error: error ? error.slice(0, 500) : null,
    });
    this.recorded?.(of);
    const tokens =
      r.tokensBefore !== null
        ? ` at about ${words(r.tokensBefore)} tokens${r.tokensAfter !== null ? `, down to about ${words(r.tokensAfter)}` : ""}`
        : "";
    const how =
      r.how === "trimmed"
        ? " The summary failed, so the bodies of older tool results were left out."
        : "";
    const where =
      text !== undefined
        ? ` The conversation before it is kept in the run's research folder, ${rel}.`
        : " The conversation before it was not kept.";
    this.say(
      of,
      `${HARNESS[r.harness]} compacted the conversation (compaction ${r.number})${tokens}. The ${of.trial ? "trial" : "planner"} goes on.${how}${where}${error ? ` (${error.slice(0, 300)})` : ""}`,
    );
    if (summary) this.say(of, `The summary after compaction ${r.number}:\n\n${summary}`);
  }

  /**
   * A compaction OpenCode, Codex or Claude Code made on its own and reported: the conversation
   * before it is kept (the program's own, which its hook, plugin or rollout gave, else the
   * trial's live entries until then), and the compaction recorded, with the summary the program
   * went on from when Thermite could read it.
   */
  fromHarness(
    of: CompactionOf,
    harness: Exclude<Harness, "pi">,
    c: Pick<CliCompacted, "number" | "tokensBefore" | "tokensAfter" | "markdown" | "summary">,
  ): void {
    let kept = false;
    let error: string | undefined;
    try {
      this.keep(of, c.number, c.markdown);
      kept = true;
    } catch (err) {
      error = `the conversation was not kept: ${errorText(err)}`;
    }
    this.record(of, {
      number: c.number,
      tokensBefore: c.tokensBefore,
      tokensAfter: c.tokensAfter,
      how: "harness",
      harness,
      summary: c.summary,
      kept,
      error,
    });
  }

  private say(of: CompactionOf, text: string): void {
    this.live.append({
      source: of.source,
      kind: "status",
      text: text.length > 7900 ? `${text.slice(0, 7899)}…` : text,
      lane: of.trial ? of.lane : undefined,
      run: of.run,
    });
  }
}
