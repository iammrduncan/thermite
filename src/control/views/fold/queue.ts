import { taskFields } from "../research.ts";
import type { ExperimentView, RunView, StoredEvent } from "../types.ts";
import type { Handler, Handlers } from "./index.ts";

/** The experiment queue (goal 064): what to try, in order, and what became of each. */

/**
 * One queue event on a run's view (goal 064). The queued experiments keep their order in
 * `position` (0 first); an experiment leaves the order when it is assigned, done or dropped.
 */
function queueEvent(v: RunView, e: StoredEvent): void {
  const b = (e.body ?? {}) as Record<string, unknown>;
  const id = String(b.id ?? "");
  if (!id) return;
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : undefined);
  let x = v.queue.find((q) => q.id === id);
  const order = () =>
    v.queue
      .filter((q) => q.state === "queued")
      .sort((a, z) => (a.position ?? 0) - (z.position ?? 0));
  const place = (it: ExperimentView, pos: unknown) => {
    const rest = order().filter((q) => q !== it);
    const at =
      pos === "top"
        ? 0
        : typeof pos === "number" && Number.isFinite(pos)
          ? Math.max(0, Math.min(rest.length, Math.trunc(pos)))
          : rest.length;
    rest.splice(at, 0, it);
    rest.forEach((q, i) => {
      q.position = i;
    });
  };
  const leave = (it: ExperimentView) => {
    it.position = null;
    order()
      .filter((q) => q !== it)
      .forEach((q, i) => {
        q.position = i;
      });
  };
  if (e.kind === "experiment_added") {
    if (x) return;
    x = {
      id,
      title: str("title") ?? id,
      details: str("details") ?? "",
      family: str("family") ?? "",
      why: str("why") ?? "",
      by: str("by") ?? e.actor,
      state: b.state === "proposed" ? "proposed" : "queued",
      position: null,
      lane: str("lane") ?? null,
      trial: null,
      attempt: null,
      result: null,
      dropped_why: null,
      dropped_by: null,
      from_run: str("from_run") ?? null,
      cause: null,
      returns: 0,
      question: null,
      yield: null,
      at: e.at,
      updated_at: e.at,
    };
    taskFields(x, e);
    v.queue.push(x);
    if (x.state === "queued") place(x, b.position);
    return;
  }
  if (!x) return;
  x.updated_at = e.at;
  taskFields(x, e);
  switch (e.kind) {
    case "experiment_accepted":
      x.state = "queued";
      place(x, b.position);
      break;
    case "experiment_moved":
      if (x.state === "queued") place(x, b.position);
      break;
    case "experiment_edited":
      x.title = str("title") ?? x.title;
      x.details = str("details") ?? x.details;
      x.family = str("family") ?? x.family;
      x.why = str("why") ?? x.why;
      break;
    case "experiment_dropped":
      leave(x);
      x.state = "dropped";
      x.dropped_why = str("why") ?? null;
      x.dropped_by = str("by") ?? e.actor;
      break;
    case "experiment_assigned":
      leave(x);
      x.state = "assigned";
      x.lane = str("lane") ?? x.lane;
      x.trial = str("trial") ?? x.trial;
      break;
    case "experiment_finished":
      leave(x);
      x.state = "done";
      x.trial = str("trial") ?? x.trial;
      x.lane = str("lane") ?? x.lane;
      x.attempt = str("attempt") ?? null;
      x.result = str("result") ?? str("stopped") ?? null;
      x.cause = str("cause") ?? null;
      break;
    // Its trial never really tried it (goal 079): the same experiment, back at the top.
    case "experiment_returned":
      x.state = "queued";
      x.lane = null;
      x.trial = null;
      x.attempt = null;
      x.result = null;
      x.cause = str("cause") ?? null;
      x.returns = Number(b.returns) || x.returns + 1;
      place(x, b.position ?? "top");
      break;
  }
}

const experiment: Handler = (f, e) => queueEvent(f.run(String(e.subject)), e);

export const QUEUE: Handlers = {
  experiment_added: experiment,
  experiment_accepted: experiment,
  experiment_moved: experiment,
  experiment_edited: experiment,
  experiment_dropped: experiment,
  experiment_assigned: experiment,
  experiment_finished: experiment,
  experiment_returned: experiment,
};
