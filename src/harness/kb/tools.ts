import { extname } from "node:path";
import {
  argsRefusal,
  KB_FILE_TYPES,
  KB_TOOLS,
  type KbCall,
  type KbToolResult,
  KbWriteArgs,
  kbCall,
} from "../../agents/tools/index.ts";
import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import { KB_TEXT_MAX, type KbWrittenKind, kbWritesOf, kindsForSlot } from "../../core/kb.ts";
import type { Ledger } from "../ledger/index.ts";
import type { KbAsks } from "./asks.ts";
import { writeKbItem } from "./write.ts";

/**
 * The knowledge base's tools as the harness runs them for its agents (goal 175): kb_search and
 * kb_read go to control by way of the supervisor (asks.ts), and kb_write records the item in the
 * ledger, in the caller's own slot (write.ts). The caller is the trial or the call the harness
 * runs, or the advisor's call the supervisor runs: its slot comes from there, never from the
 * agent. Which kinds a slot may write is its run's contract's (core/kb.ts).
 */

/** Who calls: the run, and the caller's slot in it (worker-<lane>, planner, an advisor's role). */
export interface KbCaller {
  run: string;
  slot: string;
}

export class KbTools {
  private readonly o: {
    ledger: Ledger;
    outboxDir: string;
    contractFor: (run: string) => unknown;
    asks: KbAsks;
  };

  constructor(o: {
    ledger: Ledger;
    outboxDir: string;
    contractFor: (run: string) => unknown;
    asks: KbAsks;
  }) {
    this.o = o;
  }

  /** The kinds a caller may write in its run: its role's, as the run's contract says. */
  writes(run: string, slot: string): KbWrittenKind[] {
    let contract: unknown;
    try {
      contract = this.o.contractFor(run);
    } catch {
      // A run the harness does not hold writes nothing.
      return [];
    }
    return kindsForSlot(kbWritesOf(contract), slot);
  }

  /** The tools as one caller runs them, for kbAgentTools and kbServer. */
  callFor(c: KbCaller): KbCall {
    return kbCall({
      run: c.run,
      ask: (kind, ask) => this.o.asks.ask(kind, ask),
      write: async (args) => {
        try {
          return this.write(c, args);
        } catch (err) {
          log(
            "harness",
            "an item for the knowledge base refused",
            { run: c.run, slot: c.slot, error: errorText(err) },
            "warn",
          );
          return { text: `${KB_TOOLS.write} refused: ${errorText(err)}`, isError: true };
        }
      },
    });
  }

  /** One tool call of an agent; a refusal or a failure is said in words, never thrown. */
  call(c: KbCaller, tool: string, args: Record<string, unknown>): Promise<KbToolResult> {
    return this.callFor(c)(tool, args);
  }

  /**
   * kb_write: one item, or the next version of the caller's own, in the caller's slot, recorded
   * signed in the run's ledger; it reaches control with the run's next report.
   */
  write(c: KbCaller, args: Record<string, unknown>): KbToolResult {
    const kinds = this.writes(c.run, c.slot);
    if (!kinds.length)
      return {
        text: `the campaign lets ${c.slot} write nothing in the knowledge base`,
        isError: true,
      };
    const a = KbWriteArgs.safeParse(args);
    if (!a.success) return { text: argsRefusal(KB_TOOLS.write, a.error), isError: true };
    const w = a.data;
    if (!kinds.includes(w.kind))
      return {
        text: `the campaign lets ${c.slot} write ${kinds.join(", ")}: not a ${w.kind}`,
        isError: true,
      };
    if (!w.file_name && w.text.length > KB_TEXT_MAX)
      return {
        text: `the text has ${w.text.length.toLocaleString("en-US")} characters, more than an item's ${KB_TEXT_MAX.toLocaleString("en-US")}: give a file_name to keep it whole as a file`,
        isError: true,
      };
    const file = w.file_name
      ? {
          bytes: new TextEncoder().encode(w.text),
          name: w.file_name,
          type: KB_FILE_TYPES[extname(w.file_name).toLowerCase()] ?? "text/plain",
        }
      : undefined;
    const r = writeKbItem(this.o.ledger, this.o.outboxDir, {
      run: c.run,
      writer: c.slot,
      kind: w.kind,
      title: w.title,
      ...(file ? { file } : { text: w.text }),
      ...(w.of !== undefined ? { of: w.of } : {}),
      ...(w.links ? { links: w.links } : {}),
    });
    log("harness", "an item for the knowledge base kept", {
      run: c.run,
      slot: c.slot,
      address: r.address,
      version: r.version,
    });
    return {
      text: `kept: ${r.address}, item ${r.item}, version ${r.version}. It reaches the knowledge base with the run's next report; kb_search finds it after that.`,
    };
  }
}
