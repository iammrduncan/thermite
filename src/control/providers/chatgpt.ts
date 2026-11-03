import { createHash, randomBytes, randomUUID } from "node:crypto";
import { errorText } from "../../common/errors.ts";
import { CHATGPT_API } from "../../core/agents.ts";
import type { SecretBox } from "../secrets.ts";
import type { ControlStore, ModelProvider, ProviderModel } from "../store/index.ts";
import { CHATGPT_USAGE_URL, chatgptWindows, type PlanUsage } from "./plan-usage.ts";

/**
 * A ChatGPT subscription through Sign in with ChatGPT (OpenAI's "ChatGPT plan usage" for
 * open-source apps). Control runs the sign-in: it registers as "Thermite" the first time and
 * reuses the client ID OpenAI issues after that, with a host ID of its own. OpenAI sends the
 * browser to a fixed address on the owner's own computer, which control cannot receive, so the
 * owner pastes that address here. Control seals the login (the owner's decision: the refresh
 * token stays on control) and is the only one that renews it, because OpenAI rotates the
 * refresh token at each renewal. Rigs get the one-hour access token with their route.
 */

const AUTH = "https://auth.openai.com";
const AUTHORIZE_URL = `${AUTH}/api/accounts/authorize`;
const TOKEN_URL = `${AUTH}/api/accounts/oauth/token`;
const OPENID_CONFIG = `${AUTH}/.well-known/openid-configuration`;
/** Where OpenAI sends the browser after the sign-in (fixed for open-source apps). */
export const CHATGPT_REDIRECT = "http://127.0.0.1:1455/auth/callback";
const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`;
/** The first sign-in's client: OpenAI then issues the app a client ID of its own. */
const FIRST_CLIENT = "dynamic_agent_client";
const APP_NAME = "Thermite";
/** A login is renewed when less than this is left, so a route a rig takes lasts this long. */
const RENEW_BEFORE_MS = 30 * 60_000;
/** How long a started sign-in waits for its pasted address. */
const PENDING_MS = 30 * 60_000;

/** The sealed login. */
export interface ChatGPTLogin {
  access: string;
  refresh: string;
  /** When the access token ends (ms). */
  expires: number;
  /** Not renewed before this (OpenAI's earliest_refresh_at), when it says one (ms). */
  earliest_refresh: number | null;
  /** The client ID OpenAI issued Thermite for this account. */
  client_id: string;
  /** Control's host ID for this account (OpenAI's ext_agent_host_id). */
  host_id: string;
}

interface Pending {
  verifier: string;
  client_id: string | null;
  host_id: string;
  at: number;
}

/** A failure that ends the login: the owner signs in again. */
class LoginEnded extends Error {}

const b64url = (b: Buffer) => b.toString("base64url");

/** OpenAI's earliest_refresh_at, as seconds or milliseconds since 1970 or a date (ms; or null). */
function timeOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string" && v) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

export class ChatGPTLogins {
  private readonly pending = new Map<string, Pending>();
  private readonly renewing = new Map<string, Promise<string | { error: string }>>();
  private readonly store: ControlStore;
  private readonly secrets: SecretBox;
  private readonly fetchImpl: typeof fetch;

  constructor(store: ControlStore, secrets: SecretBox, fetchImpl?: typeof fetch) {
    this.store = store;
    this.secrets = secrets;
    this.fetchImpl = fetchImpl ?? fetch;
  }

  private login(p: ModelProvider): ChatGPTLogin | undefined {
    if (p.type !== "chatgpt" || !p.key_sealed) return undefined;
    try {
      return JSON.parse(this.secrets.open(p.key_sealed)) as ChatGPTLogin;
    } catch {
      return undefined;
    }
  }

  /**
   * The address of OpenAI's sign-in page for a new sign-in. Signing in again to a provider keeps
   * its issued client ID and host ID, as OpenAI asks.
   */
  start(name?: string): string {
    const now = Date.now();
    for (const [k, v] of this.pending) if (now - v.at > PENDING_MS) this.pending.delete(k);
    const old = name ? this.store.modelProviders.get(name) : undefined;
    const was = old ? this.login(old) : undefined;
    const verifier = b64url(randomBytes(32));
    const state = b64url(randomBytes(32));
    const host_id = was?.host_id ?? randomUUID();
    this.pending.set(state, { verifier, client_id: was?.client_id ?? null, host_id, at: now });
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: was?.client_id ?? FIRST_CLIENT,
      ...(was ? {} : { agent_name_hint: APP_NAME }),
      ext_agent_host_id: `urn:uuid:${host_id}`,
      response_type: "code",
      redirect_uri: CHATGPT_REDIRECT,
      resource: CHATGPT_API,
      scope: SCOPE,
      state,
      code_challenge: b64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      nonce: b64url(randomBytes(16)),
    }).toString();
    return url.toString();
  }

  /** The login from the address the owner pasted (where OpenAI sent the browser). */
  async finish(pasted: string): Promise<ChatGPTLogin | { error: string }> {
    let url: URL;
    try {
      url = new URL(pasted.trim());
    } catch {
      return { error: `Paste the whole address from the tab, starting with ${CHATGPT_REDIRECT}.` };
    }
    const want = new URL(CHATGPT_REDIRECT);
    if (url.origin !== want.origin || url.pathname !== want.pathname)
      return { error: `The address must start with ${CHATGPT_REDIRECT}.` };
    const refused = url.searchParams.get("error");
    if (refused) return { error: `ChatGPT did not allow the sign-in (${refused.slice(0, 100)}).` };
    const state = url.searchParams.get("state") ?? "";
    const p = this.pending.get(state);
    if (!p || Date.now() - p.at > PENDING_MS)
      return {
        error:
          "Control did not start this sign-in, or it is older than 30 minutes: press Sign in with ChatGPT again.",
      };
    const code = url.searchParams.get("code");
    const client_id = url.searchParams.get("client_id")?.trim() || p.client_id;
    if (!code || !client_id) return { error: "The address has no sign-in code in it." };
    this.pending.delete(state);
    try {
      const t = await this.token({
        grant_type: "authorization_code",
        client_id,
        code,
        code_verifier: p.verifier,
        redirect_uri: CHATGPT_REDIRECT,
        resource: CHATGPT_API,
      });
      return this.loginOf(t, client_id, p.host_id);
    } catch (err) {
      return { error: `The sign-in failed: ${errorText(err)}` };
    }
  }

  private async token(form: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = String(body.error ?? body.code ?? "");
      const msg = `OpenAI answered HTTP ${res.status}${code ? ` (${code.slice(0, 60)})` : ""}`;
      // A refresh token that was used, ran out or was revoked: only a new sign-in helps.
      if (res.status === 400 || res.status === 401 || /invalid_grant|refresh_token_/.test(code))
        throw new LoginEnded(msg);
      throw new Error(msg);
    }
    return body;
  }

  private loginOf(t: Record<string, unknown>, client_id: string, host_id: string): ChatGPTLogin {
    const str = (k: string) => {
      const v = t[k];
      if (typeof v !== "string" || !v.trim()) throw new Error(`OpenAI's answer has no ${k}`);
      return v;
    };
    const expiresIn = t.expires_in;
    if (typeof expiresIn !== "number" || !(expiresIn > 0))
      throw new Error("OpenAI's answer has no expires_in");
    if (!str("scope").split(/\s+/).includes(DIRECT_SCOPE))
      throw new Error(`the sign-in did not allow ${DIRECT_SCOPE}: allow Thermite to use your plan`);
    return {
      access: str("access_token"),
      refresh: str("refresh_token"),
      expires: Date.now() + expiresIn * 1000,
      earliest_refresh: timeOf(t.earliest_refresh_at),
      client_id,
      host_id,
    };
  }

  /** Seals a login as the provider's key. */
  seal(login: ChatGPTLogin): string {
    return this.secrets.seal(JSON.stringify(login));
  }

  /**
   * The provider's access token, renewed first when less than half an hour is left (never before
   * OpenAI's earliest time). One renewal at a time per provider: OpenAI rotates the refresh token.
   * A login that ended says so on the Providers page.
   */
  async access(p: ModelProvider): Promise<string | { error: string }> {
    const login = this.login(p);
    if (!login) return { error: "its ChatGPT login cannot be opened: sign in again" };
    const now = Date.now();
    const early = login.earliest_refresh !== null && now < login.earliest_refresh;
    if (login.expires - now > RENEW_BEFORE_MS || (early && login.expires - now > 60_000))
      return login.access;
    const running = this.renewing.get(p.name);
    if (running) return running;
    const renewal = this.renew(p.name, login).finally(() => this.renewing.delete(p.name));
    this.renewing.set(p.name, renewal);
    return renewal;
  }

  private async renew(name: string, login: ChatGPTLogin): Promise<string | { error: string }> {
    try {
      const t = await this.token({
        grant_type: "refresh_token",
        client_id: login.client_id,
        refresh_token: login.refresh,
        resource: CHATGPT_API,
      });
      const next = this.loginOf(t, login.client_id, login.host_id);
      this.store.modelProviders.setKey(name, this.seal(next));
      return next.access;
    } catch (err) {
      const why = errorText(err);
      if (err instanceof LoginEnded) {
        const error = `its ChatGPT sign-in ended (${why}): sign in again`;
        this.store.modelProviders.setModels(name, { error });
        return { error };
      }
      // OpenAI unreachable for now: the token keeps working until it ends.
      return login.expires > Date.now() + 60_000
        ? login.access
        : { error: `its ChatGPT login could not be renewed: ${why}` };
    }
  }

  /** The account's models, as OpenAI lists them for display (in OpenAI's order). */
  async models(p: ModelProvider): Promise<ProviderModel[] | { error: string }> {
    const access = await this.access(p);
    if (typeof access !== "string") return access;
    let res: Response;
    try {
      res = await this.fetchImpl(`${CHATGPT_API}/models`, {
        headers: { authorization: `Bearer ${access}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return { error: "could not reach OpenAI to list its models" };
    }
    if (!res.ok) return { error: `could not list its models: HTTP ${res.status}` };
    const body = (await res.json().catch(() => ({}))) as {
      models?: Record<string, unknown>[];
      data?: Record<string, unknown>[];
    };
    const listed = Array.isArray(body.models)
      ? body.models
          .filter((m) => m.visibility === undefined || m.visibility === "list")
          .map((m) => m.slug ?? m.id)
      : Array.isArray(body.data)
        ? body.data.map((m) => m.id)
        : undefined;
    if (!listed) return { error: "could not list its models: the answer had no model list" };
    const seen = new Set<string>();
    return listed
      .filter((id): id is string => typeof id === "string" && /^[\w.:/@+-]{1,200}$/.test(id))
      .filter((id) => !seen.has(id) && seen.add(id))
      .map((id) => ({ id }));
  }

  /**
   * How much of the plan is used (goal 151), as ChatGPT's usage endpoint answers for the access
   * token, with the account its token names. The token goes to OpenAI only; a refusal is in words.
   */
  async usage(p: ModelProvider): Promise<PlanUsage> {
    const at = new Date().toISOString();
    const none = (error: string): PlanUsage => ({ source: "openai", windows: [], at, error });
    const access = await this.access(p);
    if (typeof access !== "string") return none(access.error);
    let account: unknown;
    try {
      const claims = JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString());
      account = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    } catch {
      // Not a token with claims: asked without the account.
    }
    let res: Response;
    try {
      res = await this.fetchImpl(CHATGPT_USAGE_URL, {
        headers: {
          authorization: `Bearer ${access}`,
          accept: "application/json",
          ...(typeof account === "string" ? { "chatgpt-account-id": account } : {}),
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return none("could not reach ChatGPT's usage endpoint");
    }
    if (!res.ok) return none(`ChatGPT's usage endpoint refused this sign-in: HTTP ${res.status}`);
    const got = chatgptWindows(await res.json().catch(() => undefined));
    return got ? { source: "openai", ...got, at } : none("its answer was not in a known shape");
  }

  /** Ends the login at OpenAI (sign-out); false when OpenAI did not confirm it. */
  async revoke(p: ModelProvider): Promise<boolean> {
    const login = this.login(p);
    if (!login) return false;
    try {
      const conf = (await (
        await this.fetchImpl(OPENID_CONFIG, { signal: AbortSignal.timeout(15_000) })
      ).json()) as { revocation_endpoint?: unknown };
      if (typeof conf.revocation_endpoint !== "string") return false;
      const res = await this.fetchImpl(conf.revocation_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: login.refresh,
          token_type_hint: "refresh_token",
          client_id: login.client_id,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
