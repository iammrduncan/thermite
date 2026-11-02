import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The command line's build in a checkout (`npx thermite` runs dist/) may be older than its source,
 * after a `git pull` with no `npm run build` since: it then checks against old rules, as a build
 * that still took a contract's `notes` once did (goal 180). Such a build runs the source instead,
 * and says so. The source itself, and an image's build, which has no source beside it, run as they
 * are.
 */

/** Whether any file under `dir` changed after `than` (milliseconds since 1970). */
function changedAfter(dir: string, than: number): boolean {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory() ? changedAfter(path, than) : statSync(path).mtimeMs > than) return true;
  }
  return false;
}

/** Runs the source when this build is older than it; whether it did. */
export async function sourceInstead(): Promise<boolean> {
  const here = fileURLToPath(import.meta.url);
  if (!here.endsWith(".js")) return false;
  // dist/cli/thermite/ in a checkout: the repository is three folders up.
  const root = join(dirname(here), "..", "..", "..");
  const source = join(root, "src", "cli", "thermite", "main.ts");
  if (!existsSync(source) || !changedAfter(join(root, "src"), statSync(here).mtimeMs)) return false;
  process.stderr.write(
    "thermite: this build is older than its source, so the source runs; npm run build makes the build current\n",
  );
  // Node strips the source's types itself, and says so once: that notice is not the command's.
  process.removeAllListeners("warning");
  process.on("warning", (w) => {
    if (w.name !== "ExperimentalWarning") process.stderr.write(`${w.name}: ${w.message}\n`);
  });
  await import(pathToFileURL(source).href);
  return true;
}
