import type { TerminalKey } from "../programs/index.ts";

/**
 * What the terminal host writes to a program for a named key and for typed text, as an xterm
 * sends them. Text never sends a key: every control character in it is taken out, Esc among them,
 * but its line breaks and tabs, which go in a bracketed paste when the program has asked for one.
 */

/** Enter, and the gap before it after text: a quick Enter after text is a new line in Codex. */
export const ENTER = "\r";
export const ENTER_GAP_MS = 500;
/** The gap between two keys of one request, so a program reads each by itself. */
export const KEY_GAP_MS = 50;

const ARROWS: Partial<Record<TerminalKey, string>> = { up: "A", down: "B", right: "C", left: "D" };

/**
 * A key's bytes. The arrows depend on the program's cursor-key mode: with it on (DECCKM, as most
 * full-screen programs set it), an xterm sends `ESC O A` for up, else `ESC [ A`.
 */
export function keyBytes(key: TerminalKey, applicationCursor: boolean): string {
  const arrow = ARROWS[key];
  if (arrow) return `${applicationCursor ? "\x1bO" : "\x1b["}${arrow}`;
  switch (key) {
    case "enter":
      return ENTER;
    case "esc":
      return "\x1b";
    case "tab":
      return "\t";
    case "page-up":
      return "\x1b[5~";
    case "page-down":
      return "\x1b[6~";
    default:
      // The digits.
      return key;
  }
}

/**
 * Text as it is typed into a program: its control characters taken out (C0, DEL and C1), but its
 * line breaks (as LF) and tabs. Text with a line break or a tab goes as a bracketed paste when the
 * program has turned bracketed paste on, so that neither submits or completes anything; otherwise
 * as typed.
 */
export function typedText(text: string, bracketedPaste: boolean): string {
  const clean = text
    .replace(/\r\n?/g, "\n")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
  return bracketedPaste && /[\n\t]/.test(clean) ? `\x1b[200~${clean}\x1b[201~` : clean;
}
