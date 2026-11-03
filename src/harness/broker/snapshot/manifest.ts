import { z } from "zod";
import { errorText } from "../../../common/errors.ts";
import { type SnapshotKeys, unseal } from "../seal.ts";
import { readWhole } from "./files.ts";
import { AREA_NAMES } from "./layout.ts";

/** A snapshot's manifest: what it holds, and reading one from the snapshot folder. */

/** The most a manifest may hold. */
const MANIFEST_MAX_BYTES = 512 * 1024 * 1024;

const HEX64 = /^[0-9a-f]{64}$/;
const Entry = z
  .object({
    area: z.enum(AREA_NAMES),
    path: z.string(),
    type: z.enum(["dir", "file"]),
    mode: z.number().int().min(0).max(0o7777),
    /** The owner it had when it was taken: each part's own (only its files are taken). */
    uid: z.number().int().min(0),
    gid: z.number().int().min(0),
    mtime_ms: z.number().optional(),
    /** A file's size, its sealed file's name and its content's SHA-256. */
    size: z.number().int().min(0).optional(),
    sealed: z.string().regex(HEX64).optional(),
    sha256: z.string().regex(HEX64).optional(),
    ledger: z.literal(true).optional(),
  })
  .refine(
    (e) =>
      e.type === "dir"
        ? e.sealed === undefined
        : e.size !== undefined && e.sealed !== undefined && e.sha256 !== undefined,
    "a file names its size, its sealed file and its SHA-256; a folder none of them",
  );
export type SnapshotEntry = z.infer<typeof Entry>;
const Manifest = z.object({
  format: z.literal("thermite-state-snapshot"),
  version: z.literal(2),
  /** The rig it is of (THERMITE_RIG_ID), or null. A restore checks it. */
  rig: z.string().nullable(),
  /** One more than the snapshot before it: 1 for the first. */
  seq: z.number().int().min(1),
  taken_at: z.string(),
  reason: z.string(),
  entries: z.array(Entry),
});
export type SnapshotManifest = z.infer<typeof Manifest>;

type ManifestRead = { manifest: SnapshotManifest } | { why: string } | undefined;

/** A manifest in the working folder, opened and checked; nothing when it is not there. */
export function readManifest(name: string, keys: SnapshotKeys): ManifestRead {
  let sealed: Buffer | undefined;
  try {
    sealed = readWhole(name, MANIFEST_MAX_BYTES);
  } catch (err) {
    return { why: `its ${name}: ${errorText(err)}` };
  }
  if (!sealed) return undefined;
  let plain: Buffer;
  try {
    plain = unseal(keys.manifest, "manifest", sealed);
  } catch (err) {
    return { why: `its ${name}: ${errorText(err)}` };
  }
  try {
    const parsed = Manifest.safeParse(JSON.parse(plain.toString("utf8")));
    if (parsed.success) return { manifest: parsed.data };
  } catch {
    // not JSON
  }
  return { why: `its ${name} is not a snapshot's manifest` };
}
