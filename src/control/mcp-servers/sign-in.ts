import {
  discoverOAuthServerInfo,
  fetchToken,
  refreshAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { ClientCredentialsProvider } from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import { cleanMcpError } from "../../common/mcp-client.ts";
import { type Login, type McpAuth, type Row, type ServerTable, str } from "./table.ts";

/**
 * A server's sign-in as the headers of its calls: its key, or an access token, renewed before it
 * ends (an OAuth sign-in with its refresh token, a client's with its ID and secret).
 */

/** Renewed when less than this is left. */
const RENEW_BEFORE_MS = 5 * 60_000;

/** An error the authorization server gave that only a new sign-in mends. */
const signInEnded = (err: unknown) => {
  const code = (err as { errorCode?: unknown }).errorCode;
  return code === "invalid_grant" || code === "invalid_client" || code === "unauthorized_client";
};

/** A server's sign-in as headers for its calls, or why there is none. */
export type SignIn = { headers: Record<string, string> } | { error: string };

export class SignIns {
  private readonly table: ServerTable;
  private readonly fetchImpl: typeof fetch;
  /** Renewals in progress, one per server: an OAuth server may rotate its refresh token. */
  private readonly renewing = new Map<string, Promise<SignIn>>();

  constructor(table: ServerTable, fetchImpl: typeof fetch) {
    this.table = table;
    this.fetchImpl = fetchImpl;
  }

  /**
   * The headers a call to the server carries: the key, or the access token (renewed first when
   * less than five minutes are left; a new one from the client ID and secret when it ended), or
   * none. An error in words when there is none to give.
   */
  async headers(name: string): Promise<SignIn> {
    const r = this.table.row(name);
    if (!r) return { error: "Settings has no server of that name" };
    const auth = str(r.auth) as McpAuth;
    if (auth === "none") return { headers: {} };
    if (auth === "key") {
      try {
        const value = this.table.open(r.secret_sealed);
        if (!value) return { error: "it has no key: enter it again" };
        return { headers: { [str(r.header) || "Authorization"]: value } };
      } catch {
        return { error: "its key cannot be opened: enter it again" };
      }
    }
    const login = this.table.login(r);
    const fresh = (l: Login | undefined) =>
      l && (l.expires_at === undefined || l.expires_at - Date.now() > RENEW_BEFORE_MS);
    if (fresh(login)) return { headers: { Authorization: `Bearer ${login?.access_token}` } };
    if (auth === "oauth" && !login) return { error: "it is not signed in yet" };
    if (auth === "oauth" && !login?.refresh_token) {
      if (login && (login.expires_at ?? 0) > Date.now() + 30_000)
        return { headers: { Authorization: `Bearer ${login.access_token}` } };
      this.table.setState(name, "needs_sign_in", "The sign-in ended. Sign in again.");
      return { error: "its sign-in ended: sign in again" };
    }
    const running = this.renewing.get(name);
    if (running) return running;
    const renewal = (
      auth === "oauth" ? this.refresh(name, r, login as Login) : this.clientToken(name, r)
    ).finally(() => this.renewing.delete(name));
    this.renewing.set(name, renewal);
    return renewal;
  }

  /** A token from the client ID and secret (client credentials), kept until it nearly ends. */
  private async clientToken(name: string, r: Row): Promise<SignIn> {
    let secret: string | undefined;
    try {
      secret = this.table.open(r.secret_sealed);
    } catch {
      return { error: "its client secret cannot be opened: enter it again" };
    }
    if (!secret) return { error: "it has no client secret: enter it again" };
    try {
      const info = await discoverOAuthServerInfo(str(r.url), { fetchFn: this.fetchImpl });
      const provider = new ClientCredentialsProvider({
        clientId: str(r.client_id),
        clientSecret: secret,
        ...(r.scope ? { scope: str(r.scope) } : {}),
        expectedIssuer: info.authorizationServerMetadata?.issuer ?? info.authorizationServerUrl,
      });
      const tokens = await fetchToken(provider, info.authorizationServerUrl, {
        ...(info.authorizationServerMetadata ? { metadata: info.authorizationServerMetadata } : {}),
        ...(info.resourceMetadata ? { resource: new URL(info.resourceMetadata.resource) } : {}),
        fetchFn: this.fetchImpl,
      });
      this.table.saveLogin(name, {
        access_token: tokens.access_token,
        ...(tokens.expires_in ? { expires_at: Date.now() + tokens.expires_in * 1000 } : {}),
      });
      return { headers: { Authorization: `Bearer ${tokens.access_token}` } };
    } catch (err) {
      const why = cleanMcpError(err, [secret]);
      this.table.setState(
        name,
        "failing",
        `Can't get a token with the client ID and secret: ${why}`,
      );
      return { error: `the server gave no token for its client ID and secret: ${why}` };
    }
  }

  /** Renews an OAuth sign-in with its refresh token. One that ended needs a new sign-in. */
  private async refresh(name: string, r: Row, login: Login): Promise<SignIn> {
    const secrets = [login.access_token, login.refresh_token ?? ""];
    try {
      const auth = login.auth_server ?? str(r.url);
      const info = await discoverOAuthServerInfo(str(r.url), { fetchFn: this.fetchImpl });
      const tokens = await refreshAuthorization(auth, {
        ...(info.authorizationServerMetadata ? { metadata: info.authorizationServerMetadata } : {}),
        clientInformation: login.client ?? { client_id: str(r.client_id) },
        refreshToken: login.refresh_token as string,
        ...(login.resource ? { resource: new URL(login.resource) } : {}),
        fetchFn: this.fetchImpl,
      });
      this.table.saveLogin(name, {
        ...login,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? login.refresh_token,
        expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
      });
      return { headers: { Authorization: `Bearer ${tokens.access_token}` } };
    } catch (err) {
      const why = cleanMcpError(err, secrets);
      if (signInEnded(err)) {
        this.table.setState(name, "needs_sign_in", "The sign-in ended. Sign in again.");
        return { error: "its sign-in ended: sign in again" };
      }
      // The server unreachable for now: the token works until it ends.
      if (login.expires_at && login.expires_at > Date.now() + 30_000)
        return { headers: { Authorization: `Bearer ${login.access_token}` } };
      this.table.setState(name, "failing", `Can't renew the sign-in: ${why}`);
      return { error: `its sign-in could not be renewed: ${why}` };
    }
  }
}
