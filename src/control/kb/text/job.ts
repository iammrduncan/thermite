import type { KbTextReader } from "../../../core/kb.ts";

/**
 * What control's text extractor (index.ts) hands its child process (main.ts) for one file, and
 * what the child answers. The child imports nothing but this folder's files and Node's own.
 */

/** The mechanical limits of one file's extraction. */
export interface KbTextLimits {
  /** How long one file may take, in milliseconds: past it the child is killed. */
  timeoutMs: number;
  /** How many pages of a PDF are read; the rest are not. */
  pages: number;
  /** How many characters of text are kept; the rest are not. */
  chars: number;
  /** How many bytes of a file are read: a larger PDF is kept whole, a larger text read to there. */
  readBytes: number;
  /** How much memory the child may use, in MiB: its heap, and in all, as its watchdog reads it. */
  memoryMb: number;
}

/** One file to read: where it is, and how. */
export interface KbTextJob {
  path: string;
  reader: KbTextReader;
  limits: KbTextLimits;
}

/**
 * What became of one file: its text (searched), or why it is kept whole. `why` also says when a
 * searched text was cut, and is null for a text read whole. `pages`: a PDF's pages read.
 */
export type KbTextResult =
  | { state: "searched"; text: string; why: string | null; pages: number | null }
  | { state: "whole"; why: string; pages: number | null };

/** The child's exit code when its watchdog finds it over its memory. */
export const MEMORY_EXIT = 70;

/** How often the child reads its own memory, in milliseconds. */
export const MEMORY_LOOK_MS = 100;

/** A number of bytes in MiB, for the words a result gives. */
export const mib = (bytes: number): string =>
  `${(bytes / 1024 ** 2).toLocaleString("en-US", { maximumFractionDigits: 1 })} MiB`;
