import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import {
  type Component,
  Container,
  Markdown,
  type MarkdownTheme,
  setCapabilities,
  Text,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { summarizeArgs } from "../../../core/live.ts";
import type { ProviderWait, TrialStatus } from "../worker/index.ts";
import { OutputTerminal } from "./terminal.ts";
import { headOf, viewText } from "./text.ts";

/**
 * The Pi view's screen (goal 169): Thermite's drawing of a worker's own Pi session with pi-tui,
 * Pi's terminal library, in the worker's process, on the terminal the terminal host holds. It
 * draws what the trial's own events say (the agent's replies, its thinking, each tool call with
 * the head of its result, each later turn, the owner's input) and a status line from the trial's
 * counts, and nothing it draws decides anything: a screen that fails to draw stops drawing, and
 * the trial goes on. No images, no links (OSC 8) and no clipboard writes: the view turns pi-tui's
 * off, and uses its main screen, which writes none (its style reset closes a link, never opens
 * one).
 */

/** The most entries the screen keeps: past it, the oldest DROP go (the host keeps scrollback). */
export const VIEW_ENTRIES_MAX = 300;
const DROP = 100;
/** How often the status line is drawn again at most while the model streams its reply. */
const STATUS_EVERY_MS = 250;

const sgr = (on: string, off: string) => (s: string) => `\x1b[${on}m${s}\x1b[${off}m`;
const bold = sgr("1", "22");
const dim = sgr("2", "22");
const italic = sgr("3", "23");
const underline = sgr("4", "24");
const cyan = sgr("36", "39");
const yellow = sgr("33", "39");
const magenta = sgr("35", "39");
const red = sgr("31", "39");

const THEME: MarkdownTheme = {
  heading: (s) => bold(cyan(s)),
  link: underline,
  linkUrl: dim,
  code: yellow,
  codeBlock: (s) => s,
  codeBlockBorder: dim,
  quote: italic,
  quoteBorder: dim,
  hr: dim,
  listBullet: cyan,
  bold,
  italic,
  strikethrough: sgr("9", "29"),
  underline,
};

/** A message's text or thinking blocks, as one text. */
function blocks(content: unknown, type: "text" | "thinking"): string {
  if (typeof content === "string") return type === "text" ? content : "";
  if (!Array.isArray(content)) return "";
  return (content as { type?: string; text?: string; thinking?: string }[])
    .filter((b) => b.type === type)
    .map((b) => (type === "text" ? b.text : b.thinking) ?? "")
    .join("\n")
    .trim();
}

/** pi-tui's main screen, which stops drawing at its first failure instead of throwing. */
class SafeScreen extends TuiMainScreen {
  private down = false;

  protected override doRender(): void {
    if (this.down) return;
    try {
      super.doRender();
    } catch {
      // A line pi-tui could not fit, or a fault of its own: the view stops drawing, and the
      // trial goes on without it.
      this.down = true;
    }
  }
}

export class PiView {
  private readonly screen: SafeScreen;
  private readonly entries = new Container();
  private readonly status = new Text("", 1, 0);
  private counts: (() => TrialStatus) | undefined;
  /** Characters of the reply the model is streaming, while it streams one. */
  private replying: number | undefined;
  private waitUntil: string | undefined;
  private ended: string | undefined;
  private users = 0;
  private statusAt = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(o: {
    out: (data: string) => void;
    cols: number;
    rows: number;
    /** The view's first line: what it is a view of. */
    heading: string;
    /** Where pi-tui writes the log of a failed drawing: the worker's own folder. */
    logDir?: string | undefined;
  }) {
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });
    this.screen = new SafeScreen(
      new OutputTerminal(o.out, { cols: o.cols, rows: o.rows }),
      false,
      o.logDir,
    );
    this.screen.addChild(
      new Text(
        `${bold(viewText(o.heading, 400))}\n${dim("Thermite draws this view of its own Pi session; it is not Pi's program. The console under it steers the agent: words, Esc, /status, /compact, /mcp, /mcp reconnect, /skill:NAME.")}`,
        1,
        0,
      ),
    );
    this.screen.addChild(this.entries);
    this.screen.addChild(this.status);
    this.timer = setInterval(() => this.refresh(), 1_000);
    this.timer.unref?.();
  }

  start(): void {
    this.guard(() => {
      this.refresh();
      this.screen.start();
    });
  }

  /** The trial's agent, whose events the view draws, and its counts for the status line. */
  attach(agent: Agent, counts: () => TrialStatus): void {
    this.counts = counts;
    agent.subscribe((e) => this.guard(() => this.on(e)));
    this.refresh();
  }

  /** A line of the view's own, such as what a command did. */
  note(text: string, tone: "info" | "bad" = "info"): void {
    this.guard(() =>
      this.add(new Text(`${tone === "bad" ? red("·") : yellow("·")} ${viewText(text)}`, 1, 0)),
    );
  }

  /** The owner's words from the console, as they go to the agent. */
  owner(text: string, how: "steer" | "follow_up"): void {
    this.guard(() =>
      this.add(
        new Text(
          `${magenta("owner ›")} ${viewText(text)}\n${dim(how === "steer" ? "  (steers the agent before its next model call)" : "  (a follow-up: given when the agent would stop)")}`,
          1,
          0,
        ),
      ),
    );
  }

  /** A wait for the provider, until its time. */
  waiting(w: ProviderWait): void {
    this.guard(() => {
      this.waitUntil = w.until;
      this.add(
        new Text(
          `${yellow("◷")} waiting for the provider until ${w.until.slice(11, 16)} UTC (${w.kind}): ${viewText(w.words, 300)}`,
          1,
          0,
        ),
      );
      this.refresh();
    });
  }

  /** The trial's end, in words. */
  finish(words: string): void {
    this.guard(() => {
      this.ended = viewText(words, 300);
      this.refresh();
    });
  }

  /** Draws what is pending now. */
  flush(): void {
    this.guard(() => this.screen.renderNow());
  }

  /** Draws what is pending, then stops drawing. */
  stop(): void {
    clearInterval(this.timer);
    this.flush();
    this.guard(() => this.screen.stop());
  }

  /** Runs `work`; a failure stops nothing but this drawing. */
  private guard(work: () => void): void {
    try {
      work();
    } catch {
      // The view is only a view: the trial goes on whatever it fails to draw.
    }
  }

  private add(c: Component): void {
    this.entries.addChild(c);
    if (this.entries.children.length > VIEW_ENTRIES_MAX)
      for (const old of this.entries.children.slice(0, DROP)) this.entries.removeChild(old);
    this.screen.requestRender();
  }

  private on(e: AgentEvent): void {
    switch (e.type) {
      case "message_update": {
        const d = e.assistantMessageEvent as { delta?: unknown };
        if (typeof d.delta !== "string") return;
        this.replying = (this.replying ?? 0) + d.delta.length;
        if (Date.now() - this.statusAt >= STATUS_EVERY_MS) this.refresh();
        return;
      }
      case "message_end": {
        const m = e.message as {
          role?: string;
          content?: unknown;
          stopReason?: string;
          errorMessage?: string;
        };
        if (m.role === "assistant") {
          this.reply(m);
          return;
        }
        if (m.role !== "user") return;
        const text = viewText(blocks(m.content, "text"));
        // The first is the trial's first message: its brief, of which the head is enough.
        if (this.users++ === 0)
          this.add(new Text(dim(`the trial's first message:\n${headOf(text, 6, 800)}`), 1, 0));
        else this.add(new Text(`${magenta("→")} ${headOf(text, 8, 1200)}`, 1, 0));
        return;
      }
      case "tool_execution_start":
        this.add(
          new Text(
            `${cyan("▸")} ${bold(viewText(e.toolName, 100))} ${dim(viewText(summarizeArgs(e.args, 200)))}`,
            1,
            0,
          ),
        );
        return;
      case "tool_execution_end": {
        const r = e.result as { content?: unknown } | undefined;
        const out = viewText(blocks(r?.content, "text") || summarizeArgs(e.result, 400), 4_000);
        const head = headOf(out, 4, 400).replaceAll("\n", "\n    ");
        this.add(new Text(`  ${e.isError ? red("↳ failed:") : dim("↳")} ${dim(head)}`, 1, 0));
        return;
      }
      case "turn_end":
        this.refresh();
        return;
      default:
        return;
    }
  }

  private reply(m: { content?: unknown; stopReason?: string; errorMessage?: string }): void {
    this.replying = undefined;
    this.waitUntil = undefined;
    const thinking = viewText(blocks(m.content, "thinking"));
    if (thinking) this.add(new Text(dim(italic(headOf(thinking, 3, 400))), 1, 0));
    const text = viewText(blocks(m.content, "text"));
    if (text) this.add(new Markdown(text, 1, 0, THEME));
    if (m.stopReason === "aborted") this.add(new Text(yellow("· the reply was stopped"), 1, 0));
    else if (m.stopReason === "error")
      this.add(
        new Text(
          red(`· the model call failed: ${viewText(m.errorMessage ?? "no detail", 300)}`),
          1,
          0,
        ),
      );
    this.refresh();
  }

  /** The status line, drawn again. */
  private refresh(): void {
    this.guard(() => this.drawStatus());
  }

  private drawStatus(): void {
    this.statusAt = Date.now();
    const c = this.counts?.();
    const state = this.ended
      ? `■ the trial ended: ${this.ended}`
      : this.waitUntil
        ? `◷ waiting for the provider until ${this.waitUntil.slice(11, 16)} UTC`
        : this.replying !== undefined
          ? `● the model is replying: ${this.replying.toLocaleString("en-US")} characters`
          : c
            ? "● at work"
            : "○ starting";
    const counts = c
      ? [
          `turn ${c.turns}${c.maxTurns !== undefined ? ` of ${c.maxTurns}` : ""}`,
          `${c.toolCalls} tool calls`,
          `${c.tokensIn.toLocaleString("en-US")} tokens in, ${c.tokensOut.toLocaleString("en-US")} out`,
          ...(c.compactions ? [`compacted ${c.compactions} times`] : []),
          c.msLeft !== undefined ? `${Math.ceil(c.msLeft / 60_000)} min left` : "no time limit",
        ].join(" · ")
      : "";
    this.status.setText(`${bold(state)}${counts ? dim(` · ${counts}`) : ""}`);
    this.screen.requestRender();
  }
}
