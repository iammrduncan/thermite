import { GOOGLE_BRIDGE_FAILURES, type GoogleBridgeFailure } from "../../../core/google-gemini.ts";

/**
 * A failed call, in the bridge's fixed words (core GOOGLE_BRIDGE_FAILURES). `billed` says what
 * the ledger does with its reservation: "no" when the call is known to have cost nothing (control
 * refused it, it never left, or Google answered it with a status it documents as not charged),
 * "unknown" for every other end, which keeps the whole reservation.
 */
export class GeminiApiError extends Error {
  readonly reason: GoogleBridgeFailure;
  readonly status: (typeof GOOGLE_BRIDGE_FAILURES)[GoogleBridgeFailure]["status"];
  readonly wire: (typeof GOOGLE_BRIDGE_FAILURES)[GoogleBridgeFailure]["wire"];
  readonly billed: "no" | "unknown";
  constructor(reason: GoogleBridgeFailure, billed: "no" | "unknown") {
    super(GOOGLE_BRIDGE_FAILURES[reason].message);
    this.reason = reason;
    this.status = GOOGLE_BRIDGE_FAILURES[reason].status;
    this.wire = GOOGLE_BRIDGE_FAILURES[reason].wire;
    this.billed = billed;
  }
}

/** Google's words for a prompt longer than the model's window, read only to name the failure. */
const CONTEXT =
  /(?:context(?:[_ ](?:length|window))?|prompt|input|tokens?).{0,160}(?:exceed|too (?:long|large)|maximum|limit)|(?:exceed|maximum).{0,160}(?:context|prompt|input|tokens?)|too many tokens/iu;

/**
 * The failure an error status from Google is, from the status and, for a refused request, whether
 * Google's message speaks of the prompt's length. The message itself goes no further.
 */
export function geminiStatusFailure(status: number, message: string): GoogleBridgeFailure {
  if (status === 402) return "credits";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "route";
  if (status === 429) return "rate_limit";
  if (status === 408 || status === 504) return "timeout";
  if (status === 400 || status === 413 || status === 422)
    return CONTEXT.test(message.slice(0, 2048)) ? "context" : "request";
  return "server";
}
