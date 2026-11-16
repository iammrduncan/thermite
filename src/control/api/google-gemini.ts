import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  GOOGLE_BODY_BYTES,
  GOOGLE_BRIDGE_FAILURES,
  GOOGLE_GEMINI_PATH,
  GoogleGenerateBody,
  GoogleModel,
  GoogleName,
} from "../../core/google-gemini.ts";
import type { ControlParts } from "../parts.ts";
import { GeminiApiError } from "../providers/index.ts";

/**
 * Control's bridge to Google's Gemini API for a rig's agents: native streamed content generation
 * for a capability control gave the rig, with the provider's key, under the owner's spend cap.
 * It is never a general proxy to Google or to anywhere else: one method, one checked body, and an
 * address fixed in control. A failed call is answered as failed: no other provider, key or route
 * is tried.
 *
 * The rig's token for control does not open it, and neither does an owner's session: only the
 * provider's own capability does.
 */
export function googleGeminiRoutes(app: Hono, parts: ControlParts): void {
  const path = `${GOOGLE_GEMINI_PATH}/:provider/models/:action`;
  app.post(path, bodyLimit({ maxSize: GOOGLE_BODY_BYTES }), async (c) => {
    const provider = GoogleName.safeParse(c.req.param("provider"));
    const action = /^(.*):streamGenerateContent$/u.exec(c.req.param("action"));
    const model = GoogleModel.safeParse(action?.[1]);
    const params = new URL(c.req.url).searchParams;
    if (
      !provider.success ||
      !model.success ||
      params.get("alt") !== "sse" ||
      [...params.keys()].some((key) => key !== "alt") ||
      params.getAll("alt").length !== 1
    )
      return c.json(
        { error: { code: 400, message: "Only native streaming content generation is supported" } },
        400,
      );
    // Pi's native Google adapter sends its key in x-goog-api-key: here that is the bridge's
    // capability, never Google's key. No query credential is accepted, so no address carries one.
    const capability = c.req.header("x-goog-api-key") ?? "";
    const p = parts.geminiApi.authorized(provider.data, capability);
    if (!p)
      return c.json({ error: { code: 401, message: "Gemini API bridge capability refused" } }, 401);
    const parsed = GoogleGenerateBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success)
      return c.json({ error: { code: 400, message: "Unsupported native Gemini request" } }, 400);
    const controller = new AbortController();
    const abort = () => controller.abort();
    c.req.raw.signal.addEventListener("abort", abort, { once: true });
    if (c.req.raw.signal.aborted) controller.abort();
    const iterator = parts.geminiApi.generate(p, model.data, parsed.data, controller.signal);
    try {
      // A refusal (the cap, a rate limit, a key Google refuses) must be its HTTP status, before
      // the stream's headers, rather than an empty stream that looks like success.
      let first = await iterator.next();
      if (first.done) throw new GeminiApiError("server", "unknown");
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async pull(stream) {
          try {
            const next = first;
            if (next.done) {
              c.req.raw.signal.removeEventListener("abort", abort);
              stream.close();
              return;
            }
            stream.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`));
            first = await iterator.next();
          } catch {
            controller.abort();
            c.req.raw.signal.removeEventListener("abort", abort);
            stream.error(new Error("The Gemini API stream ended before completion"));
          }
        },
        async cancel() {
          controller.abort();
          c.req.raw.signal.removeEventListener("abort", abort);
          await iterator.return(undefined);
        },
      });
      return new Response(body, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          "x-accel-buffering": "no",
        },
      });
    } catch (e) {
      controller.abort();
      c.req.raw.signal.removeEventListener("abort", abort);
      // Each kind of failure has fixed words (core GOOGLE_BRIDGE_FAILURES); anything else is the
      // server's failure in the same words, so nothing of the error itself crosses.
      const failure =
        e instanceof GeminiApiError
          ? GOOGLE_BRIDGE_FAILURES[e.reason]
          : GOOGLE_BRIDGE_FAILURES.server;
      if (failure.status === 429) c.header("retry-after", "60");
      return c.json(
        { error: { code: failure.status, status: failure.wire, message: failure.message } },
        failure.status,
      );
    }
  });
}
