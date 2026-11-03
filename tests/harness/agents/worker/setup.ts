/** What the tests of a worker's trial share: the lane tool's command. */

import { fileURLToPath } from "node:url";

/** The lane tool, run by Node from the source. */
export const laneTool = [
  process.execPath,
  "--experimental-strip-types",
  "--disable-warning=ExperimentalWarning",
  fileURLToPath(new URL("../../../../src/harness/agents/lanetool.ts", import.meta.url)),
];
