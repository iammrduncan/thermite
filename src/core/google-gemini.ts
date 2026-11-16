import { z } from "zod";

/**
 * Control's bridge to Google's Gemini API for a provider of type `google-gemini-api`: its path,
 * the one request it takes, the failures it answers with, and the rule that moves a rig's route
 * onto the address the rig reaches control at.
 *
 * A rig's route for such a provider is this bridge and a capability control made; the provider's
 * key stays in control. The bridge takes only native streamed content generation with text and
 * declared function tools: no address, no executable tool, no key and no billing option crosses it.
 */
export const GOOGLE_GEMINI_PATH = "/v1/google-gemini";

/** The largest request the bridge reads, in bytes. A larger one is refused before it is parsed. */
export const GOOGLE_BODY_BYTES = 4 * 1024 * 1024;

/** A provider's name as control keeps it, which is also its bridge's last path segment. */
export const GoogleName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
/** A model's id as Google's API names it, without `models/`. */
export const GoogleModel = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,199}$/);

/** The path of one provider's bridge on control. */
function googleBridgePath(provider: string): string {
  if (!GoogleName.safeParse(provider).success)
    throw new Error("A Gemini API route needs a provider name control keeps");
  return `${GOOGLE_GEMINI_PATH}/${provider}`;
}

/** An http(s) address with no credentials, query, fragment, whitespace or backslash, parsed. */
function plainAddress(address: string, what: string): URL {
  if (/[\s\\?#]/u.test(address))
    throw new Error(`${what} must not carry spaces, a backslash, a query or a fragment`);
  let u: URL;
  try {
    u = new URL(address);
  } catch {
    throw new Error(`${what} is not an address`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new Error(`${what} must be an http or https address`);
  if (u.username || u.password) throw new Error(`${what} must not carry credentials`);
  return u;
}

/**
 * One provider's bridge on control at `control`: control's address as its caller reaches it, with
 * any path prefix kept (control behind a sub-path) and trailing slashes dropped.
 */
export function googleBridgeBase(control: string, provider: string): string {
  const u = plainAddress(control, "Control's address");
  return `${u.origin}${u.pathname.replace(/\/+$/u, "")}${googleBridgePath(provider)}`;
}

/**
 * A Gemini API route moved onto `control`, the address its caller already reaches control at,
 * with the same provider's bridge and capability: control writes its own public address into the
 * route, which a rig need not be able to reach. Every other route comes back as it was, the same
 * object. A Gemini API route whose address is not control's bridge for its own provider is
 * refused, so a route can't carry its capability elsewhere. No `control`: the route as given.
 */
export function rebaseGoogleRoute<R extends { type?: unknown; name?: unknown; base_url?: unknown }>(
  route: R,
  control: string | undefined,
): R {
  if (route.type !== "google-gemini-api" || control === undefined) return route;
  if (typeof route.name !== "string" || typeof route.base_url !== "string")
    throw new Error("A Gemini API route needs its provider and its address");
  const given = plainAddress(route.base_url, "A Gemini API route's address");
  if (!given.pathname.replace(/\/+$/u, "").endsWith(googleBridgePath(route.name)))
    throw new Error("A Gemini API route's address is not control's bridge for its provider");
  return { ...route, base_url: googleBridgeBase(control, route.name) };
}

/**
 * The bridge's failures: each a status, Google's status word and fixed words of Thermite's own,
 * which a rig's agents sort by kind (the harness's provider errors). Google's words, the key and
 * the request never cross.
 *
 * The spend cap, a cap not yet set, an unreadable ledger, prices that need the owner's review and
 * Google's own "no credit" answer are a 402 in the words of no credits: nothing gets better by trying again, so the run's agents stop
 * and the run shows in Needs you, instead of calling every minute until the month ends. A model
 * without a price reads as a model this key does not serve, for the same reason.
 */
export const GOOGLE_BRIDGE_FAILURES = {
  cap: {
    status: 402,
    wire: "FAILED_PRECONDITION",
    message:
      "HTTP 402 payment required: Thermite's monthly spend cap for the Gemini API leaves no credits for this call. It opens again next month (UTC). No other provider is tried.",
  },
  no_cap: {
    status: 402,
    wire: "FAILED_PRECONDITION",
    message:
      "HTTP 402 payment required: no monthly spend cap is set for the Gemini API in Thermite, so no credits can be reserved for this call. No other provider is tried.",
  },
  credits: {
    status: 402,
    wire: "FAILED_PRECONDITION",
    message:
      "HTTP 402 payment required: Google reports no credits left for this Gemini API key's billing account.",
  },
  ledger: {
    status: 402,
    wire: "FAILED_PRECONDITION",
    message:
      "HTTP 402 payment required: Thermite's Gemini API spend ledger can't be read, so no credits can be reserved for this call.",
  },
  prices: {
    status: 402,
    wire: "FAILED_PRECONDITION",
    message:
      "HTTP 402 payment required: Thermite's Gemini API prices need the owner's review (they were last checked too long ago, or the raised prices can't be read), so no credits can be reserved for this call.",
  },
  unpriced: {
    status: 404,
    wire: "NOT_FOUND",
    message:
      "HTTP 404 MODEL_NOT_FOUND: Thermite has no dated price for this Gemini model, so it is not available on this key.",
  },
  route: {
    status: 404,
    wire: "NOT_FOUND",
    message: "HTTP 404 MODEL_NOT_FOUND: requested model is not available.",
  },
  auth: {
    status: 401,
    wire: "UNAUTHENTICATED",
    message: "HTTP 401: Google refused the Gemini API key.",
  },
  rate_limit: {
    status: 429,
    wire: "RESOURCE_EXHAUSTED",
    message: "HTTP 429 RESOURCE_EXHAUSTED: Gemini API rate limit; retry after 60 seconds.",
  },
  context: {
    status: 400,
    wire: "INVALID_ARGUMENT",
    message: "HTTP 400: context length exceeds the model window.",
  },
  request: {
    status: 400,
    wire: "INVALID_ARGUMENT",
    message: "HTTP 400 INVALID_ARGUMENT: Gemini request was refused.",
  },
  server: { status: 502, wire: "UNAVAILABLE", message: "HTTP 502: service unavailable." },
  timeout: { status: 504, wire: "DEADLINE_EXCEEDED", message: "HTTP 504: deadline exceeded." },
} as const;
export type GoogleBridgeFailure = keyof typeof GOOGLE_BRIDGE_FAILURES;

const jsonObject = z.record(z.string(), z.json());
const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/);
const callId = z.string().min(1).max(512).regex(/^\S+$/u);
const text = z.string().max(GOOGLE_BODY_BYTES);
const part = z.union([
  z.strictObject({ text, thought: z.boolean().optional(), thoughtSignature: text.optional() }),
  z.strictObject({
    functionCall: z.strictObject({ name, args: jsonObject, id: callId.optional() }),
    thoughtSignature: text.optional(),
  }),
  z.strictObject({
    functionResponse: z.strictObject({ name, response: jsonObject, id: callId.optional() }),
  }),
]);
const content = z.strictObject({
  role: z.enum(["user", "model"]).optional(),
  parts: z.array(part).min(1).max(1024),
});
/**
 * The one request the bridge takes: Google's native content request, kept to text, function calls
 * and their results, thought signatures and declared function tools. A field it does not name is
 * refused, which keeps out everything Google prices another way: audio and image input, cached
 * content, Google's own tools (search, maps, code execution, URL context) and service tiers.
 */
export const GoogleGenerateBody = z.strictObject({
  contents: z.array(content).min(1).max(2048),
  systemInstruction: content.optional(),
  tools: z
    .array(
      z.strictObject({
        functionDeclarations: z
          .array(
            z.strictObject({
              name,
              description: text.optional(),
              parameters: jsonObject.optional(),
              parametersJsonSchema: jsonObject.optional(),
            }),
          )
          .max(128),
      }),
    )
    .max(1)
    .optional(),
  toolConfig: z
    .strictObject({
      functionCallingConfig: z.strictObject({
        mode: z.enum(["AUTO", "ANY", "NONE", "VALIDATED"]),
        allowedFunctionNames: z.array(name).max(128).optional(),
      }),
    })
    .optional(),
  generationConfig: z
    .strictObject({
      temperature: z.number().finite().min(0).max(2).optional(),
      topP: z.number().finite().min(0).max(1).optional(),
      topK: z.number().int().min(1).max(1024).optional(),
      maxOutputTokens: z.number().int().min(1).max(1_000_000).optional(),
      stopSequences: z.array(z.string().max(1024)).max(16).optional(),
      candidateCount: z.literal(1).optional(),
      responseMimeType: z.enum(["text/plain", "application/json"]).optional(),
      responseSchema: jsonObject.optional(),
      responseJsonSchema: jsonObject.optional(),
      thinkingConfig: z
        .strictObject({
          includeThoughts: z.boolean().optional(),
          thinkingBudget: z.number().int().min(-1).max(1_000_000).optional(),
          thinkingLevel: z.enum(["MINIMAL", "LOW", "MEDIUM", "HIGH"]).optional(),
        })
        .optional(),
    })
    .optional(),
});
export type GoogleGenerateBody = z.infer<typeof GoogleGenerateBody>;
