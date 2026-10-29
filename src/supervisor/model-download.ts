import { createHash, type Hash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gib } from "../common/disk.ts";
import { redact } from "../common/env.ts";
import { errorText } from "../common/errors.ts";
import {
  FIGURE_MODEL_FROM_MAX,
  FIGURE_MODEL_NAME_MAX,
  FIGURE_MODELS_MAX,
  FIGURE_RUN_MAX,
  FIGURE_TEXT_MAX,
} from "../core/api/control/rigs.ts";

/**
 * Model files by URL (an assignment's `model` imports with a source): the supervisor downloads
 * each one into the harness's inbox, hashing it as it streams, and lands it only with the SHA-256
 * the signed command names. A broken download is kept as `<file>.part` and resumed with an HTTP
 * range the next time. Progress is a figure in the supervisor's report to control and a line in
 * the live view.
 *
 * An optional Hugging Face token (gated models) is the supervisor's own: it goes in a header to
 * Hugging Face only, never to a host a redirect leads to, and never into a file, a line or a
 * report. The harness and its roles never see it: they get only the checked file.
 */

/** The hosts a Hugging Face token is sent to, over HTTPS only. */
export const HF_HOSTS: readonly string[] = ["huggingface.co", "hf.co"];

/** How a download stands. "refused": its SHA-256 did not match, and the file was deleted. */
export type DownloadState = "downloading" | "done" | "refused" | "failed";

export interface ModelProgress {
  name: string;
  /** Where it lands, relative to the inbox. */
  path: string;
  sha256: string;
  /** The source's host only: a URL's path and query can hold a signed token. */
  from: string;
  state: DownloadState;
  /** Bytes on disk so far, an earlier broken download's included. */
  bytes: number;
  /** The file's size, when the server says it. */
  total: number | null;
  /** Bytes taken over from an earlier, broken download of the same file. */
  resumed_from: number;
  started_at: string;
  updated_at: string;
  error?: string | undefined;
  /** The run whose assignment brought it. */
  run?: string | undefined;
}

