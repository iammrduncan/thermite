import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { KbTextLimits, KbTextResult } from "./job.ts";

/**
 * A PDF's text, with Mozilla's PDF.js (vendor/pdfjs/), in control's text extractor's child
 * (main.ts). PDF.js is loaded only when its two files are the ones pinned here. It runs in the
 * child's own thread (its "fake worker"), with every part it does not need for text turned off:
 * no fonts loaded or drawn, no system fonts, no eval, no WebAssembly, no canvas, and no fetch of a
 * document, a font, a character map or anything else, since it is given the file's bytes and no
 * address. The child runs with `--no-addons`, so the native canvas PDF.js looks for never loads.
 */

/** The vendored copy: pdfjs-dist's legacy build (vendor/pdfjs/README.md). */
export const PDFJS_DIR = fileURLToPath(new URL("../../../../vendor/pdfjs/", import.meta.url));
export const PDFJS_VERSION = "6.4.299";
/** The files' SHA-256, as pdfjs-dist 6.4.299 has them: control loads no other. */
export const PDFJS_SHA256 = {
  "pdf.mjs": "bc51f4874a66e3853189cb5d50aba4b3096afa83ed433b885d293a3d94583cdc",
  "pdf.worker.mjs": "bb422f60804477de4a0b09091d8347a916a387755ed1cbad24ccaec1d09c78bf",
} as const;

/** Why the vendored files can't be loaded, in words; undefined when both are the pinned ones. */
export function pdfjsProblem(dir = PDFJS_DIR): string | undefined {
  for (const [name, want] of Object.entries(PDFJS_SHA256)) {
    let sha: string;
    try {
      sha = createHash("sha256")
        .update(readFileSync(`${dir}${name}`))
        .digest("hex");
    } catch {
      return `control's copy of PDF.js has no vendor/pdfjs/${name}`;
    }
    if (sha !== want) return `vendor/pdfjs/${name} is not PDF.js ${PDFJS_VERSION}'s: not loaded`;
  }
  return undefined;
}

/** What Thermite uses of PDF.js's API. */
interface TextItem {
  str?: string;
  hasEOL?: boolean;
}
interface PdfPage {
  getTextContent(): Promise<{ items: TextItem[] }>;
  cleanup(): void;
}
interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
}
interface PdfJs {
  getDocument(o: Record<string, unknown>): {
    promise: Promise<PdfDocument>;
    destroy(): Promise<void>;
  };
}

/** PDF.js's options: the file's bytes, and every part text extraction does not need turned off. */
const OPTIONS = {
  isEvalSupported: false,
  disableFontFace: true,
  useSystemFonts: false,
  useWasm: false,
  isOffscreenCanvasSupported: false,
  isImageDecoderSupported: false,
  disableAutoFetch: true,
  disableStream: true,
  disableRange: true,
  enableXfa: false,
  stopAtErrors: false,
  verbosity: 0,
};

/** PDF.js, loaded once its files are checked; it runs its worker in this thread. */
async function loadPdfjs(): Promise<PdfJs> {
  const worker = (await import(pathToFileURL(`${PDFJS_DIR}pdf.worker.mjs`).href)) as object;
  (globalThis as { pdfjsWorker?: object }).pdfjsWorker = worker;
  return (await import(pathToFileURL(`${PDFJS_DIR}pdf.mjs`).href)) as PdfJs;
}

/** One page's text: its items in order, a line where PDF.js ends one. */
const pageText = (items: TextItem[]): string =>
  items.map((i) => `${i.str ?? ""}${i.hasEOL ? "\n" : ""}`).join("");

/**
 * The text of a PDF's bytes, page after page, until its last page, the limit on pages or on
 * characters, or `stopAt` (a time, by `now`), whichever comes first: a cut text says where it
 * stopped. A PDF with no text, such as scanned pages, is kept whole; so is one PDF.js can't read.
 */
export async function pdfText(
  bytes: Uint8Array,
  limits: Pick<KbTextLimits, "pages" | "chars">,
  stopAt: number,
  now: () => number = Date.now,
): Promise<KbTextResult> {
  const problem = pdfjsProblem();
  if (problem) return { state: "whole", why: problem, pages: null };
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ ...OPTIONS, data: bytes });
  let doc: PdfDocument;
  try {
    doc = await task.promise;
  } catch (err) {
    const words = err instanceof Error ? err.message : String(err);
    const locked = (err as { name?: string }).name === "PasswordException";
    return {
      state: "whole",
      why: locked ? "it is locked with a password" : `PDF.js could not read it: ${words}`,
      pages: null,
    };
  }
  const parts: string[] = [];
  let chars = 0;
  let read = 0;
  let cut: string | null = null;
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      if (n > limits.pages) {
        cut = `the first ${limits.pages.toLocaleString("en-US")} of its ${doc.numPages.toLocaleString("en-US")} pages`;
        break;
      }
      if (now() >= stopAt) {
        cut = `the first ${read.toLocaleString("en-US")} of its ${doc.numPages.toLocaleString("en-US")} pages: reading more took too long`;
        break;
      }
      const page = await doc.getPage(n);
      const text = pageText((await page.getTextContent()).items);
      page.cleanup();
      read = n;
      parts.push(text);
      chars += text.length + 2;
      // Enough text: the pages after this one are not read.
      if (chars > limits.chars) break;
    }
  } finally {
    await task.destroy();
  }
  const all = parts.join("\n\n").trim();
  if (all.length > limits.chars || (chars > limits.chars && read < doc.numPages))
    cut = `the first ${limits.chars.toLocaleString("en-US")} characters, from ${read.toLocaleString("en-US")} of its ${doc.numPages.toLocaleString("en-US")} pages`;
  const text = all.slice(0, limits.chars);
  if (!text)
    return {
      state: "whole",
      why: "it holds no text: its pages may be scanned images, and control reads no text from images",
      pages: read,
    };
  return { state: "searched", text, why: cut, pages: read };
}
