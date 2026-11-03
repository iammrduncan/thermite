import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import type { ControlStore } from "../store/index.ts";

/** Kept conversations one transaction looks at, at most: control's other work goes on between. */
const PAGE = 50;

/**
 * Gives each kept conversation control stored before the scrubbing its scrubbed new version
 * (store/kb/kept.ts), in the background as control starts, as the files' text is extracted: a page
 * at a time, each in a transaction of its own, with control's other work between. A second start
 * finds none left. Control's log says how many it looked at and scrubbed, never their text; a
 * failure is logged, and the next start goes on from the first. Resolves with how many it scrubbed.
 */
export async function scrubKeptConversations(store: ControlStore, page = PAGE): Promise<number> {
  let after = 0;
  let looked = 0;
  let scrubbed = 0;
  try {
    for (;;) {
      await new Promise((go) => setImmediate(go));
      const r = store.kb().scrubKept(after, page);
      looked += r.looked;
      scrubbed += r.scrubbed;
      if (r.looked < page) break;
      after = r.last;
    }
  } catch (err) {
    const why = errorText(err);
    log("control", "kept conversations not scrubbed", { looked, scrubbed, error: why }, "error");
    return scrubbed;
  }
  log("control", "kept conversations from before the scrubbing looked at", { looked, scrubbed });
  return scrubbed;
}
