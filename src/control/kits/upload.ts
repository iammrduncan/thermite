import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip, inflateRaw } from "node:zlib";
import { errorText } from "../../common/errors.ts";
import { type Kit, KitSchema } from "../../core/kit.ts";
import type { McpUse } from "../../core/mcp.ts";

const gunzipped = promisify(gunzip);
const inflated = promisify(inflateRaw);

/**
 * A kit uploaded on the new-campaign page: a .tar.gz, .tgz, .tar or .zip with kit.json at its
 * top (or inside one top folder). Control reads the archive in memory, never writing it out: it
 * refuses links, devices and any path that would leave the kit, within limits on the archive, on
 * what it unpacks to and on its files; it checks kit.json as the harness does, and keeps the
 * files for the campaign it starts: they become a kit repository control serves, like a kit
 * described on the page.
 */

/** The largest archive the page takes, in bytes. */
export const KIT_ARCHIVE_MAX = 64 * 1024 * 1024;
/** The most an archive unpacks to, in bytes: what control holds in memory while it checks it. */
const UNPACKED_MAX = 256 * 1024 * 1024;
/** The most files a kit holds, and entries (files, folders and the rest) an archive holds. */
const MAX_FILES = 2000;
const MAX_ENTRIES = 4 * MAX_FILES;

/**
 * What macOS adds to an archive made on a Mac, which is not part of the kit: `tar` puts a file's
 * extended attributes in a `._name` file beside it, the Finder's zip puts them under
 * `__MACOSX/`, and the Finder leaves `.DS_Store` files. They are left out.
 */
const macMetadata = (name: string) =>
  name.startsWith("._") || name === "__MACOSX" || name === ".DS_Store";

export interface UploadedKit {
  /** The archive's sha256: how the page refers to it afterwards. */
  id: string;
  kit: Kit;
  /** Path in the kit → content. */
  files: Record<string, Buffer>;
}

/** What the page shows about an uploaded kit, to choose its cases and score. */
export function kitSummary(k: Kit): {
  name: string;
  target: string;
  cells: string[];
  /** Each metric: how the judge works it out, and in words. */
  metrics: Record<string, { kind: "rate" | "time" | "check"; about: string }>;
  verifiers: string[];
  /** The MCP servers its kit.json names (goal 068), with the agents that get each. */
  mcp_servers: McpUse[];
} {
  return {
    name: k.name,
    target: k.target,
    cells: Object.keys(k.cells),
    metrics: Object.fromEntries(
      Object.entries(k.metrics).map(([n, m]) => [
        n,
        "work" in m
          ? { kind: "rate", about: `a rate (${m.unit})` }
          : m.from === "time"
            ? { kind: "time", about: "how long a run takes (s)" }
            : { kind: "check", about: `the check's ${m.field}${m.unit ? ` (${m.unit})` : ""}` },
      ]),
    ),
    verifiers: Object.keys(k.verifiers),
    mcp_servers: k.mcp_servers ?? [],
  };
}

