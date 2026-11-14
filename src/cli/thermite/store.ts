import { spawnSync } from "node:child_process";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fail } from "./shared.ts";
import { USAGE } from "./usage.ts";

/**
 * thermite store copy (goal 268): control's store from SQLite to PostgreSQL. The copy is
 * control's own program, since it holds both stores' tables (control/copy-main.ts): this starts
 * it, as a process of its own, with the options it was given, and ends as it ends.
 */
export function thermiteStore(rest: string[]): never {
  const [what, ...args] = rest;
  if (what !== "copy") fail(USAGE);
  const here = fileURLToPath(import.meta.url);
  // Beside this file's part, as the source and the build both lay them out.
  const program = join(dirname(here), "..", "..", "control", `copy-main${extname(here)}`);
  const ran = spawnSync(process.execPath, [...process.execArgv, program, ...args], {
    stdio: "inherit",
  });
  if (ran.error) fail(`the copy could not start: ${ran.error.message}`);
  process.exit(ran.status ?? 1);
}
