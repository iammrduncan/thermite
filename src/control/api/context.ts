import type { Context, Hono, MiddlewareHandler } from "hono";
import { buildInfo } from "../../common/build-info.ts";
import type { Loops } from "../../common/health.ts";
import { sameSecret } from "../../common/secrets.ts";
import { type BuildInfo, buildFromHeaders } from "../../core/version.ts";
import type { BusUsers, BusView, ConfigWriter } from "../bus/index.ts";
import type { ClusterKubectl } from "../clusters/index.ts";
import { Credential } from "../credential.ts";
import type { KitRepos } from "../kits/index.ts";
import type { DeploymentDriver } from "../lifecycle.ts";
import type { MachineSsh, RigBus } from "../machines/index.ts";
import type { McpServers } from "../mcp-servers/index.ts";
import type { MountPages } from "../pages.ts";
import { type ControlParts, controlParts } from "../parts.ts";
import type { probeRepository, readKitManifest } from "../repo-probe.ts";
import type { RigImages, RigUpdates } from "../rigs/index.ts";
import type { ControlTunnels, RunpodRigs, RunpodTests } from "../runpod/index.ts";
import type { SecretBox } from "../secrets.ts";
import type { ControlStore } from "../store/index.ts";
import { checkRig, recheckRefusals } from "../versions.ts";

/**
 * What control's API sections share: control's credentials and options, who may call (the owner's
 * token, a rig's, the reader's), and the context built once for them.
 */

/**
 * Control's credentials. Each is a token or, in deployment, a Credential holding only the
 * token's hash (the owner keeps the token; see credential.ts).
 */
export interface ControlTokens {
  /** The owner's. */
  admin: string | Credential;
  /** Optional read-only token (MCP and API reads for observers). */
  read?: string | Credential | undefined;
  /**
   * Optional token for agents on MCP (for example a coordinating agent): it may read and steer
   * (assign, pause, resume, redirect, reset workers, export), never message agents, approve,
   * accept or wipe.
   */
  agent?: string | Credential | undefined;
  /**
   * Optional token the owner gives an operating agent on MCP: what the agent token may do, and
   * message the run's agents on the owner's behalf. Approvals, acceptances, endings and wipes
   * stay the owner's.
   */
  operator?: string | Credential | undefined;
  /** rig id -> token */
  rigs: Record<string, string>;
}

/** A list size from a query string: a whole number from 1 to 5000, or the default. */
export function clampLimit(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? fallback);
  return Number.isInteger(n) ? Math.min(5000, Math.max(1, n)) : fallback;
}

/** The address a request came from, as its socket gives it; empty where there is no socket. */
export function clientOf(c: Context): string {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? "";
}

/** The token an Authorization header carries as `Bearer <token>`; empty when it carries none. */
export function bearer(header: string | undefined): string {
  return header?.startsWith("Bearer ") ? header.slice(7) : "";
}