const GB = 1e9;
/** A size in plain words: "16.1 GB", "512 MB". */
export function size(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${bytes} bytes`;
}

/**
 * The supervisor's model downloads: the newest few, for its report, and a live line when one
 * starts, at every tenth of it (or every 5 minutes when it is slower), and when it ends.
 */
export class ModelDownloads {
  private readonly items = new Map<string, ModelProgress>();
  private readonly lastLine = new Map<string, { at: number; tenth: number }>();
  private readonly live: (text: string, run?: string) => void;
  private readonly now: () => Date;
  private readonly keep: number;

  constructor(
    o: { live?: (text: string, run?: string) => void; now?: () => Date; keep?: number } = {},
  ) {
    this.live = o.live ?? (() => {});
    this.now = o.now ?? (() => new Date());
    this.keep = o.keep ?? FIGURE_MODELS_MAX;
  }

  /** The newest downloads first, for the supervisor's report (within what control takes). */
  list(): ModelProgress[] {
    return [...this.items.values()].reverse().map((p) => ({
      ...p,
      name: p.name.slice(0, FIGURE_MODEL_NAME_MAX),
      path: p.path.slice(0, FIGURE_TEXT_MAX),
      from: p.from.slice(0, FIGURE_MODEL_FROM_MAX),
      ...(p.run !== undefined ? { run: p.run.slice(0, FIGURE_RUN_MAX) } : {}),
    }));
  }

  /** A download begins: it shows in the report at once, before its first byte. */
  begin(p: Pick<ModelProgress, "name" | "path" | "sha256" | "from" | "run">): void {
    const at = this.now().toISOString();
    this.items.delete(p.path);
    this.items.set(p.path, {
      ...p,
      state: "downloading",
      bytes: 0,
      total: null,
      resumed_from: 0,
      started_at: at,
      updated_at: at,
    });
    while (this.items.size > this.keep) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
  }

  /** The server answered: the file's size and where the download starts. */
  started(path: string, o: { total: number | null; resumedFrom: number; via?: string }): void {
    const p = this.items.get(path);
    if (!p) return;
    p.total = o.total;
    p.bytes = o.resumedFrom;
    p.resumed_from = o.resumedFrom;
    if (o.via) p.from = `${p.from} (via ${o.via})`;
    p.updated_at = this.now().toISOString();
    this.lastLine.set(path, { at: Date.now(), tenth: tenth(p) });
    this.live(
      `Model ${p.name}: download started from ${p.from}${p.total !== null ? `, ${size(p.total)}` : ""}${p.resumed_from ? `, from the ${size(p.resumed_from)} an earlier download left` : ""}.`,
      p.run,
    );
  }

  progress(path: string, bytes: number): void {
    const p = this.items.get(path);
    if (!p) return;
    p.bytes = bytes;
    p.updated_at = this.now().toISOString();
    const last = this.lastLine.get(path) ?? { at: 0, tenth: 0 };
    const t = tenth(p);
    if (t > last.tenth || Date.now() - last.at >= 5 * 60_000) {
      this.lastLine.set(path, { at: Date.now(), tenth: t });
      this.live(
        `Model ${p.name}: ${size(bytes)}${p.total !== null ? ` of ${size(p.total)} (${Math.floor((100 * bytes) / Math.max(1, p.total))}%)` : ""} downloaded.`,
        p.run,
      );
    }
  }

  finish(path: string, state: Exclude<DownloadState, "downloading">, error?: string): void {
    const p = this.items.get(path);
    if (!p) return;
    p.state = state;
    p.updated_at = this.now().toISOString();
    if (error !== undefined) p.error = error.slice(0, 500);
    this.lastLine.delete(path);
    this.live(
      state === "done"
        ? `Model ${p.name}: ${size(p.bytes)} downloaded. Its SHA-256 matches the signed one.`
        : state === "refused"
          ? `Model ${p.name}: refused. ${p.error ?? ""} The file was deleted.`
          : `Model ${p.name}: the download stopped. ${p.error ?? ""}`,
      p.run,
    );
  }
}

/** Which tenth of the file is down (0 when the size is not known). */
function tenth(p: ModelProgress): number {
  return p.total ? Math.floor((10 * p.bytes) / p.total) : 0;
}

/** A model download that did not work: the reason is in the message. */
export class ModelDownloadError extends Error {}

/** A downloaded file whose SHA-256 is not the signed one (it was deleted). */
export class ModelRefused extends ModelDownloadError {}

/** A download that stopped at the rig's disk floor as it wrote (its part file was deleted). */
class FloorReached extends ModelDownloadError {}

/** How often a download looks at the free space again as it writes: after each MiB. */
const FLOOR_CHECK_BYTES = 1024 * 1024;

/** A URL for messages: its scheme, host and path, never its user, password or query. */
export function urlForMessages(raw: string): string {
  const u = URL.parse(raw);
  return u ? redact(`${u.protocol}//${u.host}${u.pathname}`).slice(0, 300) : "(not a URL)";
}

function isHuggingFace(u: URL): boolean {
  return u.protocol === "https:" && HF_HOSTS.includes(u.hostname.toLowerCase());
}

/**
 * GET with redirects followed here, so the token goes to Hugging Face's own address only. A
 * redirect to another host (Hugging Face's file servers are other hosts) gets no token, and a
 * redirect from HTTPS to plain HTTP is refused.
 */