/** Unpacks and checks an uploaded kit archive. Throws, in words, when it is not a usable kit. */
export async function unpackKit(filename: string, archive: Buffer): Promise<UploadedKit> {
  if (archive.length > KIT_ARCHIVE_MAX) throw new Error("the archive is larger than 64 MB");
  const lower = filename.toLowerCase();
  const zip = lower.endsWith(".zip");
  if (!zip && !/\.(tar\.gz|tgz|tar)$/.test(lower))
    throw new Error("upload a .tar.gz, .tgz, .tar or .zip");
  const id = createHash("sha256").update(archive).digest("hex");
  let entries: Entry[];
  try {
    entries = zip
      ? await zipEntries(archive)
      : tarEntries(
          lower.endsWith(".tar")
            ? archive
            : await gunzipped(archive, { maxOutputLength: UNPACKED_MAX }),
        );
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    const why =
      code === "ERR_BUFFER_TOO_LARGE"
        ? TOO_LARGE
        : typeof code === "string" && code.startsWith("Z_")
          ? "its compressed data is damaged"
          : errorText(err);
    throw new Error(`control could not unpack ${filename}: ${why}`);
  }
  // Each entry by its parts, "." ones dropped; what a Mac adds and .git left out.
  const kept: { path: string; body: Buffer | undefined }[] = [];
  let count = 0;
  for (const e of entries) {
    const parts = e.path.split("/").filter((x) => x !== "" && x !== ".");
    const path = parts.join("/");
    if (e.path.startsWith("/") || parts.includes(".."))
      throw new Error(`${e.path} leads out of the kit: a kit's files stay inside it`);
    if (!parts.length || parts.some(macMetadata) || parts.includes(".git")) continue;
    if (e.kind === "link") throw new Error(`${path} is a link: a kit holds only files`);
    if (e.kind === "other")
      throw new Error(`${path} is not a file or a folder: a kit holds only files`);
    if (e.kind === "file" && ++count > MAX_FILES)
      throw new Error(`the kit has more than ${MAX_FILES} files`);
    kept.push({ path, body: e.kind === "file" ? e.body : undefined });
  }
  // kit.json at the top, or inside one top folder.
  const isFile = (p: string) => kept.some((k) => k.path === p && k.body);
  let root = "";
  if (!isFile("kit.json")) {
    const top = [...new Set(kept.map((k) => k.path.split("/")[0]))];
    if (top.length === 1 && isFile(`${top[0]}/kit.json`)) root = `${top[0]}/`;
    else throw new Error("the archive has no kit.json at its top");
  }
  const files: Record<string, Buffer> = {};
  for (const k of kept)
    if (k.body && k.path.startsWith(root)) files[k.path.slice(root.length)] = k.body;
  let manifest: unknown;
  try {
    manifest = JSON.parse(String(files["kit.json"]));
  } catch {
    throw new Error("kit.json is not JSON");
  }
  const parsed = KitSchema.safeParse(manifest);
  if (!parsed.success)
    throw new Error(
      `kit.json: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  return { id, kit: parsed.data, files };
}

/** Why an archive that unpacks to more than UNPACKED_MAX is refused. */
const TOO_LARGE = `it unpacks to more than ${UNPACKED_MAX / 1024 / 1024} MiB`;

/** One entry of an archive: its path as the archive names it, its kind, and a file's bytes. */
interface Entry {
  path: string;
  kind: "file" | "dir" | "link" | "other";
  body?: Buffer | undefined;
}

/** A NUL-ended field of a tar header, as text. */
function field(b: Buffer, from: number, length: number): string {
  const f = b.subarray(from, from + length);
  const end = f.indexOf(0);
  return f.subarray(0, end < 0 ? length : end).toString("utf8");
}

/** A pax extended header's value for `key` (records of `<length> <key>=<value>\n`). */
function paxValue(body: Buffer, key: string): string | undefined {
  let value: string | undefined;
  for (let at = 0; at < body.length; ) {
    const space = body.indexOf(0x20, at);
    const length = space < 0 ? Number.NaN : Number(body.subarray(at, space).toString());
    if (!Number.isInteger(length) || length <= space - at) break;
    const record = body.subarray(space + 1, at + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (record.slice(0, eq) === key) value = record.slice(eq + 1);
    at += length;
  }
  return value;
}

/**
 * The entries of a tar (POSIX ustar, with pax headers and GNU long names), read from memory: each
 * header gives the entry's name, type and size, and its content follows in blocks of 512 bytes.
 */
function tarEntries(tar: Buffer): Entry[] {
  const out: Entry[] = [];
  let long: string | undefined;
  for (let at = 0; at + 512 <= tar.length; ) {
    const h = tar.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    if (out.length >= MAX_ENTRIES) throw new Error(`it has more than ${MAX_ENTRIES} entries`);
    const size = field(h, 124, 12).trim();
    if (!/^[0-7]*$/.test(size)) throw new Error("an entry's size is not one a tar of a kit has");
    const start = at + 512;
    const end = start + Number.parseInt(size || "0", 8);
    if (end > tar.length) throw new Error("it ends inside an entry");
    const body = tar.subarray(start, end);
    at = start + Math.ceil((end - start) / 512) * 512;
    const type = field(h, 156, 1) || "0";
    // A long name for the next entry: GNU's, or a pax header's path. Pax's other keys, and GNU's
    // long name for a link's target, change nothing control reads.
    if (type === "L" || type === "x") {
      long = type === "L" ? field(body, 0, body.length) : (paxValue(body, "path") ?? long);
      continue;
    }
    if (type === "g" || type === "K") continue;
    const prefix = field(h, 257, 5) === "ustar" ? field(h, 345, 155) : "";
    const name = field(h, 0, 100);
    const path = long ?? (prefix ? `${prefix}/${name}` : name);
    long = undefined;
    const kind =
      type === "0" || type === "7"
        ? "file"
        : type === "5"
          ? "dir"
          : type === "1" || type === "2"
            ? "link"
            : "other";
    out.push({ path, kind, ...(kind === "file" ? { body } : {}) });
  }
  return out;
}

/**
 * The entries of a zip, from its central directory, each file inflated within the size the
 * directory gives it. A zip64 archive, which no kit needs, and an encrypted entry are refused.
 */
async function zipEntries(zip: Buffer): Promise<Entry[]> {
  // The end of the central directory: the last record whose comment ends the file.
  let end = zip.length - 22;
  while (
    end >= Math.max(0, zip.length - 22 - 0xffff) &&
    !(zip.readUInt32LE(end) === 0x06054b50 && end + 22 + zip.readUInt16LE(end + 20) === zip.length)
  )
    end--;
  if (end < Math.max(0, zip.length - 22 - 0xffff)) throw new Error("it is not a zip archive");
  const count = zip.readUInt16LE(end + 10);
  const directory = zip.readUInt32LE(end + 16);
  if (count === 0xffff || directory === 0xffffffff) throw new Error("it is a zip64 archive");
  if (count > MAX_ENTRIES) throw new Error(`it has more than ${MAX_ENTRIES} entries`);
  const out: Entry[] = [];
  let unpacked = 0;
  for (let i = 0, at = directory; i < count; i++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== 0x02014b50)
      throw new Error("its central directory is damaged");
    const unix = zip.readUInt8(at + 5) === 3;
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const packedSize = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const mode = unix ? zip.readUInt32LE(at + 38) >>> 16 : 0;
    const local = zip.readUInt32LE(at + 42);
    const path = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    const type = mode & 0o170000;
    const kind =
      type === 0o120000
        ? "link"
        : path.endsWith("/") || type === 0o040000
          ? "dir"
          : type === 0 || type === 0o100000
            ? "file"
            : "other";
    if (kind !== "file") {
      out.push({ path, kind });
      continue;
    }
    if (flags & 1) throw new Error(`${path} is encrypted`);
    unpacked += size;
    if (unpacked > UNPACKED_MAX) throw new Error(TOO_LARGE);
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50)
      throw new Error(`${path} is damaged`);
    const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (data + packedSize > zip.length) throw new Error(`${path} is damaged`);
    const packed = zip.subarray(data, data + packedSize);
    if (method !== 0 && method !== 8)
      throw new Error(`${path} is packed in a way control can't read`);
    const body =
      method === 0
        ? packed
        : await inflated(packed, { maxOutputLength: Math.max(1, size) }).catch(() => undefined);
    if (body?.length !== size) throw new Error(`${path} is damaged`);
    out.push({ path, kind, body });
  }
  return out;
}
