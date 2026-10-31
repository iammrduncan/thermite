import { PI_VIEW_DONE, PI_VIEW_END, PI_VIEW_NEXT } from "../../core/api/harness/console.ts";
import type { McpForAgent } from "../mcp/index.ts";
import { DEFAULT_COLS, DEFAULT_ROWS } from "../terminal/index.ts";
import { ViewInputs } from "./inputs.ts";
import type { RoleView, ViewWait } from "./levers.ts";
import { PiView } from "./view.ts";

/**
 * A process in its Pi view (goal 169), which the terminal host runs on a terminal of its own as
 * the role's user: a worker's (src/harness/agents/worker-main.ts with VIEW_FLAG), a planner's
 * (planner-main.ts) or an advisor's (src/supervisor/advisors/pi/main.ts). Its output is the view,
 * so it gives its answer over its call's routes or in a file, never on its output.
 */

/** The flag on a Pi process's command line that draws its Pi view. */
export const VIEW_FLAG = "--view";
/** A pause before the last screen is kept, for the terminal host to read what was drawn last. */
const SETTLE_MS = 200;

/** A Pi view, as its process runs it. */
export interface ViewRun {
  /** What the call's loop takes: the console's levers, and Esc. */
  inputs: RoleView;
  /** A wait for the provider, drawn. */
  waiting(w: ViewWait): void;
  /** Its end, in words, drawn; its caller keeps the screen, the view stops. */
  finish(words: string): Promise<void>;
}

export function startView(o: {
  /** The view's first line: what it is a view of. */
  heading: string;
  /** A call to its call's routes, with its trial's token or its call's credential. */
  call(method: string, path: string, body?: unknown): Promise<unknown>;
  /** The MCP servers the run's kit gives the role, by name. */
  servers: readonly string[];
  /** The servers' tools listed again, from the servers. */
  relist(fresh: true | string): Promise<McpForAgent>;
}): ViewRun {
  // The terminal is the view's. The process's log lines, which would go there too, are dropped:
  // its answer goes over its call's routes or into a file, never to its output.
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
    inputs,
    waiting: (w) => view.waiting(w),
    finish: async (words) => {
      inputs.close();
      view.finish(words);
      view.flush();
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      // Its caller keeps the last screen now, while it shows the call's end.
      await o.call(PI_VIEW_END.method, PI_VIEW_END.path, {}).catch(() => undefined);
      view.stop();
    },
  };
}
