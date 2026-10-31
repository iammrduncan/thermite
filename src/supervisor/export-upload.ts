import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { ApiError } from "../common/api/call.ts";
import { controlClient } from "../common/api/control.ts";
import {
  EXPORT_BEGIN,
  EXPORT_FILE,
  EXPORT_NAME,
  EXPORT_PIECE_MAX,
  FIGURE_EXPORTS_MAX,
} from "../core/api/control/rigs.ts";
import { verifyExport } from "./git-export.ts";

/**
 * Exports to control, for a rig with no results repository: each export the harness writes
 * leaves the rig as an upload to control, file by file, in pieces control can take back up where
 * they stopped. Control checks every file against the export's manifest and keeps the export only
 * once every file arrived with its SHA-256. Until then the export stays in the outbox.
 *
 * What goes is what a results repository would get: every file of the manifest, and the ledger
 * snapshot at most once a day (and always with a full export).
 */

export interface UploadState {
  /** Exports waiting to go to control, oldest first. */
  queue: string[];
  /** The newest exports control holds in full (FIGURE_EXPORTS_MAX at most: the figures show them). */
  uploaded: string[];
  lastUploadAt?: string | undefined;
  /** When the last ledger snapshot went. */
  lastLedgerAt?: string | undefined;
  lastError?: string | undefined;
}

export interface UploadConfig {
  rig: string;
  outboxDir: string;
  controlUrl: string;
  controlToken: string;
  fetchImpl?: typeof fetch | undefined;
  /** The ledger snapshot goes at most this often, except with a full export (default a day). */
  ledgerEveryMs?: number | undefined;
  /** Bytes per request (PIECE_BYTES by default). */
  chunkBytes?: number | undefined;
  now?: (() => Date) | undefined;
}

/** The bytes of a file one request carries: half of the most control takes (EXPORT_PIECE_MAX). */
const PIECE_BYTES = EXPORT_PIECE_MAX / 2;

/** An export's manifest, as the harness wrote it. */
type Manifest = z.input<typeof EXPORT_BEGIN.body>["manifest"];
/** What control has of a file, in its refusal of a piece sent at another place. */
const HaveOfFile = EXPORT_FILE.answer;

class UploadError extends Error {
  /** True: this export can never go (control refuses it); false: try again later. */
  readonly final: boolean;

  constructor(message: string, final: boolean) {
    super(message);
    this.final = final;
  }
}

/**
 * Control's answer to a call, or its refusal (409), which says what control has. Any other answer
 * is an UploadError: 400, control refuses the request itself, so sending it again would not help;
 * anything else (a file whose bytes arrived wrong, control restarting) is tried again, as is a
 * call that got no answer.
 */
async function answer<T>(
  what: string,
  call: Promise<T>,
): Promise<{ ok: true; answer: T } | { ok: false; refused: ApiError }> {
  try {
    return { ok: true, answer: await call };
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    // No answer came: why, in its own words, and tried again.
    if (err.status === undefined) throw new Error(err.words);
    if (err.code === "refused") return { ok: false, refused: err };
    const words = err.words.slice(0, 300);
    throw new UploadError(`${what}: control answered ${err.status}: ${words}`, err.status === 400);
  }
}

