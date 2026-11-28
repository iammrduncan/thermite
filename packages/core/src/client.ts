import type { z } from "zod";
import type * as A from "./api/index.ts";
import { getCoreAction } from "./api/index.ts";
import * as E from "./errors.ts";

type Z = z.ZodType;
export type ThermiteClientOptions = {
  readonly baseUrl: string;
  readonly token?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: typeof globalThis.fetch;
};
export type CallOptions = {
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
};
export type ThermiteClient = {
  call<K extends A.CoreActionName>(
    name: K,
    input: A.InputOf<K>,
    opts?: CallOptions,
  ): Promise<A.OutputOf<K>>;
  callAction<N extends string, I extends Z, O extends Z>(
    def: A.ActionDef<N, I, O>,
    input: z.input<I>,
    opts?: CallOptions,
  ): Promise<z.output<O>>;
};

const PARAM_RE = /:([A-Za-z_][A-Za-z0-9_]*)/g;
const toRec = (v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const fail = (code: E.ThermiteErrorCode, msg: string, issues?: unknown): never => {
  throw new E.ThermiteError(code, msg, issues ? { issues } : undefined);
};

function buildQuery(rem: Record<string, unknown>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(rem)) {
    if (v === undefined) continue;
    for (const x of Array.isArray(v) ? v : [v]) {
      if (x !== undefined)
        qs.append(k, typeof x === "object" && x !== null ? JSON.stringify(x) : String(x));
    }
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

function mapHttpError(status: number, action: string, body: unknown): E.ThermiteError {
  const root = toRec(body);
  const err = typeof root.error === "object" && root.error !== null ? toRec(root.error) : root;
  const hit = Object.entries(E.ERROR_HTTP_STATUS).find(([, s]) => s === status)?.[0];
  const fallback: E.ThermiteErrorCode =
    status === 422 ? "VALIDATION_ERROR" : ((hit as E.ThermiteErrorCode | undefined) ?? "INTERNAL");
  const code = E.isThermiteErrorCode(err.code) ? err.code : fallback;
  const msg =
    typeof err.message === "string" && err.message ? err.message : `HTTP ${status} (${action}).`;
  return new E.ThermiteError(code, msg, err.details);
}

export function createThermiteClient(options: ThermiteClientOptions): ThermiteClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;

  async function invoke<T>(def: A.AnyActionDef, input: unknown, opts?: CallOptions): Promise<T> {
    const pIn = def.input.safeParse(input);
    if (!pIn.success) fail("VALIDATION_ERROR", `Invalid input: "${def.name}".`, pIn.error.issues);
    const fields = toRec(pIn.data);
    const used = new Set<string>();
    const path = def.http.path.replace(PARAM_RE, (_m, k: string) => {
      if (fields[k] === undefined || fields[k] === null)
        fail("VALIDATION_ERROR", `Missing param "${k}".`);
      used.add(k);
      return encodeURIComponent(String(fields[k]));
    });
    const rem = Object.fromEntries(
      Object.entries(fields).filter(([k, v]) => !used.has(k) && v !== undefined),
    );
    const isQuery = def.http.method === "GET" || def.http.method === "DELETE";
    const headers: Record<string, string> = {
      accept: "application/json",
      ...options.headers,
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...opts?.headers,
      ...(!isQuery ? { "content-type": "application/json" } : {}),
    };
    const res = await fetchImpl(`${baseUrl}${path}${isQuery ? buildQuery(rem) : ""}`, {
      method: def.http.method,
      headers,
      ...(!isQuery ? { body: JSON.stringify(rem) } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    const text = await res.text();
    let payload: unknown;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: text };
      }
    }
    if (!res.ok) throw mapHttpError(res.status, def.name, payload);
    const out = def.output.safeParse(payload);
    if (!out.success) fail("INTERNAL", `Invalid response: "${def.name}".`, out.error.issues);
    return out.data as T;
  }

  return {
    call: (n, i, o) => invoke(getCoreAction(n) as A.AnyActionDef, i, o),
    callAction: (d, i, o) => invoke(d as A.AnyActionDef, i, o),
  };
}
