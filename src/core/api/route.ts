import { z } from "zod";

/**
 * The shape of a route between Thermite's parts (CONVENTIONS.md: a wire contract has one home).
 * Each API's contract (harness/, control/ beside this file) names its routes this way, and both
 * sides import them: the receiver routes and parses with the route, the sender builds its body's
 * input type, and the clients in common/api/ call it.
 */

export type Method = "GET" | "POST" | "PUT" | "DELETE";

export interface Route {
  method: Method;
  /** The path, with `:name` for each parameter, as the receiver's router takes it. */
  path: string;
  /** What the route serves, in words for people: errors name it so. None: its path. */
  what?: string;
  /** The JSON body's schema. None: the route takes no JSON body (bytes, or nothing). */
  body?: z.ZodType;
  /**
   * The answer's schema: what callers read of it, checked and never rewritten. The answer goes
   * on as it came, every field in its order (an advisor reads its brief in order), a field the
   * schema does not name included, so a newer receiver's answer still reads.
   */
  answer: z.ZodType;
  /** The largest body the receiver takes, in bytes. */
  maxBytes?: number;
}

/** What a caller sends: the input type of the route's body. */
export type BodyOf<R extends Route> = R["body"] extends z.ZodType ? z.input<R["body"]> : never;

/** What a caller reads: the route's answer as it came, which its schema took. */
export type AnswerOf<R extends Route> = z.input<R["answer"]>;

/** A route's path with its parameters filled in, each encoded. Throws on one not given. */
export function pathOf(route: Pick<Route, "path">, params: Record<string, string | number> = {}) {
  return route.path.replace(/:([a-z_]+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`${route.path} needs its ${name}`);
    return encodeURIComponent(String(value));
  });
}

/**
 * Why a call failed, as a caller acts on it: the answer's own code, where the receiver names one
 * (only where one status means two things to a caller; each contract names those), else the kind
 * of its HTTP status, else what became of the call itself.
 */
export const STATUS_KINDS = {
  400: "bad_input",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "refused",
  413: "too_large",
  422: "unprocessable",
  503: "unavailable",
} as const;

/** What became of a call that got no answer to read: none came, in time or at all, or no JSON. */
export const CALL_FAILURES = ["unreachable", "timeout", "bad_answer"] as const;

/** An error's kind from an answer's status, for an answer that names no code of its own. */
export function statusKind(status: number): string {
  return STATUS_KINDS[status as keyof typeof STATUS_KINDS] ?? (status >= 500 ? "server" : "other");
}

/** An error answer: its words for people, and its code where a caller acts on it. */
export const ErrorAnswer = z.looseObject({
  error: z.string().optional(),
  code: z.string().max(64).optional(),
});
