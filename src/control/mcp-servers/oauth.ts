import { randomBytes } from "node:crypto";
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { cleanMcpError } from "../../common/mcp-client.ts";
import { sha256Hex } from "../../core/canonical.ts";
import type { ControlStore } from "../store/index.ts";
import type { McpServers } from "./index.ts";
import { type ServerTable, str } from "./table.ts";

/**
 * An OAuth sign-in on the server's own page (authorization code with PKCE): started, cancelled by
 * the owner, or finished with the code the browser brings back, and then the server's tools read.
 */

/** A sign-in started and not finished is forgotten after this long. */
const SIGN_IN_MS = 15 * 60_000;

/** One page that says how a sign-in went, for the browser tab that comes back to control. */
export interface SignInDone {
  name?: string | undefined;
  error?: string | undefined;
  tools?: number | undefined;
}

export class OAuthSignIns {
  private readonly table: ServerTable;
  private readonly store: ControlStore;
  private readonly fetchImpl: typeof fetch;
  /** The servers it signs in to: once signed in, it reads a server's tools with their check. */
  private readonly servers: Pick<McpServers, "check" | "get">;

  constructor(
    table: ServerTable,
    store: ControlStore,
    fetchImpl: typeof fetch,
    servers: Pick<McpServers, "check" | "get">,
  ) {
    this.table = table;
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.servers = servers;
  }

  /**
   * Starts an OAuth sign-in: finds the server's authorization server, registers Thermite as a
   * client when the server allows it and the owner gave no client ID, and returns the address of
   * the server's sign-in page. The browser comes back to control's callback (redirectUri) with a
   * code; finishSignIn exchanges it. The state and the PKCE verifier are kept for 15 minutes.
   */
  async startSignIn(name: string, redirectUri: string, by: string): Promise<{ url: string }> {
    const r = this.table.row(name);
    if (!r) throw new Error("Settings has no server of that name.");
    if (str(r.auth) !== "oauth") throw new Error(`${name} does not sign in with OAuth.`);
    const info = await discoverOAuthServerInfo(str(r.url), { fetchFn: this.fetchImpl }).catch(
      (err) => {
        throw new Error(`Can't find the server's sign-in: ${cleanMcpError(err)}`);
      },
    );
    const metadata = info.authorizationServerMetadata;
    let client: OAuthClientInformationMixed;
    const old = this.table.login(r);
    let secret: string | undefined;
    try {
      secret = this.table.open(r.secret_sealed);
    } catch {
      throw new Error("Its client secret cannot be opened: enter it again.");
    }
    if (r.client_id)
      client = { client_id: str(r.client_id), ...(secret ? { client_secret: secret } : {}) };
    else if (
      old?.client &&
      old.auth_server === info.authorizationServerUrl &&
      ("redirect_uris" in old.client
        ? (old.client.redirect_uris as string[]).includes(redirectUri)
        : false)
    )
      client = old.client;
    else if (metadata?.registration_endpoint)
      client = await registerClient(info.authorizationServerUrl, {
        metadata,
        clientMetadata: {
          client_name: "Thermite",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          ...(r.scope ? { scope: str(r.scope) } : {}),
        },
        fetchFn: this.fetchImpl,
      }).catch((err) => {
        throw new Error(`The server did not register Thermite: ${cleanMcpError(err)}`);
      });
    else
      throw new Error(
        "The server does not register clients by itself. Register Thermite on the server, then give its client ID here.",
      );
    const state = randomBytes(24).toString("base64url");
    const resource = info.resourceMetadata ? new URL(info.resourceMetadata.resource) : undefined;
    const { authorizationUrl, codeVerifier } = await startAuthorization(
      info.authorizationServerUrl,
      {
        ...(metadata ? { metadata } : {}),
        clientInformation: client,
        redirectUrl: redirectUri,
        ...(r.scope ? { scope: str(r.scope) } : {}),
        state,
        ...(resource ? { resource } : {}),
      },
    );
    const now = Date.now();
    this.table.rows.dropEndedSignIns(new Date(now).toISOString());
    this.table.rows.addSignIn({
      stateHash: sha256Hex(state),
      name,
      verifierSealed: this.table.secrets.seal(
        JSON.stringify({
          verifier: codeVerifier,
          client,
          auth_server: info.authorizationServerUrl,
          ...(resource ? { resource: resource.href } : {}),
        }),
      ),
      redirectUri,
      expiresAt: new Date(now + SIGN_IN_MS).toISOString(),
      by,
    });
    this.store.auditLog.add(by, "mcp_server_sign_in_started", { name });
    return { url: authorizationUrl.href };
  }

  /** The browser came back without a code (the owner said no): the sign-in is forgotten. */
  cancelSignIn(state: string, why: string): string | undefined {
    const h = sha256Hex(state);
    const s = this.table.rows.signInName(h);
    if (!s) return undefined;
    this.table.rows.deleteSignIn(h);
    const r = this.table.row(str(s.name));
    if (r && !r.login_sealed) this.table.setState(str(s.name), "needs_sign_in", why);
    return str(s.name);
  }

  /**
   * The browser came back with a code: exchanges it for the sign-in (once; a state is used once
   * and only within 15 minutes), seals it, and reads the server's tools with it.
   */
  async finishSignIn(state: string, code: string): Promise<SignInDone> {
    const h = sha256Hex(state);
    const s = this.table.rows.signIn(h);
    if (!s) return { error: "This sign-in is not known, or was used already. Start it again." };
    this.table.rows.deleteSignIn(h);
    const name = str(s.name);
    if (Date.parse(str(s.expires_at)) < Date.now())
      return { name, error: "This sign-in took more than 15 minutes. Start it again." };
    const r = this.table.row(name);
    if (!r || str(r.auth) !== "oauth") return { name, error: "The server is gone from Settings." };
    let pending: {
      verifier: string;
      client: OAuthClientInformationMixed;
      auth_server: string;
      resource?: string;
    };
    try {
      pending = JSON.parse(this.table.secrets.open(str(s.verifier_sealed)));
    } catch {
      return { name, error: "This sign-in cannot be opened. Start it again." };
    }
    let metadata: AuthorizationServerMetadata | undefined;
    try {
      metadata = (await discoverOAuthServerInfo(str(r.url), { fetchFn: this.fetchImpl }))
        .authorizationServerMetadata;
    } catch {
      metadata = undefined;
    }
    try {
      const tokens = await exchangeAuthorization(pending.auth_server, {
        ...(metadata ? { metadata } : {}),
        clientInformation: pending.client,
        authorizationCode: code,
        codeVerifier: pending.verifier,
        redirectUri: str(s.redirect_uri),
        ...(pending.resource ? { resource: new URL(pending.resource) } : {}),
        fetchFn: this.fetchImpl,
      });
      this.table.saveLogin(name, {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
        client: pending.client,
        auth_server: pending.auth_server,
        resource: pending.resource,
      });
    } catch (err) {
      const why = cleanMcpError(err, [code]);
      this.table.setState(name, "needs_sign_in", `The sign-in failed: ${why}`);
      return { name, error: `The server did not take the sign-in: ${why}` };
    }
    this.table.setState(name, "unchecked", null);
    this.store.auditLog.add(str(s.started_by), "mcp_server_signed_in", { name });
    const why = await this.servers.check(name);
    return why
      ? { name, error: `Signed in, but ${why}` }
      : { name, tools: this.servers.get(name)?.tools?.length ?? 0 };
  }
}
