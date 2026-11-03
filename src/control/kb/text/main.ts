import { closeSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { htmlText } from "./html.ts";
import {
  type KbTextJob,
  type KbTextLimits,
  type KbTextResult,
  MEMORY_EXIT,
  MEMORY_LOOK_MS,
  mib,
} from "./job.ts";
import { pdfText } from "./pdf.ts";

/**
 * Control's text extractor's child (index.ts starts it): one file's text, from the job it is sent,
 * answered once, then it ends. It reads the file and nothing else, imports nothing of Thermite's
 * but this folder, and runs with `--no-addons` and a heap of the job's memory. Its watchdog ends it
 * when it uses more memory than that in all; its parent kills it past the job's time.
 */

/** How much of a file is read to tell text from binary data: a NUL byte in it says binary. */
const SNIFF_BYTES = 8192;

/** The first `max` bytes of a file, and its whole size. */
function head(path: string, max: number): { bytes: Buffer; size: number } {
  const size = statSync(path).size;
  const bytes = Buffer.alloc(Math.min(size, max));
  const fd = openSync(path, "r");
  try {
    let at = 0;
    while (at < bytes.length) {
      const n = readSync(fd, bytes, at, bytes.length - at, at);
      if (n === 0) break;
      at += n;
    }
    return { bytes: bytes.subarray(0, at), size };
  } finally {
    closeSync(fd);
  }
}

/** A text kept to the limit on characters, with where it was cut. */
function kept(text: string, limits: KbTextLimits, more: boolean): KbTextResult {
  const n = limits.chars.toLocaleString("en-US");
  if (!text.trim()) return { state: "whole", why: "it holds no text", pages: null };
  if (text.length > limits.chars)
    return {
      state: "searched",
      text: text.slice(0, limits.chars),
      why: `its first ${n} characters`,
      pages: null,
    };
  return {
    state: "searched",
    text,
    why: more ? `its first ${mib(limits.readBytes)}: control reads no more of a file` : null,
    pages: null,
  };
}

/** A Markdown, plain text or HTML file's text: UTF-8, read to the limit, binary data kept whole. */
function textOf(job: KbTextJob): KbTextResult {
  const { limits } = job;
  // Each character takes at most 4 bytes in UTF-8; a web page more, for its markup.
  const max =
    job.reader === "html" ? limits.readBytes : Math.min(limits.readBytes, limits.chars * 4 + 4);
  const { bytes, size } = head(job.path, max);
  if (bytes.subarray(0, SNIFF_BYTES).includes(0))
    return { state: "whole", why: "it holds binary data, not text", pages: null };
  const raw = new TextDecoder("utf-8").decode(bytes);
  const text = job.reader === "html" ? htmlText(raw) : raw.replaceAll("\u0000", "");
  return kept(text, limits, size > bytes.length && size > limits.readBytes);
}

/** A PDF's text, read whole into memory: one larger than the limit on bytes is kept whole. */
async function pdfOf(job: KbTextJob, started: number): Promise<KbTextResult> {
  const { limits } = job;
  const size = statSync(job.path).size;
  if (size > limits.readBytes)
    return {
      state: "whole",
      why: `it has ${mib(size)}, more than the ${mib(limits.readBytes)} control reads to extract a PDF's text`,
      pages: null,
    };
  const { bytes } = head(job.path, size);
  // Pages stop being read at four fifths of the time, so a long PDF keeps the text read by then.
  return pdfText(new Uint8Array(bytes), limits, started + limits.timeoutMs * 0.8);
}

/** Ends the child once it uses more memory in all than its job allows: at once, and as it reads. */
function watchMemory(limitMb: number): void {
  const look = () => {
    if (process.memoryUsage.rss() > limitMb * 1024 ** 2) process.exit(MEMORY_EXIT);
  };
  look();
  setInterval(look, MEMORY_LOOK_MS).unref();
}

async function run(job: KbTextJob): Promise<KbTextResult> {
  const started = Date.now();
  watchMemory(job.limits.memoryMb);
  return job.reader === "pdf" ? pdfOf(job, started) : textOf(job);
}

// Where the kernel must end a process for want of memory, it ends this one before control.
try {
  writeFileSync("/proc/self/oom_score_adj", "1000");
} catch {
  // Not Linux, or not allowed: the watchdog and the heap's limit still hold.
}

// A control that stops takes its child with it.
process.once("disconnect", () => process.exit(0));
process.once("message", (job: KbTextJob) => {
  run(job)
    .then((r) => process.send?.(r, () => process.exit(0)))
    .catch((err: unknown) => {
      const words = err instanceof Error ? err.message : String(err);
      process.send?.(
        { state: "whole", why: `its text could not be read: ${words}`, pages: null },
        () => process.exit(0),
      );
    });
});
