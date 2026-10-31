import { existsSync } from "node:fs";
import { join } from "node:path";

/** OpenCode's binary: THERMITE_OPENCODE_BIN, else `opencode` on the PATH (read when used). */
export const opencodeBin = () => process.env.THERMITE_OPENCODE_BIN ?? "opencode";

/** What to say when the image has no OpenCode: an image other than the published ones. */
export const NO_OPENCODE =
  "this rig's harness image has no OpenCode binary: use a harness image that has it, as the published images do, or give the rig another harness on Edit rig";

/** Why OpenCode exited, in words. A missing program says so, rather than the shell's note. */
export function opencodeExitWords(code: number | string | null, note: string): string {
  if (
    (code === 126 || code === 127) &&
    /opencode: (No such file or directory|not found)/.test(note)
  )
    return NO_OPENCODE;
  return `OpenCode exited ${code}: ${note}`;
}

/** OpenCode's executable as an absolute path (found on PATH), or undefined if it is not there. */
export function opencodeExe(): string | undefined {
  const bin = opencodeBin();
  if (bin.startsWith("/")) return bin;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = join(dir, bin);
    if (dir && existsSync(p)) return p;
  }
  return undefined;
}
