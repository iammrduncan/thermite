import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildInfo } from "../../src/common/build-info.ts";
import {
  type ControlOptions,
  type ControlTokens,
  createControlApi,
} from "../../src/control/api/index.ts";
import { configValueOf, serveRigAsks } from "../../src/control/bus/index.ts";
import { mountDashboard } from "../../src/control/dashboard/index.ts";
import { foldReport } from "../../src/control/ingest.ts";
import { sendCommandsOn } from "../../src/control/issue/index.ts";
import { foldLive, LiveTaken } from "../../src/control/live/index.ts";
import { controlParts } from "../../src/control/parts.ts";
import type { ControlStore } from "../../src/control/store/index.ts";
import { generateSigningKeys, type KeyPairPem } from "../../src/core/commands.ts";
import { commandSubject } from "../../src/core/link/commands.ts";
import type { ConfigKey } from "../../src/core/link/config.ts";
import { LIVE_CONSUMER_CONFIG, LIVE_STREAM_CONFIG } from "../../src/core/link/live.ts";
import { REPORT_CONSUMER_CONFIG, REPORT_STREAM_CONFIG } from "../../src/core/link/report.ts";
import { rigInboxPrefix } from "../../src/core/link/users.ts";
import { createHarnessApi } from "../../src/harness/api/index.ts";
import type { HarnessService } from "../../src/harness/service/index.ts";
import { ask } from "../../src/supervisor/ask.ts";
import {
  LiveCounts,
  type LiveRelayState,
  publishLiveOnce,
  supervisorLive,
} from "../../src/supervisor/live/index.ts";
import { takeCommand } from "../../src/supervisor/relay/commands.ts";
import {
  healCursor,
  type RelayConfig,
  RelayError,
  type RelayState,
  relayOnce,
} from "../../src/supervisor/relay/index.ts";
import { TEST_BUS_CA } from "./bus-ca.ts";
import { applied, busOf, controlStore, enrollRigs } from "./control-store.ts";
import { settle } from "./fake-bus.ts";
import { makeJudgeEnv } from "./judge-env.ts";

/**
 * Control's tests' one stack (goal 125, T10): control, a rig's harness and the supervisor's relay
 * between them on a fake message bus, all in this process; a dashboard session; and an MCP
 * client. A test asks for what it needs, and a change to how control is made changes this file,
 * not every test. Control's store is on the fake bus (control-store.ts), and the rig reaches
 * control only there, as a rig does.
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

/** The message bus as the rigs control sets up reach it, with control's authority. */
export const TEST_RIG_BUS = { url: "nats://control.example.com:4222", ca: TEST_BUS_CA };

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
  // The rigs control sets up reach its bus here unless a test says otherwise (`rigBus`).
  const made = { staleAfterMs: 180_000, pages: mountDashboard, rigBus: TEST_RIG_BUS, ...opts };
  // Control's parts, made here as the API would, so a test reads what a rig's config holds.
  const parts =
    made.parts ??
    controlParts(store, keys.privateKeyPem, made, {
      staleAfterMs: made.staleAfterMs,
      offlineAfterMs: made.offlineAfterMs,
      control: made.build ?? buildInfo(),
    });
  const control = createControlApi(store, tokens, keys.privateKeyPem, { ...made, parts });
  /**
   * What control writes to a rig's config on the bus for `key` now, before it is sealed
   * (bus/config.ts): what the rig's supervisor gets there.
   */
  const rigConfig = async (key: ConfigKey, rig = "rig-a") =>
    (await configValueOf(parts, rig, key)) as Record<string, Record<string, unknown> | null>;
  const owner = typeof tokens.admin === "string" ? tokens.admin : ADMIN;
  /** A call to control's REST API with `token`, the owner's unless given. */
  const api = async (method: string, path: string, body?: unknown, token = owner) =>
    await control.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { tokens, control, api, opts, parts, rigConfig };
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
 * supervisor's relay between them on the store's fake bus: control publishes its commands there
 * and answers the rig's asks there. `relay()` runs rounds of it: the rig's report, folded by
 * control; the rig's commands, delivered to its harness; then the report again, which carries
 * their outcomes; each round ends once control applied the events it took. `api()` calls
 * control's REST API with the owner's token unless given another.
 */
