import { basename } from "node:path";
import { itemPath } from "../../src/harness/knowledge.ts";

/** The file name an item of past research gets in a run's knowledge folder. */
export const kbFile = (rig: string, run: string, ref: string) =>
  basename(itemPath({ campaign: "c", kind: "note", rig, run, ref }));
