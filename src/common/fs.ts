import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Writes a file whole or not at all: to a temporary file beside it, renamed over it once written.
 * Its folder is made when missing. With `mode`, the file has that mode before it takes the name.
 */
export function writeAtomic(path: string, data: string | Buffer, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
  if (mode !== undefined) chmodSync(tmp, mode);
  renameSync(tmp, path);
}
