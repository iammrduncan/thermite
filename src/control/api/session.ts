import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { sameSecret } from "../../common/secrets.ts";
import { SESSION_TOKEN_HEADER } from "../../core/api/control/dashboard.ts";
import type { Credential } from "../credential.ts";
import { SESSION_DAYS } from "../settings.ts";
import type { ControlStore } from "../store/index.ts";

/**
 * The owner's sign-in sessions (goal 243): one session serves the pages at /ui, the app at /next
 * and the owner's routes of /v1. A session is a random ID in a cookie; control keeps its hash.
 * A change made with a session carries the session's token, which a request another site made
 * the browser send can't know: in a form's `csrf` field on /ui, in a header on /v1.
 */

const DAY_MS = 24 * 3_600_000;
/** The session's cookie. */
const SESSION_COOKIE = "thermite_session";

/** A session's ID as control's store keeps it: hashed. */
const hashOf = (sid: string) => createHash("sha256").update(sid).digest("hex");

/** Failed sign-ins a client may make in a minute before it waits. */
export const SIGN_IN_FAILURES = 20;
/** Clients whose failures are kept at once; past it, the one that failed longest ago is dropped. */
const FAILING_CLIENTS = 4096;

/** Each client's failed requests in the last minute: its sign-ins, or its join commands. */
export class ClientFailures {
  private readonly byClient = new Map<string, number[]>();

  /** The client's failures in the minute before `now`. */
  count(client: string, now: number): number {
    const recent = (this.byClient.get(client) ?? []).filter((t) => t > now - 60_000);
    if (recent.length > 0) this.byClient.set(client, recent);
    else this.byClient.delete(client);
    return recent.length;
  }

  /** Records a failure, and returns the client's failures in the last minute. */
  add(client: string, now: number): number {
    const recent = [...(this.byClient.get(client) ?? []), now];
    // Kept in the order of each client's last failure, so the first is the oldest.
    this.byClient.delete(client);
    this.byClient.set(client, recent);
    if (this.byClient.size > FAILING_CLIENTS) {
      const oldest = this.byClient.keys().next().value;
      if (oldest !== undefined) this.byClient.delete(oldest);
    }
    return recent.filter((t) => t > now - 60_000).length;
  }
}

// biome-ignore lint/suspicious/noExplicitAny: any route's context
type Ctx = Context<any, any, any>;

export class OwnerSessions {
  /** The owner's token's fingerprint: a session made under another token is void. */
  readonly tokenFp: string;
  /** How long a session lasts without use, in milliseconds. */
  readonly sessionMs: number;
  /** Days a session lasts without use. */
  readonly sessionDays: number;
  /** Failed sign-ins in the last minute, for each client apart: the pages' and the API's. */
  readonly failures = new ClientFailures();
  private readonly tokenKey: Buffer;
  private readonly store: ControlStore;
  private readonly owner: Credential;

  constructor(
    store: ControlStore,
    owner: Credential,
    privateKeyPem: string,
    sessionDays: number | undefined,
  ) {
    this.store = store;
    this.owner = owner;
    // Keyed by control's own signing key and the owner's credential: stable across restarts,
    // void once the token changes, and not derivable from the token's hash alone (which is not
    // secret).
    this.tokenKey = createHash("sha256")
      .update(`thermite-ui\0${privateKeyPem}\0${owner.hex}`)
      .digest();
    this.tokenFp = createHmac("sha256", this.tokenKey).update("session-fingerprint").digest("hex");
    this.sessionDays = sessionDays ?? SESSION_DAYS;
    this.sessionMs = this.sessionDays * DAY_MS;
  }

  /** The session's token for changes: a form's `csrf` field, or SESSION_TOKEN_HEADER. */
  csrfOf(sid: string): string {
    return createHmac("sha256", this.tokenKey).update(`csrf\0${sid}`).digest("hex");
  }

  /** Sets the session's cookie: for every path, since /ui, /next and /v1 share the session. */
  cookie(c: Ctx, sid: string): void {
    setCookie(c, SESSION_COOKIE, sid, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge: Math.floor(this.sessionMs / 1000),
      // Behind a proxy that ends TLS, the proxy's header says the owner's side is HTTPS.
      secure:
        new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https",
    });
  }

  /**
   * The request's session, when it has one that holds: its ID. A browser signed in before goal
   * 243 keeps a cookie for /ui alone, and may send it beside a newer one: any that holds counts.
   */
  sessionOf(c: Ctx): string | undefined {
    const now = Date.now();
    for (const sid of cookieValues(c.req.header("cookie"), SESSION_COOKIE)) {
      const s = this.store.uiSessions.get(hashOf(sid));
      if (!s || s.expiresAt <= now || !sameSecret(s.tokenFp, this.tokenFp)) continue;
      // Renewed at most once a day, so a session in use does not run out.
      if (s.expiresAt - now < this.sessionMs - DAY_MS) {
        this.store.uiSessions.extend(hashOf(sid), now + this.sessionMs);
        this.cookie(c, sid);
      }
      return sid;
    }
    return undefined;
  }

  /** Signs in with the owner's token: a new session and its cookie, or undefined for a wrong token. */
  start(c: Ctx, token: string): string | undefined {
    if (!this.owner.matches(token)) return undefined;
    const sid = randomBytes(24).toString("base64url");
    this.store.uiSessions.create(hashOf(sid), this.tokenFp, Date.now() + this.sessionMs);
    this.cookie(c, sid);
    return sid;
  }

  /** Ends the request's session on control, and takes its cookie back. */
  end(c: Ctx): void {
    for (const sid of cookieValues(c.req.header("cookie"), SESSION_COOKIE))
      this.store.uiSessions.delete(hashOf(sid));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
  }

  /**
   * Whether a request to an owner's route of /v1 comes from a signed-in page: its session holds,
   * and a change carries the session's token in its header. `refused` says why not: 401 with no
   * session, 403 for a change without its token.
   */
  takes(c: Ctx): { ok: true } | { ok: false; status: 401 | 403; error: string } {
    const sid = this.sessionOf(c);
    if (!sid) return { ok: false, status: 401, error: "unauthorized" };
    const method = c.req.method;
    if (method === "GET" || method === "HEAD") return { ok: true };
    const sent = c.req.header(SESSION_TOKEN_HEADER) ?? "";
    return sameSecret(sent, this.csrfOf(sid))
      ? { ok: true }
      : { ok: false, status: 403, error: "bad session token" };
  }
}

/** Every value a Cookie header gives for one name, in its order. */
function cookieValues(header: string | undefined, name: string): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    if (value) out.push(value);
  }
  return out;
}
