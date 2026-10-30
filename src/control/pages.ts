import type { Hono } from "hono";
import type { BuildInfo } from "../core/version.ts";
import type { Credential } from "./credential.ts";
import type { ExportFiles } from "./exports.ts";
import type { KbFiles } from "./kb/index.ts";
import type { KitRepos } from "./kits/index.ts";
import type { DeploymentDriver, RunpodDriver } from "./lifecycle.ts";
import type { McpServers } from "./mcp-servers/index.ts";
import type { ControlParts } from "./parts.ts";
import type { ChatGPTLogins } from "./providers/index.ts";
import type { probeRepository, readKitManifest } from "./repo-probe.ts";
import type { RigUpdates } from "./rigs/index.ts";
import type { RunpodRigs, RunpodTests } from "./runpod/index.ts";
import type { SecretBox } from "./secrets.ts";
import type { ControlStore } from "./store/index.ts";

/**
 * Control's pages, as its API mounts them: the API is a domain module and never imports page code,
 * so whoever makes control (its main, a test's stack, the demo) hands it the dashboard's mount
 * (dashboard/index.ts's mountDashboard). Without it, control serves REST and MCP only.
 */

/** What control gives its pages (the dashboard's createDashboard). */
export interface PageOptions {
  /** The owner's credential (the dashboard signs in with its token). */
  admin: Credential;
  privateKeyPem: string;
  staleAfterMs: number;
  driver?: DeploymentDriver | undefined;
  /** Days a dashboard session lasts without use (default 30). */
  sessionDays?: number | undefined;
  /** Seals the model providers' API keys (the settings page). */
  secrets: SecretBox;
  /** ChatGPT subscriptions' sign-ins and logins (shared with the API, which renews them). */
  chatgpt?: ChatGPTLogins | undefined;
  /** How control reaches model providers to list their models (tests give their own). */
  providerFetch?: typeof fetch | undefined;
  /** Kits control writes (the new-campaign page); none: campaigns cannot be created here. */
  kits?: KitRepos | undefined;
  /** How control reads a project's repository (tests give their own). */
  probeRepo?: typeof probeRepository | undefined;
  /** How control reads a kit's kit.json from its repository (tests give their own). */
  readKit?: typeof readKitManifest | undefined;
  /** How control reaches GPU clouds' APIs (tests give their own). */
  cloudFetch?: typeof fetch | undefined;
  /** Test pods on GPU clouds (made by createControlApi). */
  runpodTests?: RunpodTests | undefined;
  /** What control is made of (parts.ts): the operations the dashboard, REST and MCP share. */
  parts: ControlParts;
  /** MCP servers for the agents (goal 068; made by createControlApi). */
  mcpServers?: McpServers | undefined;
  /** Rigs the owner launches on GPU clouds (made by createControlApi): the launch form, their pods. */
  runpodRigs?: RunpodRigs | undefined;
  /** Their stop, start, restart and terminate (made by createControlApi). */
  runpodDriver?: RunpodDriver | undefined;
  /** Control's own build, which each rig's is compared with (default: this process's). */
  control?: BuildInfo | undefined;
  /** After this long without a report a rig is offline (default: views.ts's OFFLINE_AFTER_MS). */
  offlineAfterMs?: number | undefined;
  /** Updates of rigs to control's version (tests give their own, with short waits). */
  rigUpdates?: RigUpdates | undefined;
  /** The exports rigs send control (made by createControlApi); none: control keeps none. */
  exportFiles?: ExportFiles | undefined;
  /** The knowledge base's files in control's state; none: the dashboard serves none. */
  kbFiles?: KbFiles | undefined;
}

/** Mounts control's pages on its app, where the API serves them, with what they need. */
export type MountPages = (app: Hono, store: ControlStore, o: PageOptions) => void;
