import { isLegacyRule } from "../../../core/directions.ts";
import { frozen } from "../sharing.ts";
import type { Handler, Handlers } from "./index.ts";

/**
 * The rules of the plan in force (directives) and the run's registry of directions (goal 066):
 * set, converted, superseded and dropped, with the rules the planner made from the owner's
 * messages as part of its answer to them.
 */

/** Rules that no longer hold: superseded, dropped, or converted from old words (goal 066). */
const ended: Handler = (f, e, b) => {
  const v = f.run(String(e.subject));
  const ids = new Set(
    (Array.isArray(b.ids) ? b.ids : [b.id]).map((x) => Number(x)).filter(Number.isFinite),
  );
  v.directives = Math.max(0, v.directives - ids.size);
  v.rules = v.rules.filter((r) => !ids.has(r.id));
};

export const RULES: Handlers = {
  directive(f, e, b) {
    const v = f.run(String(e.subject));
    v.directives++;
    const body = (b.body as Record<string, unknown> | null) ?? {};
    v.rules.push(
      frozen({ id: Number(b.id), author: e.actor, at: e.at, body, legacy: isLegacyRule(body) }),
    );
    // A rule the planner made from one of the owner's messages: part of its answer. One
    // converted from the planner's old rule in words takes that rule's place in the answer.
    const from = v.messages.find((m) => m.id === body.from_message);
    const was = (body.converted_from as { rule?: unknown } | undefined)?.rule;
    const old = from?.rules.find((x) => x.id === Number(was));
    if (old) {
      old.id = Number(b.id);
      old.family = typeof body.family === "string" ? body.family : null;
    } else if (from)
      from.rules.push({
        id: Number(b.id),
        kind: String(body.kind ?? ""),
        family: typeof body.family === "string" ? body.family : null,
        rationale: String(body.rationale ?? ""),
        by: e.actor,
        at: e.at,
      });
  },
  // Rules a set named that the owner had removed: the harness left them out. One the planner
  // made from the owner's message is part of its answer to it.
  directives_left_out(f, e, b) {
    const v = f.run(String(e.subject));
    for (const x of Array.isArray(b.rules) ? b.rules : []) {
      const r = (x ?? {}) as Record<string, unknown>;
      const from = v.messages.find((m) => m.id === r.from_message);
      if (from)
        from.left_out.push({
          kind: String(r.kind ?? ""),
          family: typeof r.family === "string" ? r.family : null,
          at: e.at,
        });
    }
  },
  family_added(f, e, b) {
    const name = typeof b.family === "string" ? b.family : "";
    if (!name) return;
    const v = f.run(String(e.subject));
    if (v.families.some((x) => x.name === name)) return;
    v.families.push(
      frozen({
        name,
        description: typeof b.description === "string" ? b.description : "",
        by: e.actor,
        at: e.at,
        for_rules: Array.isArray(b.for_rules)
          ? b.for_rules.map(Number).filter(Number.isFinite)
          : [],
      }),
    );
  },
  directives_superseded: ended,
  directive_dropped: ended,
  // An old rule in words the planner converted (goal 066): its new rule took its place.
  directive_converted: ended,
};
