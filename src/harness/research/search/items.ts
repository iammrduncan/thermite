import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResearchKind } from "../../../core/api/harness/research.ts";
import { FILE_BYTES_MAX } from "../../evidence.ts";
import type { Ledger } from "../../ledger/index.ts";
import { readNoFollow, sectionPath } from "../folder.ts";

/**
 * What the index of a run's own research holds (goal 175): every source with its archived text
 * whole, every claim with its quotes, hypothesis, finding and note, each report section the
 * workers wrote, and each lane's text file as the harness saved it. Each item has a key that
 * changes when its words change, so the index makes anew only what changed. Thermite's own words
 * about an item (its kind, its state, a source's address) are its context.
 */

/** One item of the index, as the ledger and the saved files give it now. */
export interface IndexEntry {
  kind: ResearchKind;
  /** Its id: a source's, a claim's, a note's number, or a file's path in the research folder. */
  ref: string;
  /** What changes when its words change. */
  key: string;
  at: string;
  title: string;
  /** verified or draft (a claim), supported or draft (a finding); null for the others. */
  state: string | null;
  context: string;
  /** Its text, read only when it is indexed anew; undefined while it can't be read (it is tried again). */
  text: () => string | undefined;
}

/** The most characters of an item's title. */
const TITLE_MAX = 300;
const title = (s: string) => (s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 1)}…` : s);
const keyOf = (...parts: unknown[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const quotesOf = (json: string): string[] => {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.map((q) => String((q as { quote?: unknown }).quote ?? "")) : [];
  } catch {
    return [];
  }
};

/** A small item's entry: its text is known, and is its key. */
function known(e: Omit<IndexEntry, "key" | "text" | "context">, text: string): IndexEntry {
  const context = [e.kind, e.state].filter(Boolean).join(" ");
  return { ...e, context, key: keyOf(e.title, e.state, text), text: () => text };
}

/** Every item of a run's own research now; `savedLanes` is where the lanes' files are saved. */
export function entriesOf(ledger: Ledger, savedLanes: string, run: string): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const s of ledger.sources.ofRun(run))
    out.push({
      kind: "source",
      ref: s.id,
      // A source's archived text never changes.
      key: s.sha256,
      at: s.fetched_at,
      title: title(s.title ?? s.url),
      state: null,
      context: `source ${s.url}`,
      text: () => {
        try {
          return readFileSync(s.text_path, "utf8");
        } catch {
          // The archived text is missing: its title and address are still searched.
          return "";
        }
      },
    });
  for (const c of ledger.claims.ofRun(run))
    out.push(
      known(
        {
          kind: "claim",
          ref: c.id,
          at: c.created_at,
          title: title(c.text),
          state: c.verified ? "verified" : "draft",
        },
        [c.text, ...quotesOf(c.quotes)].join("\n"),
      ),
    );
  for (const h of ledger.hypotheses.ofRun(run))
    out.push(
      known(
        { kind: "hypothesis", ref: h.id, at: h.created_at, title: title(h.text), state: null },
        h.text,
      ),
    );
  for (const f of ledger.claims.findingsOfRun(run))
    out.push(
      known(
        {
          kind: "finding",
          ref: f.id,
          at: f.created_at,
          title: title(f.text),
          state: f.supported ? "supported" : "draft",
        },
        `${f.text}\n${f.summary}\n${f.why_it_matters}`,
      ),
    );
  for (const n of ledger.claims.notes(run))
    out.push(
      known(
        { kind: "note", ref: String(n.id), at: n.created_at, title: title(n.text), state: null },
        n.text,
      ),
    );
  // The report itself is made of the claims and findings, which are searched as such.
  for (const s of ledger.reports.sections(run)) {
    const path = sectionPath(s.name);
    out.push(
      known({ kind: "file", ref: path, at: s.updated_at, title: path, state: null }, s.body),
    );
  }
  for (const f of ledger.laneFiles.current(run, "newest")) {
    if (f.bytes > FILE_BYTES_MAX) continue;
    const path = `lanes/${f.lane}/${f.path}`;
    out.push({
      kind: "file",
      ref: path,
      key: f.sha256,
      at: f.recorded_at,
      title: path,
      state: null,
      context: "file",
      text: () => {
        let data: Buffer;
        try {
          data = readNoFollow(join(savedLanes, run, f.lane, f.path));
        } catch {
          return undefined; // being saved again right now: indexed at the next search
        }
        // A binary file is found by its path alone.
        return data.subarray(0, 8000).includes(0) ? "" : data.toString("utf8");
      },
    });
  }
  return out;
}