export function controlStack<E extends RigEnv = ReturnType<typeof makeJudgeEnv>>(
  o: { env?: E; tokens?: TestTokens; options?: Options } = {},
) {
  const env = (o.env ?? makeJudgeEnv()) as E;
  const store = controlStore();
  const { tokens, control, api, opts, parts, rigConfig } = makeControl(
    store,
    o.tokens,
    env.keys,
    o.options,
  );
  const harness = createHarnessApi(env.service, { supervisor: SUPERVISOR_TOKEN });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    return await (url.host === "harness" ? harness : control).request(
      `${url.pathname}${url.search}`,
      init as RequestInit,
    );
  };
  const bus = busOf(store).bus;
  bus.inbox = rigInboxPrefix("rig-a");
  const build = opts?.build ?? buildInfo();
  // As control's main makes them: the reports stream (ingest.ts's follow), commands, the asks.
  const onBus = Promise.all([
    bus.makeStream(REPORT_STREAM_CONFIG),
    bus.makeStream(LIVE_STREAM_CONFIG),
    sendCommandsOn(store, bus),
  ]).then(() =>
    serveRigAsks(bus, {
      store,
      control: build,
      privateKeyPem: env.keys.privateKeyPem,
      screens: parts.screens,
    }),
  );
  const intake = {
    store,
    control: build,
    requireKeyAcceptance: Boolean(opts?.requireKeyAcceptance),
  };
  const cfg: RelayConfig = {
    rig: "rig-a",
    harnessUrl: "http://harness",
    harnessToken: SUPERVISOR_TOKEN,
    fetchImpl,
    bus,
    held: new Map(),
    staging: new Set(),
    delivered: new Set(),
  };
  let state: RelayState = { cursor: 0 };
  /**
   * The rig's reports published, then folded by control from the bus, and applied; then the
   * supervisor's regular call, whose answer names control's place in its reports, where a page
   * control refused goes again (healCursor). A refused call changes nothing.
   */
  const report = async () => {
    // A round whose reporting failed keeps what it did, as the supervisor's loop does.
    state = await relayOnce(cfg, state).catch((err: unknown) => {
      if (err instanceof RelayError) return err.state;
      throw err;
    });
    await bus.follow(REPORT_STREAM_CONFIG, REPORT_CONSUMER_CONFIG, async (m) =>
      "later" in (await foldReport(intake, m)) ? { againInMs: 5 } : undefined,
    );
    await applied(store);
    const figures = { at: new Date().toISOString(), relay: { cursor: state.cursor } };
    const answer = await ask({ rig: cfg.rig, bus: cfg.bus }, "figures", figures).catch(() => null);
    if (answer) state = healCursor(state, answer);
  };
  const relay = async (rounds = 1): Promise<RelayState> => {
    await onBus;
    for (let i = 0; i < rounds; i++) {
      await report();
      await settle();
      const taken = await bus.take(commandSubject("rig-a"), (m) => takeCommand(cfg, m));
      if (taken.acked + taken.again) await report();
    }
    return state;
  };
  /**
   * A round of the live view: the rig's new live lines, and the supervisor's own, published on
   * the bus; then folded by control. What control refused of them is in `taken.refused`.
   */
  const taken = new LiveTaken();
  const counts = new LiveCounts();
  let lines: LiveRelayState = { cursor: 0, ownCursor: 0 };
  const live = async (): Promise<LiveRelayState> => {
    await onBus;
    lines = await publishLiveOnce({ ...cfg, counts, own: supervisorLive }, lines);
    await bus.follow(LIVE_STREAM_CONFIG, LIVE_CONSUMER_CONFIG, (m) => {
      foldLive({ store, taken }, m);
    });
    return lines;
  };
  return {
    env,
    store,
    tokens,
    control,
    harness,
    fetchImpl,
    cfg,
    relay,
    live,
    taken,
    api,
    bus,
    parts,
    rigConfig,
  };
}
