/**
 * Text as the Pi view draws it. What the model writes and what a tool answers are the agent's
 * and the lane's, and could hold a terminal's escape sequences: every control character goes
 * (C0, DEL and C1) but the line break, and a tab becomes two spaces, before the view hands the
 * text to pi-tui. The owner's browser then draws only what the view itself styled.
 */

/** The most characters of one text the view keeps: a longer one is cut, and says so. */
export const VIEW_TEXT_MAX = 20_000;

export function viewText(text: string, max = VIEW_TEXT_MAX): string {
  const cut =
    text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
  return (
    cut
      .replace(/\r\n?/g, "\n")
      .replace(/\t/g, "  ")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "")
  );
}

/** The first `lines` lines of a text, at most `chars` characters, and how many lines it left out. */
export function headOf(text: string, lines: number, chars: number): string {
  const all = text.split("\n");
  const head = all.slice(0, lines).join("\n").slice(0, chars);
  const left = all.length - lines;
  return left > 0 ? `${head}\n… (${left} more lines)` : head;
}
