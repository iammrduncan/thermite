import { createReadStream, existsSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import type { ControlStore } from "../store/index.ts";
import type { KbFiles } from "./files.ts";

/**
 * A file of the knowledge base, as the owner downloads it (goal 176): over REST (`GET
 * /v1/kb/file`) and from the Knowledge page's reader. It is always an attachment, never shown in
 * the page's origin: an HTML, SVG or other active file is sent as plain bytes, and every answer
 * says not to guess its type and not to run anything (nosniff, and a sandboxed policy).
 */

/** Media types a browser treats as data and never runs: sent as they are. Any other: bytes. */
const PASSIVE_TYPES = new Set([
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/pdf",
  "application/json",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** The type a file is sent with: its own when passive, else application/octet-stream. */
export const safeFileType = (type: string): string =>
  PASSIVE_TYPES.has(type.toLowerCase()) ? type.toLowerCase() : "application/octet-stream";

/** A file's name as an attachment's: its own, kept to plain characters, and whole in UTF-8. */
export function attachmentOf(name: string): string {
  const plain = name.replace(/[^\w .()+,-]/g, "_").trim() || "file";
  return `attachment; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** What a download serves: the file on control's disk, its name, its type and its size. */
export interface KbDownload {
  path: string;
  name: string;
  type: string;
  bytes: number;
}

/**
 * The file one version of an item holds (its newest unless told), or why there is none to send:
 * 404 when there is no such item, version or file; 409 when control does not hold its bytes yet.
 */
export function kbFileOf(
  store: ControlStore,
  files: KbFiles | undefined,
  address: string,
  version?: number,
): KbDownload | { error: string; status: 404 | 409 } {
  const kb = store.kb();
  const x = kb.at(address);
  if (!x) return { error: `the knowledge base has no item ${address}`, status: 404 };
  const versions = kb.versions(x.id);
  const v = version === undefined ? versions.at(-1) : versions.find((o) => o.version === version);
  if (!v)
    return {
      error: `${address} has versions 1 to ${versions.length}, not ${version}`,
      status: 404,
    };
  if (!v.file) return { error: `${address} holds no file: it is a text`, status: 404 };
  const path = files?.path(v.file.sha256);
  if (!path || !kb.files.has(v.file.sha256) || !existsSync(path))
    return {
      error: `control does not hold ${v.file.name} yet: it comes when the rig's supervisor sends it`,
      status: 409,
    };
  return { path, name: v.file.name, type: v.file.type, bytes: statSync(path).size };
}

/** The answer that sends a file: an attachment, with a safe type, which no browser runs. */
export function kbFileResponse(f: KbDownload): Response {
  return new Response(Readable.toWeb(createReadStream(f.path)) as ReadableStream, {
    status: 200,
    headers: {
      "content-type": safeFileType(f.type),
      "content-disposition": attachmentOf(f.name),
      "content-length": String(f.bytes),
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "no-store",
    },
  });
}