/** Sends one export; resolves when control holds all of it, saying whether the ledger went. */
async function uploadOne(cfg: UploadConfig, name: string, ledgerDue: boolean): Promise<boolean> {
  const control = controlClient({
    url: cfg.controlUrl,
    token: cfg.controlToken,
    rig: cfg.rig,
    fetchImpl: cfg.fetchImpl,
  });
  const dir = join(cfg.outboxDir, name);
  if (!existsSync(dir)) throw new UploadError(`export ${name} is no longer in the outbox`, true);
  const { problems, manifest } = verifyExport(dir);
  if (!manifest) throw new UploadError(`export ${name} refused: ${problems.join("; ")}`, true);
  // The manifest as the harness wrote it (verified above), with its rig and time.
  const raw = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
  const withLedger = ledgerDue || manifest.full === true;
  const rels = Object.keys(manifest.files).filter((rel) => rel !== "ledger.sqlite" || withLedger);
  const files = Object.fromEntries(rels.map((rel) => [rel, statSync(join(dir, rel)).size]));
  const begin = () =>
    answer(
      `export ${name}`,
      control.call(EXPORT_BEGIN, { params: { name }, body: { manifest: raw, files } }),
    );
  const started = await begin();
  // Control has another export of that name from the rig.
  if (!started.ok) throw new UploadError(`export ${name}: ${started.refused.words}`, true);
  let have = started.answer;
  const chunk = cfg.chunkBytes ?? PIECE_BYTES;
  for (const rel of rels) {
    if (have.done.includes(rel)) continue;
    const total = files[rel] as number;
    let offset = Math.min(have.received[rel] ?? 0, total);
    const fd = openSync(join(dir, rel), "r");
    try {
      // At least one request, so an empty file is checked and kept too.
      do {
        const n = Math.min(chunk, total - offset);
        const buf = Buffer.alloc(n);
        let read = 0;
        while (read < n) {
          const got = readSync(fd, buf, read, n - read, offset + read);
          if (got === 0) break;
          read += got;
        }
        if (read !== n)
          throw new UploadError(`export ${name}: ${rel} changed while it was sent`, false);
        const sent = await answer(
          `export ${name}, ${rel}`,
          control.call(EXPORT_FILE, {
            params: { name },
            query: { path: rel, offset },
            bytes: new Uint8Array(buf),
          }),
        );
        // 409: control has another amount of this file: go on from there.
        const body = sent.ok ? sent.answer : HaveOfFile.safeParse(sent.refused.answer).data;
        if (body === undefined)
          throw new UploadError(`export ${name}, ${rel}: control did not say what it has`, false);
        if (!sent.ok && body.received === offset)
          throw new UploadError(`export ${name}, ${rel}: ${sent.refused.words}`, false);
        offset = body.received;
        if (body.complete) have = { ...have, complete: true };
      } while (offset < total);
    } finally {
      closeSync(fd);
    }
  }
  if (!have.complete) {
    // Every file is sent: control's own answer says whether it holds them all.
    const now = await begin();
    if (!now.ok || !now.answer.complete)
      throw new UploadError(`export ${name}: control does not hold every file yet`, false);
  }
  return rels.includes("ledger.sqlite");
}

/**
 * One round: the queued exports go to control, oldest first. A failure that may pass (control
 * unreachable, a broken request) ends the round, and the export is tried again next round; one
 * control refuses for good is dropped from the queue, and stays in the outbox.
 */
export async function uploadExportsOnce(
  cfg: UploadConfig,
  state: UploadState,
): Promise<UploadState> {
  const now = cfg.now ?? (() => new Date());
  const next: UploadState = { ...state, queue: [...state.queue], uploaded: [...state.uploaded] };
  while (next.queue.length) {
    const name = next.queue[0] as string;
    if (!EXPORT_NAME.test(name)) {
      next.queue.shift();
      next.lastError = `export ${name.slice(0, 80)} not sent: not an export's name`;
      continue;
    }
    const due =
      !next.lastLedgerAt ||
      now().getTime() - Date.parse(next.lastLedgerAt) >= (cfg.ledgerEveryMs ?? 24 * 3_600_000);
    let ledger: boolean;
    try {
      ledger = await uploadOne(cfg, name, due);
    } catch (err) {
      const why = err instanceof Error ? err.message.slice(0, 600) : String(err);
      if (err instanceof UploadError && err.final) {
        // Control refuses it for good: it stays in the outbox, and the report says why.
        next.queue.shift();
        next.lastError = why;
        continue;
      }
      next.lastError = `upload failed: ${why}`;
      break;
    }
    next.queue.shift();
    next.uploaded = [...next.uploaded, name].slice(-FIGURE_EXPORTS_MAX);
    next.lastUploadAt = now().toISOString();
    if (ledger) next.lastLedgerAt = next.lastUploadAt;
    if (next.lastError?.startsWith("upload failed")) next.lastError = undefined;
  }
  return next;
}
