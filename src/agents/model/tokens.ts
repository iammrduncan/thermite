/**
 * The tokens a provider's answer reports for its call, read as the answer passes a model proxy:
 * OpenAI's chat completions (`prompt_tokens`, `completion_tokens`), its Responses API and
 * Anthropic's Messages API (`input_tokens`, `output_tokens`, with Anthropic's cache reads and
 * writes, which its `input_tokens` leaves out). Input counts every input token, cached or not, as
 * a usage record does (core/usage.ts). A streamed answer repeats or grows its figures (Anthropic's
 * output grows to the end of the stream), so each figure is the largest the answer gave. Keys
 * inside a JSON string, such as the model's own text, are escaped there, so they never match.
 */

/** What one answer reported: its input and output tokens. */
export interface AnswerTokens {
  in: number;
  out: number;
}

/** Each figure an answer may give, and the keys that give it. */
const FIGURES = {
  input: /"(?:input_tokens|prompt_tokens)"\s*:\s*(\d{1,15})/g,
  cacheRead: /"cache_read_input_tokens"\s*:\s*(\d{1,15})/g,
  cacheWrite: /"cache_creation_input_tokens"\s*:\s*(\d{1,15})/g,
  output: /"(?:output_tokens|completion_tokens)"\s*:\s*(\d{1,15})/g,
} as const;

/** What a key split between two parts of the answer needs to be read whole with the next one. */
const TAIL = 64;

export class TokensSeen {
  private readonly decoder = new TextDecoder();
  private tail = "";
  private readonly most: Record<keyof typeof FIGURES, number> = {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
  };
  private seen = false;

  /** Reads one part of the answer as it passes. */
  feed(chunk: Uint8Array): void {
    const text = this.tail + this.decoder.decode(chunk, { stream: true });
    for (const k of Object.keys(FIGURES) as (keyof typeof FIGURES)[])
      for (const m of text.matchAll(FIGURES[k])) {
        this.seen = true;
        this.most[k] = Math.max(this.most[k], Number(m[1]));
      }
    this.tail = text.slice(-TAIL);
  }

  /** What the answer reported so far; undefined: it gave no figure. */
  tokens(): AnswerTokens | undefined {
    if (!this.seen) return undefined;
    const m = this.most;
    return { in: m.input + m.cacheRead + m.cacheWrite, out: m.output };
  }
}
