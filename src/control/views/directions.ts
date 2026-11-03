import { directionOf, RESEARCH_TASK_KINDS } from "../../core/directions.ts";
import { WON_VERDICTS } from "../../core/verdicts.ts";
import type { DirectionView, RunView } from "./types.ts";

/**
 * A run's directions (goal 066), as the harness counts them: each experiment's direction, each
 * direction its registry added, each direction an attempt or a trial had, the task kinds of a
 * research run, and each direction a rule in force names, which waits for the planner to design
 * it while nothing else has it. Sorted by name.
 */
export function runDirections(v: RunView): DirectionView[] {
  const out = new Map<string, DirectionView>();
  const at = (name: string | undefined, made = true): DirectionView | undefined => {
    if (!name) return undefined;
    let d = out.get(name);
    if (!d) {
      d = {
        name,
        description: null,
        tried: 0,
        wins: 0,
        queued: 0,
        lanes: [],
        rules: [],
        to_design: !made,
      };
      out.set(name, d);
    } else if (made) d.to_design = false;
    return d;
  };
  const won = (attempt: string | null) => {
    if (!attempt) return false;
    if (v.champion.some((c) => c.attempt === attempt && !c.reopened)) return true;
    const a = v.attempts.find((x) => x.id === attempt);
    return a?.lifecycle === "promoted" || WON_VERDICTS.includes(a?.verdict ?? "");
  };
  for (const f of v.registry) {
    const d = at(directionOf(f.name));
    if (d && f.description) d.description = f.description;
  }
  if (v.mode === "research") for (const k of RESEARCH_TASK_KINDS) at(k);
  for (const a of v.attempts) at(a.direction ? directionOf(a.direction) : undefined);
  for (const t of v.trials) at(t.direction ? directionOf(t.direction) : undefined);
  const busy = new Set<string>();
  for (const x of v.queue) {
    const d = at(x.direction ? directionOf(x.direction) : undefined);
    if (!d) continue;
    if (x.state === "queued") d.queued++;
    if (x.state === "done") {
      d.tried++;
      if (won(x.attempt)) d.wins++;
    }
    if (x.state === "assigned" && x.lane) {
      busy.add(x.lane);
      if (!d.lanes.includes(x.lane)) d.lanes.push(x.lane);
    }
  }
  // A lane at work on a trial without an experiment (before the queue) counts by its direction.
  for (const [lane, w] of Object.entries(v.at_work)) {
    if (busy.has(lane)) continue;
    const d = at(w.direction ? directionOf(w.direction) : undefined);
    if (d && !d.lanes.includes(lane)) d.lanes.push(lane);
  }
  for (const r of v.rules) {
    if (r.legacy || typeof r.body.direction !== "string") continue;
    at(r.body.direction, false)?.rules.push({ id: r.id, kind: String(r.body.kind ?? "") });
  }
  for (const d of out.values())
    d.lanes.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
