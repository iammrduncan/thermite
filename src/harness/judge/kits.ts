import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Kit, KitSchema } from "../../core/kit.ts";
import { exportTree } from "../git.ts";

/**
 * A kit's files at one commit, exported once into `<stateDir>/kits/<commit>` and kept there.
 * Each export goes through a folder of its own (goal 163): two judge cards that first need the
 * same kit at once each export it, and the first one in keeps its copy, which the other may
 * already be reading; the second drops its own. Returns the kit's folder.
 */
export async function exportKit(stateDir: string, mirror: string, commit: string): Promise<string> {
  const dir = join(stateDir, "kits", commit);
  if (existsSync(join(dir, "kit.json"))) return dir;
  const tmp = `${dir}.tmp-${randomUUID().slice(0, 8)}`;
  await exportTree(mirror, commit, tmp);
  if (existsSync(join(dir, "kit.json"))) {
    rmSync(tmp, { recursive: true, force: true });
    return dir;
  }
  // A folder without kit.json is an export cut short: replaced whole.
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  return dir;
}

/** The kit in a kit's folder, checked against the kit's schema (core/kit.ts). */
export function loadKit(dir: string): Kit {
  return KitSchema.parse(JSON.parse(readFileSync(join(dir, "kit.json"), "utf8")));
}

/** A kit command's arguments with their placeholders filled from `vars` (core/kit.ts lists them). */
export function expandArgv(argv: readonly string[], vars: Record<string, string>): string[] {
  return argv.map((a) =>
    a.replace(/\{([a-z_]+)(?::([^}]+))?\}/g, (whole, name: string, rest?: string) => {
      const v = vars[name];
      if (v === undefined) throw new Error(`unknown placeholder ${whole}`);
      return rest ? join(v, rest) : v;
    }),
  );
}
