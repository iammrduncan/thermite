import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { errorText } from "../../common/errors.ts";
import { chatgptRequest, chatgptRouteAllowed } from "./chatgpt.ts";
import type { ModelConfig } from "./index.ts";
import { DataSeen, ModelStreamSilent, modelStallMs, stallWords } from "./stall.ts";
import { type AnswerTokens, TokensSeen } from "./tokens.ts";

/**
 * One call through a key-adding model proxy: OpenCode and the Codex CLI reach a provider through
 * one, so the provider's key (or a ChatGPT sign-in's access token) never reaches them. The
 * harness's proxy (harness/api/proxy.ts) serves the agents; the supervisor serves one for each
 * call of an advisor in OpenCode or Codex (supervisor/advisors/proxy.ts). Whoever calls this has
 * checked the caller's credential; this adds the real key, keeps a ChatGPT sign-in to what OpenAI
 * accepts from one, and streams the answer back.
 */

/** Where a call goes: the route's API, its base address and the key at the time of the call. */
export interface ForwardTarget {
  api: ModelConfig["api"];
  baseUrl: string;
  key: string;
}

export interface ForwardCall {
  method: string;
  /** The path after the proxy's own prefix, for example `chat/completions`. */
  rest: string;
  /** The query string, with its `?`, or empty. */
  search: string;
  header(name: string): string | undefined;
  /** The request's body (none for GET and HEAD). */
  body: Buffer | undefined;
}

/** A provider's error answer, as the proxy saw it (goal 079). */
export interface ProviderErrorAnswer {
  status: number;
  /** The answer's headers, lowercase (Retry-After, the rate-limit resets). */
  headers: Record<string, string>;
  /** The answer's body, cut to 4,000 characters. */
  body: string;
}

/** How the proxy watches a call's stream for silence (goal 079). */
export interface ForwardStall {
  /** How long the provider may send no data (ms); undefined: never broken off. */
  ms: number | undefined;
  /** Told when a call is broken off for it, before it ends. */
  onStall?: ((ms: number) => void) | undefined;
}

/**
 * Forwards one call to the provider. `onError`: any error answer, with its status, headers and
 * body, for the harness to tell a rate limit's time, no credits or a refused key from the rest
 * (goal 079), and a full ChatGPT plan by OpenAI's code, which a program that keeps only an
 * error's message (the Codex CLI) would lose.
 *
 * A call whose stream sends no data for THERMITE_MODEL_STALL_SECONDS (stall.ts; `stall`
 * gives another time) is broken off: with no answer yet, the proxy answers 504 with the words, as
 * a gateway does; during the answer, it breaks the program's connection, which the program sees
 * as a broken connection. Either way `onError` gets a 504 with the words, so a trial whose
 * program then stops tells it as the provider's `server` error and goes on in the same session.
 *
 * `onTokens`: the tokens a successful answer reported (tokens.ts), once, when it ends, breaks off
 * or is cancelled; never for an answer that reported none.
 */
