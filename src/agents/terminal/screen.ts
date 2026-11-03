// Both are CommonJS bundles: their default export is the whole module, which Node gives on every
// version, where the names it finds in them by reading the code vary.
import serialize from "@xterm/addon-serialize";
import xterm from "@xterm/headless";
import type { ScreenSnapshot, ScreenText } from "./protocol.ts";

/**
 * The program's screen, kept by a headless terminal emulator (`@xterm/headless`, with its
 * serialize addon) from what the program writes. It answers the terminal's queries the emulator
 * knows (device attributes, the cursor's place), through `reply`, as a terminal would. The screen
 * is only ever shown: no decision reads it.
 */
export class Screen {
  private readonly term: xterm.Terminal;
  private readonly serializer = new serialize.SerializeAddon();

  constructor(o: {
    cols: number;
    rows: number;
    scrollback: number;
    reply: (data: string) => void;
  }) {
    this.term = new xterm.Terminal({
      cols: o.cols,
      rows: o.rows,
      scrollback: o.scrollback,
      allowProposedApi: true,
    });
    this.term.loadAddon(this.serializer);
    this.term.onData(o.reply);
  }

  /** What the program wrote; the emulator parses it a little later. */
  write(data: string): void {
    this.term.write(data);
  }

  /** Once everything written so far is parsed. */
  settled(): Promise<void> {
    return new Promise((resolve) => this.term.write("", resolve));
  }

  /** The program has turned bracketed paste on (mode 2004). */
  get bracketedPaste(): boolean {
    return this.term.modes.bracketedPasteMode;
  }

  /** The program has turned its cursor keys' application mode on (DECCKM). */
  get applicationCursor(): boolean {
    return this.term.modes.applicationCursorKeysMode;
  }

  /** The screen as plain lines, its empty lines at the bottom left out. */
  async text(): Promise<ScreenText> {
    await this.settled();
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < this.term.rows; i++)
      lines.push(buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? "");
    while (lines.length && !lines.at(-1)?.trim()) lines.pop();
    return {
      cols: this.term.cols,
      rows: this.term.rows,
      cursor: { x: buffer.cursorX, y: buffer.cursorY },
      alternate: buffer.type === "alternate",
      lines,
    };
  }

  /** The screen, and at most `scrollback` lines above it, as one string that restores them. */
  async snapshot(scrollback: number): Promise<ScreenSnapshot> {
    await this.settled();
    return {
      cols: this.term.cols,
      rows: this.term.rows,
      data: this.serializer.serialize({ scrollback }),
    };
  }

  dispose(): void {
    this.term.dispose();
  }
}
