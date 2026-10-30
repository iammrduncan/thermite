import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  type ControlOptions,
  type ControlTokens,
  createControlApi,
} from "../../src/control/api/index.ts";
import { mountDashboard } from "../../src/control/dashboard/index.ts";
import type { ControlStore } from "../../src/control/store/index.ts";
import { generateSigningKeys, type KeyPairPem } from "../../src/core/commands.ts";
import { createHarnessApi } from "../../src/harness/api/index.ts";
import type { HarnessService } from "../../src/harness/service/index.ts";
import { type RelayState, relayOnce } from "../../src/supervisor/relay/index.ts";
import { applied, controlStore, enrollRigs } from "./control-store.ts";
import { makeJudgeEnv } from "./judge-env.ts";

/**
 * Control's tests' one stack (goal 125, T10): control, a rig's harness and the supervisor's relay
 * between them, all in this process; a dashboard session; and an MCP client. A test asks for what
 * it needs, and a change to how control is made changes this file, not every test. Control's store
 * is on a fake message bus, as control needs one (control-store.ts).
 */

/** The owner's token, and the rig's and the supervisor's, as the tests use them. */
export const ADMIN = "admin-token-abcdef";
export const RIG_TOKEN = "rig-token-abcdef";
export const SUPERVISOR_TOKEN = "sup-token-abcdef";

const FORM = "application/x-www-form-urlencoded";

/** Control's or the harness's API, answering requests in this process. */
export interface Requester {
  request(path: string, init?: RequestInit): Response | Promise<Response>;
}

/** A form's fields: by name, as pairs (a name may come twice), or as a browser's. */
export type Form = Record<string, string> | [string, string][] | URLSearchParams;

/**
 * A dashboard session signed in with `token`: the sign-in's own response, its cookie, a page's
 * response or text, the CSRF token a page carries, and a form posted as a browser posts it
 * without the page's script (`headers` adds to that, such as `accept: application/json`).
 */
export async function signIn(control: Requester, token = ADMIN) {
  const login = await control.request("/ui/login", {
    method: "POST",
    body: new URLSearchParams({ token }),
    headers: { "content-type": FORM },
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const get = async (path: string) => await control.request(path, { headers: { cookie } });
  const page = async (path: string) => (await get(path)).text();
  const csrfOf = (html: string) => /name="csrf" value="([0-9a-f]+)"/.exec(html)?.[1] ?? "";
  const post = async (path: string, form: Form, headers: Record<string, string> = {}) =>
    await control.request(path, {
      method: "POST",
      body: new URLSearchParams(form),
      headers: { cookie, "content-type": FORM, ...headers },
    });
  return { login, cookie, get, page, csrfOf, post };
}

/** An MCP client of control's, in this process, calling with `token`. */
export async function mcpClient(control: Requester, token = ADMIN): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    return await control.request(`${url.pathname}${url.search}`, { ...init, headers });
  };
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://control/mcp"), { fetch: fetchImpl }),
  );
  return client;
}

/** Control's options, or a function that makes them once the store and the keys exist. */
type Options =
  | Partial<ControlOptions>
  | ((store: ControlStore, keys: { privateKeyPem: string }) => Partial<ControlOptions>);

/**
 * Control's tokens in a test: the owner's and the others' as control takes them, and `rigs`, each
 * rig enrolled with control with the token it reports with (enrollRigs): rig-a with RIG_TOKEN
 * unless given.
 */
export type TestTokens = Partial<ControlTokens> & { rigs?: Record<string, string> };

/** Control on `store` with `options`, signing with `privateKeyPem`, and a call to its REST API. */
function makeControl(
  store: ControlStore,
  given: TestTokens | undefined,
  keys: { privateKeyPem: string },
  options: Options | undefined,
) {
  const { rigs = { "rig-a": RIG_TOKEN }, ...own } = given ?? {};
  enrollRigs(store, rigs);
  const tokens: ControlTokens = { admin: ADMIN, ...own };
  const opts = typeof options === "function" ? options(store, keys) : options;
  const control = createControlApi(store, tokens, keys.privateKeyPem, {
    staleAfterMs: 180_000,
    pages: mountDashboard,
    ...opts,
  });
  const owner = typeof tokens.admin === "string" ? tokens.admin : ADMIN;
  /** A call to control's REST API with `token`, the owner's unless given. */
  const api = async (method: string, path: string, body?: unknown, token = owner) =>
    await control.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { tokens, control, api };
}

/**
 * Control alone, with no rig's harness: a fresh signing key unless given one (control started
 * again over the same store keeps its key), an in-memory store on a fake bus unless given one (a
 * test that fills the store before control starts makes it first, with controlStore()), and
 * `api()` as below.
 */
export function controlOnly(
  o: { tokens?: TestTokens; options?: Options; store?: ControlStore; keys?: KeyPairPem } = {},
) {
  const store = o.store ?? controlStore();
  const keys = o.keys ?? generateSigningKeys();
  return { store, keys, ...makeControl(store, o.tokens, keys, o.options) };
}

/** A rig's harness for the stack: its service and the key that signs its commands. */
interface RigEnv {
  service: HarnessService;
  keys: { privateKeyPem: string };
}

/**
 * Control with one rig, `rig-a`, whose harness is `env`'s (a judge env unless given), and the
 * supervisor's relay between them. `relay()` runs rounds of it: the rig's report, then control's
 * pending commands; each round ends once control applied the events it took from the events
 * stream. `api()` calls control's REST API with the owner's token unless given another.
 */
export function controlStack<E extends RigEnv = ReturnType<typeof makeJudgeEnv>>(
  o: { env?: E; tokens?: TestTokens; options?: Options } = {},
) {
  const env = (o.env ?? makeJudgeEnv()) as E;
  const store = controlStore();
  const { tokens, control, api } = makeControl(store, o.tokens, env.keys, o.options);
  const harness = createHarnessApi(env.service, { supervisor: SUPERVISOR_TOKEN });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    return await (url.host === "harness" ? harness : control).request(
      `${url.pathname}${url.search}`,
      init as RequestInit,
    );
  };
  const cfg = {
    rig: "rig-a",
    harnessUrl: "http://harness",
    harnessToken: SUPERVISOR_TOKEN,
    controlUrl: "http://control",
    controlToken: RIG_TOKEN,
    fetchImpl,
  };
  let state: RelayState = { cursor: 0 };
  const relay = async (rounds = 1): Promise<RelayState> => {
    for (let i = 0; i < rounds; i++) {
      state = await relayOnce(cfg, state);
      await applied(store);
    }
    return state;
  };
  return { env, store, tokens, control, harness, fetchImpl, cfg, relay, api };
}