export async function forwardToProvider(
  call: ForwardCall,
  target: ForwardTarget,
  onError?: ((a: ProviderErrorAnswer) => void) | undefined,
  stall: ForwardStall = { ms: modelStallMs() },
  onTokens?: ((t: AnswerTokens) => void) | undefined,
): Promise<Response> {
  // A ChatGPT sign-in reaches only OpenAI's Responses API and the account's model list.
  const chatgpt = target.api === "chatgpt";
  if (chatgpt && !chatgptRouteAllowed(call.method, call.rest))
    return Response.json(
      { error: "a ChatGPT sign-in reaches only POST /responses and GET /models" },
      { status: 403 },
    );
  const url = new URL(`${target.baseUrl}/${call.rest}${call.search}`);
  const headers: Record<string, string> = {};
  for (const k of ["content-type", "accept", "anthropic-version", "anthropic-beta", "user-agent"]) {
    const v = call.header(k);
    if (v) headers[k] = v;
  }
  if (target.api === "anthropic") headers["x-api-key"] = target.key;
  else headers.authorization = `Bearer ${target.key}`;
  let body = call.body;
  if (body && chatgpt) {
    try {
      body = chatgptRequest(body);
    } catch (err) {
      return Response.json({ error: errorText(err) }, { status: 400 });
    }
  }
  if (body) headers["content-length"] = String(body.length);
  // node:http, not fetch: a long model call must not meet fetch's header timeout.
  return await new Promise<Response>((resolve) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    // The stream's silence (goal 079): armed until the answer's headers, then until each part of
    // the answer that holds data. Keep-alive comments and pings are not data.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const quiet = () => clearTimeout(timer);
    const arm = (silent: () => void) => {
      quiet();
      if (stall.ms !== undefined) timer = setTimeout(silent, stall.ms);
    };
    const silentBody = () =>
      JSON.stringify({
        type: "error",
        error: { type: "model_stream_silent", message: stallWords(stall.ms ?? 0) },
      });
    const brokeOff = () => {
      stall.onStall?.(stall.ms ?? 0);
      onError?.({ status: 504, headers: {}, body: silentBody() });
    };
    const req = send(url, { method: call.method, headers, agent: false }, (res) => {
      quiet();
      const status = res.statusCode ?? 502;
      const out = new Headers();
      for (const k of ["content-type", "cache-control"]) {
        const v = res.headers[k];
        if (typeof v === "string") out.set(k, v);
      }
      // An error answer is read whole (its body is small): OpenAI's code in a ChatGPT plan's
      // refusal says when the plan's usage is full, and any provider's status, headers and words
      // say what kind of error it is (goal 079). The answer goes on as it came.
      if (status >= 400) {
        const parts: Buffer[] = [];
        let size = 0;
        const silent = () => {
          brokeOff();
          res.destroy(new ModelStreamSilent(stall.ms ?? 0));
        };
        arm(silent);
        res.on("data", (d: Buffer) => {
          arm(silent);
          if (size >= 1024 * 1024) return;
          parts.push(d);
          size += d.length;
        });
        res.on("end", () => {
          quiet();
          const all = Buffer.concat(parts);
          const text = all.toString("utf8");
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers))
            if (typeof v === "string") headers[k.toLowerCase()] = v;
          onError?.({ status, headers, body: text.slice(0, 4000) });
          // Its rate-limit headers go on too, for a program that reads them itself.
          for (const k of ["retry-after", "retry-after-ms"]) {
            const v = headers[k];
            if (v) out.set(k, v);
          }
          resolve(new Response(new Uint8Array(all), { status, headers: out }));
        });
        res.on("error", (e) => {
          quiet();
          resolve(
            Response.json(
              { error: `the provider's answer broke off: ${e.message}` },
              { status: 502 },
            ),
          );
        });
        return;
      }
      const data = new DataSeen(res.headers["content-type"]);
      // The tokens the answer reports, told once however it ends.
      const seen = new TokensSeen();
      let told = false;
      const tell = () => {
        const t = seen.tokens();
        if (told || !t) return;
        told = true;
        onTokens?.(t);
      };
      const silent = () => {
        brokeOff();
        res.destroy(new ModelStreamSilent(stall.ms ?? 0));
      };
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          arm(silent);
          res.on("data", (d: Buffer) => {
            if (data.feed(d)) arm(silent);
            seen.feed(d);
            ctrl.enqueue(new Uint8Array(d));
          });
          res.on("end", () => {
            quiet();
            tell();
            ctrl.close();
          });
          // A silent stream ends here too: the program's connection is broken off.
          res.on("error", (e) => {
            quiet();
            tell();
            ctrl.error(e);
          });
        },
        cancel() {
          quiet();
          tell();
          res.destroy();
        },
      });
      resolve(new Response(stream, { status, headers: out }));
    });
    // No answer at all, not even its headers: a 504 with the words, as a gateway answers.
    arm(() => {
      brokeOff();
      resolve(
        new Response(silentBody(), {
          status: 504,
          headers: { "content-type": "application/json" },
        }),
      );
      req.destroy();
    });
    req.on("error", (e) => {
      quiet();
      resolve(
        Response.json(
          { error: `the provider could not be reached: ${e.message}` },
          { status: 502 },
        ),
      );
    });
    if (body) req.write(body);
    req.end();
  });
}