export interface ControlOptions {
  /** A rig is stale after this long without a report (3 missed 60 s polls). */
  staleAfterMs: number;
  /** A rig is offline after this long without a report (THERMITE_CONTROL_OFFLINE_SECONDS). */
  offlineAfterMs?: number | undefined;
  /** Control's own build, which rigs' builds are compared with (tests give their own). */
  build?: BuildInfo | undefined;
  /** Restarts containers (Kubernetes or compose); none configured: restarts are refused. */
  driver?: DeploymentDriver | undefined;
  /** Hold every rig's first report key for the owner's acceptance (no trust on first use). */
  requireKeyAcceptance?: boolean | undefined;
  /** Days a dashboard session lasts without use. */
  sessionDays?: number | undefined;
  /**
   * Seals the API keys of the model routes the owner sets. Without one, a box with a key in memory
   * only: routes then need their keys again after a restart.
   */
  secrets?: SecretBox | undefined;
  /** How control reaches model providers to list their models (tests give their own). */
  providerFetch?: typeof fetch | undefined;
  /** The kits control writes itself, served to rigs (none: no kits are served). */
  kits?: KitRepos | undefined;
  /** Where control keeps the exports rigs send it (none: it takes none). */
  exportsDir?: string | undefined;
  /** How the new-campaign page reads a project's repository (tests give their own). */
  probeRepo?: typeof probeRepository | undefined;
  /** How the new-campaign page reads a kit's kit.json from its repository (tests give their own). */
  readKit?: typeof readKitManifest | undefined;
  /** Control's address as rigs and machines reach it (THERMITE_CONTROL_PUBLIC_URL). */
  publicUrl?: string | undefined;
  /** How control reaches machines over SSH (tests give their own). */
  machineSsh?: MachineSsh | undefined;
  /** The images control deploys rigs from on machines. */
  rigImages?: RigImages | undefined;
  /** The message bus as the rigs control sets up reach it (none: they keep to HTTP). */
  rigBus?: RigBus | undefined;
  /** How control reaches Kubernetes clusters (tests give their own). */
  clusterKubectl?: ClusterKubectl | undefined;
  /** How often a draining rig's report is looked at (goal 079; tests make it short). */
  drainWatchMs?: number | undefined;
  /** How control reaches GPU clouds' APIs (tests give their own). */
  cloudFetch?: typeof fetch | undefined;
  /** Test pods on GPU clouds; control's loop advances them (main.ts). Made here when not given. */
  runpodTests?: RunpodTests | undefined;
  /** The image a RunPod test pod runs when none is given (THERMITE_RUNPOD_TEST_IMAGE). */
  runpodTestImage?: string | undefined;
  /**
   * Rigs the owner launches on GPU clouds; control's loop follows them (main.ts). Made here when
   * not given.
   */
  runpodRigs?: RunpodRigs | undefined;
  /** The image a RunPod rig runs when none is given (THERMITE_RUNPOD_RIG_IMAGE). */
  runpodRigImage?: string | undefined;
  /**
   * Rigs in pull mode, which control connects to; control's loop advances them (main.ts). Made
   * here when not given. Their calls are answered by this API, in-process.
   */
  tunnels?: ControlTunnels | undefined;
  /**
   * MCP servers for the agents (goal 068): made here when not given. Tests give one that reaches
   * their fake servers.
   */
  mcpServers?: McpServers | undefined;
  /** Updates of rigs to control's version from their pages (tests give their own, with short waits). */
  rigUpdates?: RigUpdates | undefined;
  /** The message bus's users, when control runs the bus: a rig's new key gets its user there. */
  busUsers?: BusUsers | undefined;
  /** The rigs' config on the message bus: a rig's new seal key gets its config at once. */
  busConfig?: ConfigWriter | undefined;
  /** The message bus, for its state (REST, MCP, /metrics): a test's control gives its own. */
  bus?: BusView | undefined;
  /** Control's loops, for its health route (goal 173): a test's control gives its own clock. */
  loops?: Loops | undefined;
  /**
   * Control's parts, made once by its main (parts.ts), whose loops use the same ones. Without
   * them (a test's control), the API makes its own from the options above.
   */
  parts?: ControlParts | undefined;
  /** Control's pages (control/pages.ts: the dashboard's mountDashboard); none: REST and MCP only. */
  pages?: MountPages | undefined;
}

/** What every section of the API takes, built once by createControlApi. */
export interface ApiContext {
  store: ControlStore;
  tokens: ControlTokens;
  privateKeyPem: string;
  opts: ControlOptions;
  /** Control's own build, which rigs' builds are compared with. */
  control: BuildInfo;
  /** How rigs' views are made: when a rig is stale or offline, and control's build. */
  viewOpts: { staleAfterMs: number; offlineAfterMs: number | undefined; control: BuildInfo };
  /** The owner's credential, and the read, agent and operator tokens' when given. */
  creds: {
    owner: Credential;
    read: Credential | undefined;
    agent: Credential | undefined;
    operator: Credential | undefined;
  };
  /** What the dashboard, REST and MCP share, made once (parts.ts). */
  parts: ControlParts;
  /** The owner's token: what guards the owner's routes. */
  admin: MiddlewareHandler;
  /** A rig's token, or its tunnel: what guards a rig's own calls, with its version check. */
  rigAuth: MiddlewareHandler;
  /** The owner's token or the read token: what guards the reads a scraper or an observer makes. */
  reader: MiddlewareHandler;
  /**
   * Who a guard let this request through as, by its audit actor (`owner:api`, `reader:api` or
   * `rig:<rig>`); none when no guard took it.
   */
  callerOf(c: Context): string | undefined;
}

/**
 * The context, built once: control's build noted, its parts made, the tunnels' calls answered by
 * `app`, and the guards of the owner's, the rigs' and the reader's routes.
 */
