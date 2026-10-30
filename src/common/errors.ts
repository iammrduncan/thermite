import { randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * Thermite's typed errors (CONVENTIONS.md, "Shared tools, errors, settings and timeouts"): a small
 * set, each answered the same way by every API through answerOf.
 */

/** A request Thermite won't do as asked, for a reason in plain words: answered 409. */
export class Refusal extends Error {
  override name = "Refusal";
}

/** A request whose input is wrong (not JSON, or not what its schema takes): answered 400. */
export class BadInput extends Error {
  override name = "BadInput";
}

/** An error's words: its message, or what was thrown, as text. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * An error as an API answers it: the HTTP status and the words. Any other error is a fault, a
 * 500, whose own words stay in the part's output (faultAnswer).
 */
export function answerOf(err: unknown): { status: 400 | 409 | 500; error: string } {
  if (err instanceof z.ZodError) return { status: 400, error: "invalid request" };
  if (err instanceof BadInput) return { status: 400, error: err.message };
  if (err instanceof Refusal) return { status: 409, error: err.message };
  return { status: 500, error: "internal error" };
}

/**
 * What an API answers for a fault: `internal error <id>`, with a new id that the part's log line
 * of the fault carries too, so the caller can name it and nothing more of it leaves the part.
 */
export function faultAnswer(): { id: string; error: string } {
  const id = randomBytes(4).toString("hex");
  return { id, error: `internal error ${id}` };
}

/** A request's JSON body; BadInput when the body is not JSON. */
export async function jsonBody(req: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new BadInput("the request's body is not JSON");
  }
}
