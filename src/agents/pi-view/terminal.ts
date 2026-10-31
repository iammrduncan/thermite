import type { Terminal } from "@earendil-works/pi-tui";

/**
 * pi-tui's terminal for the Pi view: it writes what pi-tui draws to the worker's own terminal
 * (the pseudo-terminal the terminal host holds) and reads nothing from it. The owner's input
 * reaches the worker over its trial's routes, never as keys, so pi-tui gets no input to read,
 * and the view sets no window title, progress or status, which a terminal shows as more than text.
 */
export class OutputTerminal implements Terminal {
  private readonly out: (data: string) => void;
  private readonly size: { cols: number; rows: number };

  constructor(out: (data: string) => void, size: { cols: number; rows: number }) {
    this.out = out;
    this.size = size;
  }

  start(): void {
    // Nothing to read: the view takes no keys.
  }

  stop(): void {
    // Nothing to give back: the view never put the terminal in raw mode.
  }

  async drainInput(): Promise<void> {
    // No input is read.
  }

  write(data: string): void {
    this.out(data);
  }

  get columns(): number {
    return this.size.cols;
  }

  get rows(): number {
    return this.size.rows;
  }

  get kittyProtocolActive(): boolean {
    return false;
  }

  moveBy(lines: number): void {
    if (lines > 0) this.out(`\x1b[${lines}B`);
    else if (lines < 0) this.out(`\x1b[${-lines}A`);
  }

  hideCursor(): void {
    this.out("\x1b[?25l");
  }

  showCursor(): void {
    this.out("\x1b[?25h");
  }

  clearLine(): void {
    this.out("\x1b[K");
  }

  clearFromCursor(): void {
    this.out("\x1b[J");
  }

  clearScreen(): void {
    this.out("\x1b[2J\x1b[H");
  }

  setTitle(): void {
    // No title: the screen is text only.
  }

  setProgress(): void {
    // No progress mark.
  }

  setProgramStatus(): void {
    // No program status: the view's own status line says it.
  }
}
