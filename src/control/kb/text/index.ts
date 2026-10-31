import { fork } from "node:child_process";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../../../common/env.ts";
import { errorText } from "../../../common/errors.ts";
import { type KbTextReader, kbTextReader } from "../../../core/kb.ts";
import type { ControlStore } from "../../store/index.ts";
import { type KbTextJob, type KbTextLimits, type KbTextResult, MEMORY_EXIT, mib } from "./job.ts";

export { htmlText } from "./html.ts";
export type { KbTextLimits, KbTextResult } from "./job.ts";
export { PDFJS_SHA256, PDFJS_VERSION, pdfjsProblem } from "./pdf.ts";

/**
 * The text of the knowledge base's files, extracted on control (goal 175, step 7): Markdown and
 * plain text as they are, a web page as its words with no markup, scripts or styles, and a PDF with
 * PDF.js. Each file is read once, by its SHA-256, off control's main thread: in a child process of
 * its own (main.ts), one file at a time, with a time, pages, characters, bytes and memory it may
 * not pass. Its text goes into the words index, in each item that names the file (store/kb/), so a
 * search finds the file by its words; a file whose text can't be read is kept whole, with why.
 */

/** Each mechanical limit's default, as the knowledge base reference states it. */
export const KB_TEXT_LIMITS: KbTextLimits = {
  timeoutMs: 120_000,
  pages: 2_000,
  chars: 5_000_000,
  readBytes: 256 * 1024 ** 2,
  memoryMb: 1024,
};

/** How often control looks for files whose text waits; it looks first as it starts. */
export const KB_TEXT_LOOK_MS = 15_000;
/** Files one query of the store hands the extractor; it asks again until none waits. */
const BATCH = 100;

/** The child program, as Node runs it: main.ts, or main.js once built. */
export const TEXT_PROGRAM = fileURLToPath(
  new URL(`./main${extname(fileURLToPath(import.meta.url))}`, import.meta.url),
);

/** Node's options for the child: no native module may load, and its heap is kept to its memory. */
export const textExecArgv = (limits: KbTextLimits): string[] => [
  "--no-addons",
  `--max-old-space-size=${limits.memoryMb}`,
  "--disable-warning=ExperimentalWarning",
];

/** Why a file of a type control reads no text of is kept whole. */
export const notSearchedWhy = (type: string): string =>
  `control searches the text of Markdown, plain text, web pages and PDF files, not ${type}`;

/** The last of the child's standard error kept, for the log when it ends with no answer. */
const STDERR_KEPT = 2048;

/** A result as the child sends it, checked: it reads files no one checked. */
function resultOf(m: unknown): KbTextResult | undefined {
  const r = m as Partial<Record<string, unknown>> | null;
  if (!r || (typeof r.why !== "string" && r.why !== null)) return undefined;
  const pages = typeof r.pages === "number" ? r.pages : null;
  if (r.state === "whole" && typeof r.why === "string")
    return { state: "whole", why: r.why, pages };
  if (r.state === "searched" && typeof r.text === "string")
    return { state: "searched", text: r.text, why: r.why ?? null, pages };
  return undefined;
}

/**
 * One file's text, read by a child process within `limits`: its answer, or, when it ends with
 * none (killed past its time, over its memory, or broken), why the file is kept whole. Rejects
 * when the child can't start, so the file is tried again later.
 */
export function extractText(
  path: string,
  reader: KbTextReader,
  limits: KbTextLimits = KB_TEXT_LIMITS,
): Promise<KbTextResult> {
  return new Promise((done, fail) => {
    const child = fork(TEXT_PROGRAM, [], {
      execArgv: textExecArgv(limits),
      // Nothing of control's environment: the child needs none, and holds no secret.
      env: {},
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let answer: KbTextResult | undefined;
    let ended = false;
    let late = false;
    let stderr = "";
    child.stderr?.on("data", (b: Buffer) => {
      stderr = (stderr + b.toString("utf8")).slice(-STDERR_KEPT);
    });
    const timer = setTimeout(() => {
      late = true;
      child.kill("SIGKILL");
    }, limits.timeoutMs);
    child.on("message", (m) => {
      answer = resultOf(m);
    });
    child.on("error", (err) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      fail(new Error(`the text extractor did not start: ${errorText(err)}`));
    });
    child.on("exit", (code, signal) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      if (answer) return done(answer);
      const memory = code === MEMORY_EXIT || /heap out of memory|allocation failed/i.test(stderr);
      const why = late
        ? `reading its text took longer than ${limits.timeoutMs / 1000} seconds`
        : memory
          ? `reading its text needed more than ${mib(limits.memoryMb * 1024 ** 2)} of memory`
          : `the text extractor stopped (${signal ?? `exit ${code}`}) with no answer`;
      if (!late && !memory)
        log(
          "control",
          "the text extractor stopped with no answer",
          { path, code, signal, stderr },
          "warn",
        );
      done({ state: "whole", why, pages: null });
    });
    const job: KbTextJob = { path, reader, limits };
    child.send(job);
  });
}

/**
 * Control's extractor of the knowledge base's files' text. A look reads every file that waits
 * (named by an item's version, of a type control reads, held, and with no text yet), oldest kept
 * first, one at a time, and keeps each one's text or why it is kept whole, so each is read once.
 * Its first look, as control starts, reads the files kept before control extracted text; a look
 * while another reads does nothing.
 */
export class KbText {
  private readonly store: ControlStore;
  private readonly path: (sha256: string) => string;
  readonly limits: KbTextLimits;
  private running: Promise<number> | undefined;
  /** Files read since control started, for its log and tests. */
  read = 0;

  constructor(
    store: ControlStore,
    files: { path(sha256: string): string },
    limits: Partial<KbTextLimits> = {},
  ) {
    this.store = store;
    this.path = (sha256) => files.path(sha256);
    this.limits = { ...KB_TEXT_LIMITS, ...limits };
  }

  /**
   * Reads every file that waits; resolves with how many it read (0 when another look reads). A
   * look that fails is logged, and the next one tries again.
   */
  look(): Promise<number> {
    if (this.running) return Promise.resolve(0);
    this.running = this.pass()
      .catch((err: unknown) => {
        log("control", "the files' text not looked for", { error: errorText(err) }, "error");
        return 0;
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  private async pass(): Promise<number> {
    const kb = this.store.kb();
    /** Files this pass could not keep a result for: not asked for again until the next. */
    const failed = new Set<string>();
    let n = 0;
    for (;;) {
      const due = kb.files.textWaiting(BATCH).filter((f) => !failed.has(f.sha256));
      if (!due.length) return n;
      for (const f of due) {
        const reader = kbTextReader(f.type);
        if (!reader) {
          failed.add(f.sha256);
          continue;
        }
        const started = performance.now();
        let r: KbTextResult;
        try {
          r = await extractText(this.path(f.sha256), reader, this.limits);
          kb.keepFileText(f.sha256, r);
        } catch (err) {
          // Tried again at the next look.
          failed.add(f.sha256);
          log(
            "control",
            "a file's text not kept",
            { sha256: f.sha256, error: errorText(err) },
            "error",
          );
          continue;
        }
        n++;
        this.read++;
        const what = {
          sha256: f.sha256,
          type: f.type,
          bytes: f.bytes,
          pages: r.pages,
          ms: Math.round(performance.now() - started),
        };
        if (r.state === "searched")
          log("control", "a file's text extracted", { ...what, chars: r.text.length, cut: r.why });
        else log("control", "a file kept whole: its text not extracted", { ...what, why: r.why });
      }
    }
  }
}
