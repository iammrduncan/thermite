import { GeminiApiError, geminiStatusFailure } from "./errors.ts";

/**
 * Control's calls to Google's Gemini API with an owner's key: a streamed content call and the
 * model list. The address is fixed here: no setting, provider row or request changes where the
 * key is sent. A redirect is not followed, so the key reaches no other host.
 */

/** Google's Gemini API: its native content methods and its model list. */
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";

/**
 * How long a content call may send nothing, before its first byte and between two chunks. A call
 * silent for longer is broken off, and counted as one whose cost is not known.
 */
const SILENCE_MS = 120_000;
/** The largest answer one content call may stream, in bytes. A larger one is broken off. */
const ANSWER_BYTES = 16 * 1024 * 1024;
/** How long the model list may take, in all. */
const LIST_MS = 15_000;
/** The list's pages read at most, and each page's size in bytes at most. */
const LIST_PAGES = 5;
const LIST_BYTES = 4 * 1024 * 1024;
/** An error answer's body read at most, to name the failure. */
const ERROR_BYTES = 64 * 1024;

/**
 * System codes of a connection that was never made: the request did not leave, so it cost
 * nothing. Any other failure before an answer may have reached Google.
 */
const NEVER_SENT = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

const neverSent = (error: unknown): boolean => {
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" && NEVER_SENT.has(code);
};

/** Reads at most `limit` bytes of an answer's body as text; "" when it has none or is larger. */
async function boundedText(res: Response, limit: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) return "";
      parts.push(value);
    }
  } catch {
    return "";
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(parts).toString("utf8");
}

/** The failure an error answer is; its body is read only for a refused request's kind. */
async function answerFailure(res: Response): Promise<GeminiApiError> {
  let message = "";
  if (res.status === 400 || res.status === 413 || res.status === 422) {
    try {
      const parsed = JSON.parse(await boundedText(res, ERROR_BYTES)) as {
        error?: { message?: unknown };
      };
      if (typeof parsed.error?.message === "string") message = parsed.error.message;
    } catch {
      message = "";
    }
  } else await res.body?.cancel().catch(() => undefined);
  // Google's billing page says a request that fails with a 400 or a 500 error is not charged
  // for its tokens. No other status is proof that nothing was generated and billed: a gateway
  // timeout, a rate limit and a redirect keep the whole reservation.
  return new GeminiApiError(
    geminiStatusFailure(res.status, message),
    res.status === 400 || res.status === 500 ? "no" : "unknown",
  );
}

/**
 * One streamed content call: each object of Google's event stream, in order, as it arrives. It
 * ends when the stream does. It throws a GeminiApiError: `billed` "no" for a connection never
 * made and for the two statuses Google documents as not charged (400 and 500), "unknown" for
 * any other status and for a stream that broke, went silent for SILENCE_MS, passed ANSWER_BYTES
 * or was not Google's event stream. `signal` breaks it off.
 */
export async function* geminiStream(
  fetchImpl: typeof fetch,
  key: string,
  model: string,
  body: Uint8Array,
  signal: AbortSignal,
): AsyncGenerator<Record<string, unknown>, void, undefined> {
  const upstream = new AbortController();
  const abort = () => upstream.abort();
  signal.addEventListener("abort", abort, { once: true });
  let silent = false;
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      silent = true;
      upstream.abort();
    }, SILENCE_MS);
  };
  try {
    if (signal.aborted) throw new GeminiApiError("timeout", "no");
    arm();
    let res: Response;
    try {
      res = await fetchImpl(
        `${GEMINI_API}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": key },
          body,
          redirect: "manual",
          signal: upstream.signal,
        },
      );
    } catch (error) {
      if (neverSent(error)) throw new GeminiApiError("server", "no");
      throw new GeminiApiError(silent || signal.aborted ? "timeout" : "server", "unknown");
    }
    if (res.status !== 200) {
      if (res.status >= 300) throw await answerFailure(res);
      await res.body?.cancel().catch(() => undefined);
      throw new GeminiApiError("server", "unknown");
    }
    const reader = res.body?.getReader();
    if (!reader) throw new GeminiApiError("server", "unknown");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = "";
    let data: string[] = [];
    let size = 0;
    try {
      while (true) {
        arm();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > ANSWER_BYTES) throw new GeminiApiError("server", "unknown");
        pending += decoder.decode(value, { stream: true });
        let end = pending.indexOf("\n");
        while (end >= 0) {
          const line = pending.slice(0, end).replace(/\r$/u, "");
          pending = pending.slice(end + 1);
          if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /u, ""));
          else if (line === "" && data.length) {
            const parsed: unknown = JSON.parse(data.join("\n"));
            data = [];
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
              throw new GeminiApiError("server", "unknown");
            // An error inside the stream: its words stay here.
            if ("error" in parsed) throw new GeminiApiError("server", "unknown");
            yield parsed as Record<string, unknown>;
          }
          end = pending.indexOf("\n");
        }
      }
      // A stream that ends inside an event did not finish.
      if (data.length || pending.trim()) throw new GeminiApiError("server", "unknown");
    } catch (error) {
      if (error instanceof GeminiApiError) throw error;
      throw new GeminiApiError(silent || signal.aborted ? "timeout" : "server", "unknown");
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    upstream.abort();
  }
}

/** A model as Google's list gives it: its id and the most input tokens it takes. */
interface GeminiListed {
  id: string;
  inputLimit: number | undefined;
}

/**
 * The models the key's project may call for content, from Google's model list: no content
 * request, and no charge. It throws a GeminiApiError in Thermite's words.
 */
export async function geminiModels(fetchImpl: typeof fetch, key: string): Promise<GeminiListed[]> {
  const signal = AbortSignal.timeout(LIST_MS);
  const out: GeminiListed[] = [];
  let token: string | undefined;
  for (let page = 0; page < LIST_PAGES; page++) {
    let res: Response;
    try {
      res = await fetchImpl(
        `${GEMINI_API}/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`,
        { headers: { "x-goog-api-key": key }, redirect: "manual", signal },
      );
    } catch {
      throw new GeminiApiError(signal.aborted ? "timeout" : "server", "no");
    }
    if (res.status !== 200) {
      if (res.status >= 300) throw await answerFailure(res);
      await res.body?.cancel().catch(() => undefined);
      throw new GeminiApiError("server", "no");
    }
    let listed: { models?: unknown; nextPageToken?: unknown };
    try {
      listed = JSON.parse(await boundedText(res, LIST_BYTES)) as typeof listed;
    } catch {
      throw new GeminiApiError("server", "no");
    }
    for (const m of Array.isArray(listed.models) ? listed.models : []) {
      const row = m as {
        name?: unknown;
        inputTokenLimit?: unknown;
        supportedGenerationMethods?: unknown;
      } | null;
      const id = typeof row?.name === "string" ? row.name.replace(/^models\//u, "") : "";
      const methods = Array.isArray(row?.supportedGenerationMethods)
        ? row.supportedGenerationMethods
        : [];
      if (!/^[a-z0-9][a-z0-9._-]{0,199}$/u.test(id) || !methods.includes("generateContent"))
        continue;
      const limit = row?.inputTokenLimit;
      out.push({
        id,
        inputLimit:
          typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? limit : undefined,
      });
    }
    if (typeof listed.nextPageToken !== "string" || !listed.nextPageToken) return out;
    token = listed.nextPageToken;
  }
  return out;
}
