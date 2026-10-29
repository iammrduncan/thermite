import { log } from "../common/env.ts";
import { briefingSeedOf } from "./kb/index.ts";
import type { ControlStore } from "./store/index.ts";

/**
 * A run's briefing from past research (assign_campaign.briefing, goal 065) carries the knowledge
 * base's own words, never the caller's: each item is looked up by where it says it came from and
 * takes that item's text. One control cannot find, or from a folder the run's campaign may not
 * read, is left out.
 */
export function briefingFromKb(store: ControlStore, payload: unknown): unknown {
  const p = payload as { briefing?: unknown; contract?: unknown };
  if (!p || typeof p !== "object" || !Array.isArray(p.briefing)) return payload;
  const campaign = (p.contract as { campaign?: unknown } | null | undefined)?.campaign;
  const kb = store.kb();
  const readable = new Set(typeof campaign === "string" ? kb.readable(campaign) : []);
  const briefing = p.briefing.flatMap((x: unknown) => {
    const f = (x as { from?: Record<string, unknown> } | null)?.from;
    const s = (k: string) => (typeof f?.[k] === "string" ? (f[k] as string) : "");
    const from = {
      campaign: s("campaign"),
      rig: s("rig") || undefined,
      run: s("run"),
      kind: s("kind"),
      ref: s("ref"),
    };
    const item = kb.byOrigin(from);
    const seed = item && readable.has(item.campaign) ? briefingSeedOf(item) : undefined;
    // Never left out without a word: control's log says which item, and why.
    if (!seed)
      log(
        "control",
        "a briefing item was left out",
        {
          ...from,
          why: item
            ? "a folder the run's campaign may not read"
            : "not found, or found on two rigs: name its rig",
        },
        "warn",
      );
    return seed ? [seed] : [];
  });
  const { briefing: _caller, ...rest } = p;
  return briefing.length ? { ...rest, briefing } : rest;
}
