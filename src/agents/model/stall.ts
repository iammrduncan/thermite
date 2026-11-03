import { log } from "../../common/env.ts";
import { readNumber } from "../../common/settings.ts";
import { AGENTS_NUMBERS } from "../settings.ts";

/**
 * A model call whose stream goes silent (goal 079). A provider can keep a call open and send
 * nothing more: no token, no error and no end. A gateway may even keep the connection alive with
 * comment lines (`: OPENROUTER PROCESSING`) or pings while the model behind it sends nothing, so
 * no client timeout ever fires and the trial waits forever. Here, when no data arrives for
 * THERMITE_MODEL_STALL_SECONDS (600 by default) while the call waits for its answer, or for its
 * answer's next part, the call is broken off and is a `server` error of the provider: the agent
 * waits and goes on in the same conversation, and the 30-minute rule applies when it keeps
 * happening (provider-errors.ts).
 *
 * This is network-silence detection, not a cap: a call that sends data at all is never cut,
 * however long it lasts, and only the time spent waiting for the provider counts. Comment lines
 * and pings of an event stream are not data. `0` turns it off.
 */

export const STALL_SETTING = AGENTS_NUMBERS.modelStallSeconds.name;

/**
 * How long a model call's stream may be silent (ms), from THERMITE_MODEL_STALL_SECONDS: a number
 * of seconds, 600 when unset. Undefined: `0`, the detector is off.
 */
export function modelStallMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const s = readNumber(env, AGENTS_NUMBERS.modelStallSeconds);
  return s === 0 ? undefined : s * 1000;
}

/** A silence's length in seconds, as said: whole seconds, or tenths below ten. */
function seconds(ms: number): string {
  const s = ms / 1000;
  return String(s >= 10 ? Math.round(s) : Number(s.toFixed(1)));
}

/** What a silent stream says, in the provider's error and in Live. */
export function stallWords(ms: number): string {
  return `the model's stream went silent for ${seconds(ms)} s`;
}

const STALL_RE = /the model's stream went silent for (\d+(?:\.\d+)?) s/;

/** The seconds of silence an error's words name, when they are a silent stream's. */
export function stalledFor(text: string): string | undefined {
  return STALL_RE.exec(text)?.[1];
}

/** A silent stream, as an error: its message is stallWords. */
export class ModelStreamSilent extends Error {
  constructor(ms: number) {
    super(stallWords(ms));
    this.name = "ModelStreamSilent";
  }
}

/** A keep-alive line of an event stream: a comment, or a ping (Anthropic's `event: ping`). */
const KEEP_ALIVE = /^(?::|event:\s*ping\s*$|data:\s*\{\s*"type"\s*:\s*"ping"\s*\}\s*$)/;

/**
 * Tells data from keep-alives as an answer's bytes pass. In an event stream, data is a complete
 * line that is neither empty, a comment nor a ping; in any other answer, any byte is data.
 */
export class DataSeen {
  private readonly sse: boolean;
  private readonly decoder = new TextDecoder();
  /** The start of a line still arriving: enough to tell what kind of line it is. */
  private line = "";

  constructor(contentType: string | null | undefined) {
    this.sse = /text\/event-stream/i.test(contentType ?? "");
  }

  /** Whether this part of the answer holds data. */
  feed(chunk: Uint8Array): boolean {
    if (!this.sse) return chunk.length > 0;
    const parts = (this.line + this.decoder.decode(chunk, { stream: true })).split(/\r\n|\n|\r/);
    this.line = (parts.pop() ?? "").slice(0, 200);
    return parts.some((l) => l.length > 0 && !KEEP_ALIVE.test(l));
  }
}

/**
 * The answer a call gets when the provider sent nothing at all, not even its answer's headers,
 * for the time allowed: a 504, as a gateway answers when the server behind it does not, with the
 * words in OpenAI's and Anthropic's error shapes.
 */
function silentAnswer(ms: number): Response {
  return Response.json(
    { type: "error", error: { type: "model_stream_silent", message: stallWords(ms) } },
    { status: 504 },
  );
}

/**
 * A fetch that breaks a model call off when its stream goes silent for `ms`: no answer at all (a
 * 504 with stallWords), or no data in the answer (its body ends in a ModelStreamSilent error).
 * Only the time spent waiting for the provider counts: a reader that takes its time does not.
 * `onStall` is told each time, before the call ends.
 */
export function stallGuard(
  inner: typeof globalThis.fetch,
  ms: number,
  onStall?: ((ms: number) => void) | undefined,
): typeof globalThis.fetch {
  return async (input, init) => {
    // The call's own signal still ends it; this one also ends it when it goes silent.
    const ctrl = new AbortController();
    const outer = init?.signal ?? undefined;
    const follow = () => ctrl.abort(outer?.reason);
    if (outer?.aborted) follow();
    else outer?.addEventListener("abort", follow, { once: true });
    const finished = () => outer?.removeEventListener("abort", follow);
    const silent = () => {
      onStall?.(ms);
      ctrl.abort(new ModelStreamSilent(ms));
      finished();
    };
    const answer = inner(input, { ...init, signal: ctrl.signal });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const quiet = new Promise<"silent">((resolve) => {
      timer = setTimeout(() => resolve("silent"), ms);
    });
    let first: Response | "silent";
    try {
      first = await Promise.race([answer, quiet]);
    } catch (err) {
      finished();
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (first === "silent") {
      silent();
      // An answer that comes after all is not read.
      answer.then(
        (r) => r.body?.cancel().catch(() => undefined),
        () => undefined,
      );
      return silentAnswer(ms);
    }
    const res = first;
    if (!res.body) {
      finished();
      return res;
    }
    const reader = res.body.getReader();
    const data = new DataSeen(res.headers.get("content-type"));
    // Time spent waiting for the provider since its last data.
    let waited = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        const started = Date.now();
        let t: ReturnType<typeof setTimeout> | undefined;
        const left = new Promise<"silent">((resolve) => {
          t = setTimeout(() => resolve("silent"), Math.max(0, ms - waited));
        });
        try {
          const got = await Promise.race([reader.read(), left]);
          if (got === "silent") {
            silent();
            c.error(new ModelStreamSilent(ms));
            reader.cancel().catch(() => undefined);
            return;
          }
          if (got.done) {
            finished();
            c.close();
            return;
          }
          waited = data.feed(got.value) ? 0 : waited + (Date.now() - started);
          c.enqueue(got.value);
        } catch (err) {
          finished();
          c.error(err);
        } finally {
          clearTimeout(t);
        }
      },
      cancel(reason) {
        finished();
        return reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}

/** The log line of a silent stream: in the harness's log, a worker's or the supervisor's. */
export function logStall(ms: number, fields: Record<string, unknown> = {}): void {
  log("model", `${stallWords(ms)}: the call is broken off and retried`, fields);
}