async function getFollowing(
  f: typeof fetch,
  start: string,
  headers: Record<string, string>,
  hfToken: string | undefined,
): Promise<{ res: Response; url: URL }> {
  let url = new URL(start);
  for (let hop = 0; hop <= 10; hop++) {
    const h: Record<string, string> = { ...headers };
    if (hfToken && isHuggingFace(url)) h.authorization = `Bearer ${hfToken}`;
    const res = await f(url.toString(), { headers: h, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(res.status)) return { res, url };
    const to = res.headers.get("location");
    await res.body?.cancel();
    if (!to) throw new Error(`${urlForMessages(url.toString())}: a redirect with no address`);
    const next = new URL(to, url);
    if (next.protocol !== "https:" && next.protocol !== "http:")
      throw new ModelDownloadError(`a redirect to a ${next.protocol} address is refused`);
    if (url.protocol === "https:" && next.protocol === "http:")
      throw new ModelDownloadError(
        `${urlForMessages(url.toString())}: a redirect from HTTPS to plain HTTP is refused`,
      );
    url = next;
  }
  throw new Error(`${urlForMessages(start)}: more than 10 redirects`);
}

/** Free bytes for an unprivileged user on the file system that holds `dir`. */
export function freeBytes(dir: string): number {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

async function hashFile(path: string, h: Hash): Promise<void> {
  await pipeline(createReadStream(path), async (source) => {
    for await (const chunk of source) h.update(chunk as Buffer);
  });
}

/** Downloads to a file run at most once at a time; a second asker waits for the first. */
const running = new Map<string, Promise<void>>();

export interface DownloadInput {
  url: string;
  sha256: string;
  /** The file's final place (in the inbox). */
  target: string;
  /** Its place relative to the inbox, for the report. */
  path: string;
  name: string;
  run?: string | undefined;
  hfToken?: string | undefined;
  downloads: ModelDownloads;
  fetchImpl?: typeof fetch | undefined;
  /** Free bytes where the file goes (tests give their own). */
  free?: ((dir: string) => number) | undefined;
  /** The free space the rig keeps where the file goes, in bytes (goal 173); none: 0. */
  floor?: number | undefined;
}

/**
 * Downloads a model file to `target`. Only a file with the signed SHA-256 lands; one that does not
 * match is deleted, and the error says so. A download that breaks keeps what it has as
 * `<target>.part`, which the next download of the same file continues. One that would go below
 * the rig's disk floor is refused before it starts, or stopped as it writes, and deletes what it
 * had downloaded.
 */
export async function downloadModel(input: DownloadInput): Promise<void> {
  const busy = running.get(input.target);
  if (busy) {
    await busy.catch(() => undefined);
    if (existsSync(input.target)) return;
  }
  const work = download(input);
  running.set(input.target, work);
  try {
    await work;
  } finally {
    if (running.get(input.target) === work) running.delete(input.target);
  }
}

async function download(input: DownloadInput): Promise<void> {
  const f = input.fetchImpl ?? fetch;
  const free = input.free ?? freeBytes;
  const part = `${input.target}.part`;
  mkdirSync(dirname(input.target), { recursive: true });
  const shown = urlForMessages(input.url);
  const from = URL.parse(input.url)?.host ?? "?";
  input.downloads.begin({
    name: input.name,
    path: input.path,
    sha256: input.sha256,
    from,
    run: input.run,
  });
  // A message for the report, the live view and the command's outcome. Messages are Thermite's
  // own; the token is taken out all the same, in case a server echoed it.
  const clean = (err: unknown) => {
    const msg = redact(errorText(err));
    return input.hfToken ? msg.replaceAll(input.hfToken, "***") : msg;
  };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const have = existsSync(part) ? statSync(part).size : 0;
      // What an earlier download left is hashed first; it counts only if the server continues it.
      const earlier = createHash("sha256");
      if (have) await hashFile(part, earlier);
      const headers: Record<string, string> = { "accept-encoding": "identity" };
      if (have) headers.range = `bytes=${have}-`;
      const { res, url } = await getFollowing(f, input.url, headers, input.hfToken);
      if (res.status === 416 && have) {
        // The server has no such range: what is on disk is not the start of this file.
        await res.body?.cancel();
        rmSync(part, { force: true });
        continue;
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel();
        const hf = isHuggingFace(new URL(input.url));
        const why =
          hf && (res.status === 401 || res.status === 403)
            ? input.hfToken
              ? ": Hugging Face refused the supervisor's token for this file. Accept the model's terms on huggingface.co with the token's account, or give a token that may read it"
              : ": the model may be gated. Give the supervisor a Hugging Face token that may read it (THERMITE_HF_TOKEN_FILE)"
            : "";
        throw new ModelDownloadError(`${shown}: HTTP ${res.status}${why}`);
      }
      let total: number | null = null;
      let start = 0;
      let hash = createHash("sha256");
      if (res.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(res.headers.get("content-range") ?? "");
        if (!have || !range || Number(range[1]) !== have) {
          // A range other than the one asked for: start again from the beginning.
          await res.body.cancel();
          rmSync(part, { force: true });
          continue;
        }
        total = range[3] === "*" ? null : Number(range[3]);
        start = have;
        hash = earlier;
      } else {
        // The whole file: what an earlier download left is not used.
        const len = Number(res.headers.get("content-length") ?? "");
        total = res.headers.has("content-length") && Number.isSafeInteger(len) ? len : null;
      }
      // The file, and the rig's disk floor after it (goal 173): a download never fills the disk.
      // Refused in words; the owner frees space and assigns again.
      const floor = input.floor ?? 0;
      const need = (total ?? start) - start + floor;
      const avail = free(dirname(part));
      const where =
        dirname(input.path) === "." ? "the inbox" : `the inbox's ${dirname(input.path)}`;
      const keep = floor
        ? `, and the rig keeps ${gib(floor)} GiB free (THERMITE_DISK_FLOOR_GIB)`
        : "";
      if (need > avail) {
        await res.body.cancel();
        throw new ModelDownloadError(
          total === null
            ? `not enough free space for model ${input.name}: ${size(avail)} is free where it goes (${where})${keep}`
            : `not enough free space for model ${input.name}: it needs ${size(total - start)} more, and ${size(avail)} is free where it goes (${where})${keep}`,
        );
      }
      input.downloads.started(input.path, {
        total,
        resumedFrom: start,
        ...(url.host !== from ? { via: url.host } : {}),
      });
      let bytes = start;
      // The floor again as the bytes arrive: a server that gives no size, or more than it said,
      // stops at the floor too.
      let checkAt = bytes + FLOOR_CHECK_BYTES;
      const count = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk);
          bytes += chunk.length;
          input.downloads.progress(input.path, bytes);
          if (floor && bytes >= checkAt) {
            checkAt = bytes + FLOOR_CHECK_BYTES;
            const left = free(dirname(part));
            if (left < floor) {
              cb(
                new FloorReached(
                  `not enough free space for model ${input.name}: the download stopped after ${size(bytes)}, with ${size(left)} free where it goes (${where})${keep}. What it had downloaded was deleted`,
                ),
              );
              return;
            }
          }
          cb(null, chunk);
        },
      });
      try {
        await pipeline(
          Readable.fromWeb(res.body as never),
          count,
          createWriteStream(part, { flags: start ? "a" : "w", mode: 0o644 }),
        );
      } catch (err) {
        // Stopped at the floor: what arrived goes, to give the space back.
        if (err instanceof FloorReached) {
          rmSync(part, { force: true });
          throw err;
        }
        // What arrived stays as the .part file: the next download continues from it.
        throw new Error(
          `${shown}: the download broke after ${size(bytes)} (${err instanceof Error ? err.message.slice(0, 200) : String(err)}). The next try continues from there`,
        );
      }
      if (total !== null && bytes !== total)
        throw new Error(
          `${shown}: the download ended after ${size(bytes)} of ${size(total)}. The next try continues from there`,
        );
      const got = hash.digest("hex");
      if (got !== input.sha256) {
        rmSync(part, { force: true });
        const why = `Its SHA-256 is ${got}, not the signed ${input.sha256}.`;
        input.downloads.finish(input.path, "refused", why);
        throw new ModelRefused(
          `model ${input.name} from ${shown} refused: its SHA-256 is ${got}, not the signed ${input.sha256}. The file was deleted`,
        );
      }
      renameSync(part, input.target);
      input.downloads.finish(input.path, "done");
      return;
    }
    throw new ModelDownloadError(
      `${shown}: the server does not continue the file where it stopped`,
    );
  } catch (err) {
    if (err instanceof ModelRefused) throw err;
    const msg = clean(err);
    input.downloads.finish(input.path, "failed", msg);
    throw new ModelDownloadError(msg);
  }
}
