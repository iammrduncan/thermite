import { z } from "zod";
import type { Harness } from "../../core/agents.ts";
import {
  KB_RECORDS,
  KbAddress,
  type KbWriterRole,
  kbAddress,
  kbItemType,
  roleOfSlot,
  withdrawnWhy,
} from "../../core/kb.ts";
import { KB_IS_DATA, KB_READ_PAGE } from "../../core/link/kb.ts";
import type { UsageAgent } from "../../core/usage.ts";
import { HARNESS_NAMES } from "../rigs/index.ts";
import type { ControlStore } from "../store/index.ts";
import { type RigView, runCampaign } from "../views/index.ts";
import { hitOf, textPage } from "./asks.ts";
import type { KbItem } from "./index.ts";

/**
 * The owner's read of one item of the knowledge base (goals 175 and 176), the same on REST (`GET
 * /v1/kb/item`), MCP (`kb_read`), the command line (`thermite kb read`) and the Knowledge page's
 * reader: one version of it whole, with its writer (the slot's role and the agent program its
 * calls ran in), every version, the mark of withdrawn evidence, its links and the items that link
 * to it, its file's facts, and which running runs' agents can read it, and why. The owner reads
 * every collection, so links from and to every collection are given.
 */

/** A read's fields over REST and MCP. */
export const kbReadFields = {
  address: KbAddress.describe("The item's address, <campaign>/<run>/<slot>/<kind>:<id>"),
  version: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("One of its versions; left out: its newest"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      `Where its text starts, in characters: a hit's passage.from, or next_offset of the read before. A read gives ${KB_READ_PAGE.toLocaleString("en-US")} characters at most`,
    ),
};
export const KbReadQuery = z.strictObject(kbReadFields);
export type KbReadQuery = z.infer<typeof KbReadQuery>;

/** The agent whose model calls a role's slot holds the writes of, as model usage names it. */
const USAGE_AGENT: Record<KbWriterRole, UsageAgent> = {
  planner: "planner",
  worker: "workers",
  teacher: "teachers",
  "merged-by": "merged_by",
  auditor: "auditor",
  "review-panel": "review_panel",
  synthesizer: "synthesizer",
  "final-writer": "final_writer",
};

/** Who wrote an item: Thermite's code for the records slot, else its slot's role and program. */
function writerOf(store: ControlStore, x: KbItem) {
  if (x.slot === KB_RECORDS) return { role: null, program: null, words: "Thermite's code" };
  const role = roleOfSlot(x.slot) ?? null;
  const harness = role ? store.usage.programOf(x.rig, x.run, USAGE_AGENT[role]) : undefined;
  const program = harness ? (HARNESS_NAMES[harness as Harness] ?? harness) : null;
  return { role, program, words: [role ?? x.slot, program].filter(Boolean).join(" · ") };
}

/** Why a running run's agents can or can't read an item, in a few words. */
export type KbReaderWhy =
  | "its collection"
  | "its own run"
  | "started fresh"
  | "granted and included"
  | "grant not included"
  | "no grant";

/** A running run, and whether its agents' kb_search and kb_read reach an item. */
export interface KbReader {
  run: string;
  collection: string;
  rig: string;
  can: boolean;
  why: KbReaderWhy;
}

/**
 * Each running run (the rigs' views) and whether its agents can read the item: from the run's
 * scope as control works it out for their kb_search (store/kb/scope.ts), never from what the run
 * asks; with why, by run name.
 */
export function readersOf(store: ControlStore, vs: readonly RigView[], x: KbItem): KbReader[] {
  const kb = store.kb();
  const out: KbReader[] = [];
  for (const u of vs)
    for (const r of u.runs) {
      if (r.status !== "running") continue;
      const collection = kb.runCampaign(u.id, r.id) ?? runCampaign(r);
      const { scope, where } = kb.scopeWhere(collection, r.id);
      const can = where.some((w) => w.campaign === x.campaign && (!w.run || w.run === x.run));
      const why: KbReaderWhy =
        x.campaign === collection
          ? !scope.fresh
            ? "its collection"
            : x.run === r.id
              ? "its own run"
              : "started fresh"
          : kb.reads(collection).includes(x.campaign)
            ? can
              ? "granted and included"
              : "grant not included"
            : "no grant";
      out.push({ run: r.id, collection, rig: u.id, can, why });
    }
  return out.sort((a, b) => a.run.localeCompare(b.run, "en", { numeric: true }));
}

/** The owner's read of one item: one version whole, and what the reader shows beside it. */
export function ownerKbRead(store: ControlStore, vs: readonly RigView[], q: KbReadQuery) {
  const kb = store.kb();
  const x = kb.at(q.address);
  if (!x) return { error: `the knowledge base has no item ${q.address}` } as const;
  const versions = kb.versions(x.id);
  const v =
    q.version === undefined ? versions.at(-1) : versions.find((o) => o.version === q.version);
  if (!v)
    return {
      error: `${q.address} has versions 1 to ${versions.length}, not ${q.version}`,
    } as const;
  const { excerpt: _e, why: _w, passage: _p, file: _f, ...item } = hitOf(x);
  const titleAt = (address: string) => kb.at(address)?.title ?? null;
  return {
    note: KB_IS_DATA,
    item: {
      id: x.id,
      ...item,
      rig: x.rig,
      type: kbItemType({ slot: x.slot, file: v.file }),
      title: v.title,
      version: v.version,
      at: v.at,
      ...textPage(v.body, q.offset),
      versions: versions.length,
      history: [...versions].reverse().map((o) => ({
        version: o.version,
        title: o.title,
        by: o.by,
        at: o.at,
        file: o.file,
      })),
      writer: writerOf(store, x),
      withdrawn: withdrawnWhy(x.kind, x.meta),
      file: v.file && {
        ...v.file,
        held: kb.files.has(v.file.sha256),
        // Its text is searched once control holds text for it: what the words index reads.
        searched: x.body !== "",
        from: `${x.slot} wrote it in ${x.run}, on ${x.rig}`,
      },
      links: v.links.map((l) => ({ ...l, title: titleAt(l.to) })),
      linked_from: kb.linksTo(kbAddress(x)).map((l) => ({
        rel: l.rel,
        address: kbAddress(l.item),
        title: l.item.title,
      })),
      readers: readersOf(store, vs, x),
      result: kb.resultOf(x),
    },
  };
}
export type KbReadAnswer = Exclude<ReturnType<typeof ownerKbRead>, { error: string }>;
