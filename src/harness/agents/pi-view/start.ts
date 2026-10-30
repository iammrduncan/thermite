import { PI_VIEW_DONE, PI_VIEW_END, PI_VIEW_NEXT } from "../../../core/api/harness/console.ts";
import { DEFAULT_COLS, DEFAULT_ROWS } from "../../terminal/index.ts";
import type { McpForAgent, ProviderWait, TrialResult, TrialView } from "../worker/index.ts";
import { ViewInputs } from "./inputs.ts";
import { PiView } from "./view.ts";

/**
 * A worker's process in its Pi view (goal 169): worker-main.ts with VIEW_FLAG, which the terminal
 * host runs on a terminal of its own, as the lane's agent user. Its output is the view, so its
 * result goes to VIEW_RESULT in its folder instead, which the harness reads as it reads a
 * headless worker's last line: as data, through the result's schema.
 */

/** The flag on the worker's command line that draws its Pi view. */
export const VIEW_FLAG = "--view";
/** The file in the worker's folder that holds its result. */
export const VIEW_RESULT = "result.json";
/** A pause before the last screen is kept, for the terminal host to read what was drawn last. */
const SETTLE_MS = 200;

/** A worker's Pi view, as its process runs it. */
export interface ViewRun {
  /** What the trial's loop takes: the console's levers, and the owner's interrupt. */
  trial: TrialView;
  /** A wait for the provider, drawn. */
  waiting(w: ProviderWait): void;
  /** The trial's end, drawn; then the harness keeps the screen, and the view stops. */
  finish(r: TrialResult): Promise<void>;
}

/** The trial's end, in the view's words. */
export function endWords(r: TrialResult): string {
  if (r.submitted) return `submitted ${r.submitted.attempt} (${r.submitted.lifecycle})`;
  return `${r.stopped.replace("_", " ")}${r.error ? `: ${r.error.slice(0, 200)}` : ""}`;
}

export function startView(o: {
  /** The view's first line: what it is a view of. */
  heading: string;
  /** A call to the harness API with the trial's token. */
  call(method: string, path: string, body?: unknown): Promise<unknown>;
  /** The MCP servers the run's kit gives its workers, by name. */
  servers: readonly string[];
  /** The servers' tools listed again, from the servers. */
  relist(fresh: true | string): Promise<McpForAgent>;
}): ViewRun {
  // The terminal is the view's. The worker's log lines, which would go there too, are dropped:
  // headless, the broker keeps only the worker's last line, its result, and so does nobody here.
  const out = process.stdout.write.bind(process.stdout);
  const mute = (() => true) as typeof process.stdout.write;
  process.stdout.write = mute;
  process.stderr.write = mute;
  const view = new PiView({
    out: (data) => {
      out(data);
    },
    cols: process.stdout.columns || DEFAULT_COLS,
    rows: process.stdout.rows || DEFAULT_ROWS,
    heading: o.heading,
    logDir: process.cwd(),
  });
  view.start();
  const inputs = new ViewInputs({
    view,
    ask: async (waitMs) =>
      PI_VIEW_NEXT.answer.parse(
        await o.call(PI_VIEW_NEXT.method, PI_VIEW_NEXT.path, { wait_ms: waitMs }),
      ).input,
    answer: (id, outcome, why) =>
      o.call(PI_VIEW_DONE.method, PI_VIEW_DONE.path, {
        id,
        outcome,
        ...(why ? { why: why.slice(0, 2000) } : {}),
      }),
    servers: o.servers,
    relist: o.relist,
  });
  return {
    trial: inputs,
    waiting: (w) => view.waiting(w),
    finish: async (r) => {
      inputs.close();
      view.finish(endWords(r));
      view.flush();
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      // The harness keeps the last screen now, while it shows the trial's end.
      await o.call(PI_VIEW_END.method, PI_VIEW_END.path, {}).catch(() => undefined);
      view.stop();
    },
  };
}
