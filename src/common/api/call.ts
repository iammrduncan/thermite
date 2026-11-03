import {
  type AnswerOf,
  type BodyOf,
  ErrorAnswer,
  pathOf,
  type Route,
  statusKind,
} from "../../core/api/route.ts";
import { errorText } from "../errors.ts";

/**
 * One call of a route of Thermite's own APIs (core/api/), for the clients beside this file: its
 * path filled in, its body sent as JSON or as bytes, its answer read with the route's schema, and
 * every failure an ApiError with a code to act on.
 */

/**
 * A call that failed. `code` is what a caller acts on: the answer's own code, the kind of its
 * status (core/api/route.ts), or what became of the call (unreachable, timeout, bad_answer).
 * The message is for people: the API, the route, the status and the answer's words.
 */
export class ApiError extends Error {
  override name = "ApiError";
  readonly code: string;
  /** The answer's HTTP status; undefined when no answer came. */
  readonly status: number | undefined;
  readonly url: string;
  /** The answer's body as it came: the command line prints it. */
  readonly text: string;
  /** The answer's body as JSON, when it was JSON: an error answer may carry fields to act on. */
  readonly answer: unknown;
  /** The answer's words for people: its `error`, or its first characters; or why none came. */
  readonly words: string;

  constructor(
    message: string,
    o: {
      code: string;
      status?: number;
      url: string;
      text?: string;
      answer?: unknown;
      words: string;
    },
  ) {
    super(message);
    this.code = o.code;
    this.status = o.status;
    this.url = o.url;
    this.text = o.text ?? "";
    this.answer = o.answer;
    this.words = o.words;
  }
}

/** Where a client's calls go, and with what. */
export interface ApiTarget {
  /** Whose API it is, in words for an error: "the harness's", "control's". */
  whose: string;
  url: string;
  token: string;
  /** Headers every call carries besides the token. */
  headers?: Record<string, string> | undefined;
  /** Path parameters every call fills, such as control's `rig` for a rig's own routes. */
  params?: Record<string, string> | undefined;
  /** How long a call may take, its answer read, before it ends as a `timeout`. */
  timeoutMs: number;
  fetchImpl?: typeof fetch | undefined;
}

/** What one call sends. */
export interface CallInput<R extends Route> {
  params?: Record<string, string | number> | undefined;
  /** Query parameters, in order; an undefined one is left out, and a list's values each repeat it. */
  query?: Record<string, string | number | boolean | readonly string[] | undefined> | undefined;
  /** The JSON body, as the route's schema takes it. */
  body?: BodyOf<R> | undefined;
  /** Bytes in place of a JSON body, sent as application/octet-stream. */
  bytes?: Uint8Array | undefined;
  /** This call's own time limit, in place of its client's: UPLOAD_TIMEOUT_MS for a large body. */
  timeoutMs?: number | undefined;
}

/**
 * The time limit of a call that sends a body of many megabytes (a kit's bundle, a champion's
 * patch, up to 64 MiB): 30 minutes, as a git call's, so a slow link still gets it there.
 */
export const UPLOAD_TIMEOUT_MS = 30 * 60_000;

/**
 * A query string, its parameters in order, an undefined one left out, a list given as the parameter
 * once for each value. A string's commas stay as they are: the receivers split lists at them.
 */
function queryOf(query: CallInput<Route>["query"]): string {
  const encode = (v: string) => encodeURIComponent(v).replace(/%2C/g, ",");
  const parts = Object.entries(query ?? {}).flatMap(([k, v]) =>
    v === undefined
      ? []
      : (typeof v === "object" ? v : [String(v)]).map((x) => `${encode(k)}=${encode(x)}`),
  );
  return parts.length ? `?${parts.join("&")}` : "";
}

/** The words of an error answer, for people: its `error`, or its first characters. */
function wordsOf(text: string, answer: unknown): string {
  const said = ErrorAnswer.safeParse(answer);
  return said.success && said.data.error ? said.data.error : text.slice(0, 300);
}

/** One call; its answer, as the route's schema reads it. */
export async function callRoute<R extends Route>(
  t: ApiTarget,
  route: R,
  input: CallInput<R> = {},
): Promise<AnswerOf<R>> {
  const path = pathOf(route, { ...t.params, ...input.params });
  const url = `${t.url}${path}${queryOf(input.query)}`;
  const what = `${t.whose} ${route.what ?? path}`;
  const headers: Record<string, string> = { ...t.headers };
  if (t.token) headers.authorization = `Bearer ${t.token}`;
  let body: string | Uint8Array | undefined;
  if (input.bytes !== undefined) {
    headers["content-type"] = "application/octet-stream";
    body = input.bytes;
  } else if (input.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(input.body);
  }
  const timeoutMs = input.timeoutMs ?? t.timeoutMs;
  let status: number;
  let text: string;
  try {
    const res = await (t.fetchImpl ?? fetch)(url, {
      method: route.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    text = await res.text();
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    const why = timedOut ? `no answer within ${timeoutMs / 1000} seconds` : errorText(err);
    const code = timedOut ? "timeout" : "unreachable";
    throw new ApiError(`${what}: ${why}`, { code, url, words: why });
  }
  let answer: unknown;
  try {
    answer = text ? JSON.parse(text) : undefined;
  } catch {
    answer = undefined;
  }
  if (status < 200 || status >= 300) {
    const own = ErrorAnswer.safeParse(answer);
    const code = own.success && own.data.code ? own.data.code : statusKind(status);
    const words = wordsOf(text, answer);
    throw new ApiError(`${what}: HTTP ${status}: ${words}`, {
      code,
      status,
      url,
      text,
      answer,
      words,
    });
  }
  // Checked, not rewritten: the answer goes on as it came (core/api/route.ts).
  if (!route.answer.safeParse(answer).success)
    throw new ApiError(`${what}: its answer is not what the route gives: ${text.slice(0, 200)}`, {
      code: "bad_answer",
      status,
      url,
      text,
      answer,
      words: "its answer is not what the route gives",
    });
  return answer as AnswerOf<R>;
}