export function apiContext(
  app: Hono,
  store: ControlStore,
  tokens: ControlTokens,
  privateKeyPem: string,
  opts: ControlOptions,
): ApiContext {
  store.enrollments.setConfiguredRigs(Object.keys(tokens.rigs));
  const control = opts.build ?? buildInfo();
  // A rig refused by an earlier control may work with this one.
  recheckRefusals(store, control);
  // Since when control runs this build: a rig's page says since when the two differ.
  store.builds.noteControl(control);
  const viewOpts = {
    staleAfterMs: opts.staleAfterMs,
    offlineAfterMs: opts.offlineAfterMs,
    control,
  };

  const owner = Credential.from(tokens.admin);
  // What the dashboard, REST and MCP share, made once (parts.ts): by control's main, or here.
  const parts = opts.parts ?? controlParts(store, privateKeyPem, opts, viewOpts);
  const { tunnels } = parts;
  tunnels.serveWith((rig, call) =>
    Promise.resolve(
      app.request(
        call.path,
        {
          method: call.method,
          headers: call.headers,
          ...(call.method === "GET" || call.method === "HEAD"
            ? {}
            : { body: new Uint8Array(call.body) }),
        },
        { tunnelRig: rig },
      ),
    ),
  );
  const opt = (t: string | Credential | undefined) =>
    t === undefined ? undefined : Credential.from(t);
  const creds = {
    owner,
    read: opt(tokens.read),
    agent: opt(tokens.agent),
    operator: opt(tokens.operator),
  };
  // Each credential is distinct: the owner's, an operator's, an agent's and a reader's.
  const given = Object.values(creds).filter((x): x is Credential => x !== undefined);
  if (given.some((x, i) => given.slice(i + 1).some((y) => x.same(y))))
    throw new Error("the admin, operator, agent and read tokens must all be different");
  // Who each guard let a request through as, for the audit log's entries of what it then refused.
  const callers = new WeakMap<Context, string>();
  const admin: MiddlewareHandler = async (c, next) => {
    if (!owner.matches(bearer(c.req.header("authorization"))))
      return c.json({ error: "unauthorized" }, 401);
    callers.set(c, "owner:api");
    await next();
  };
  // A rig's token is in the rig tokens file, or was made by control when the rig was enrolled.
  // A rig control reaches through a proxy has no token: its calls come in-process, from control's
  // own end of the tunnel (src/control/runpod/tunnel.ts), which verified them. Only an in-process call
  // can carry that binding; a request from the network never has it.
  const rigAuth: MiddlewareHandler = async (c, next) => {
    const rig = c.req.param("rig") ?? "";
    const via = (c.env as { tunnelRig?: unknown } | undefined)?.tunnelRig;
    if (typeof via === "string") {
      if (via !== rig || !store.tunnels.get(rig)?.enrolled_at || store.retired.get(rig))
        return c.json({ error: "unauthorized" }, 401);
    } else {
      const token = bearer(c.req.header("authorization"));
      const expected = tokens.rigs[rig];
      const ok =
        expected !== undefined
          ? sameSecret(token, expected)
          : store.enrollments.tokenMatches(rig, token);
      if (!ok) return c.json({ error: "unauthorized" }, 401);
      // A retired rig is refused until the owner brings it back, whatever token it holds.
      if (store.retired.get(rig)) return c.json({ error: "this rig is retired in control" }, 403);
    }
    // The supervisor's build, from its headers. A supervisor that sends none on the calls every
    // build makes is from before version checks: unknown, and never refused for it.
    const route = c.req.path.slice(`/v1/rigs/${encodeURIComponent(rig)}/`.length);
    const supervisorBuild = buildFromHeaders((h) => c.req.header(h));
    if (supervisorBuild || ["ingest", "supervisor", "commands/pending"].includes(route))
      store.builds.setRig(rig, "supervisor", supervisorBuild);
    // A report brings its harness's build: the ingest route checks that one, once it verifies.
    const refused =
      route === "ingest"
        ? checkRig(store, rig, control, { harness: null, endRefusal: false })
        : checkRig(store, rig, control);
    if (refused) {
      // Counted, so the rig's page can say that it still calls.
      store.refusals.countCall(rig);
      return c.json({ error: refused }, 409);
    }
    callers.set(c, `rig:${rig}`);
    await next();
  };
  // Metrics: the read token is enough (a scraper should not hold the owner's credential).
  const reader: MiddlewareHandler = async (c, next) => {
    const t = bearer(c.req.header("authorization"));
    if (!owner.matches(t) && !creds.read?.matches(t)) return c.json({ error: "unauthorized" }, 401);
    callers.set(c, owner.matches(t) ? "owner:api" : "reader:api");
    await next();
  };
  return {
    store,
    tokens,
    privateKeyPem,
    opts,
    control,
    viewOpts,
    creds,
    parts,
    admin,
    rigAuth,
    reader,
    callerOf: (c) => callers.get(c),
  };
}
