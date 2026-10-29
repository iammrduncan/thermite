import { createPublicKey } from "node:crypto";
import { Loops } from "../common/health.ts";
import type { BuildInfo } from "../core/version.ts";
import type { BusView } from "./bus/index.ts";
import { type ClusterKubectl, realKubectl } from "./clusters/index.ts";
import type { KitRepos } from "./kits/index.ts";
import { RunpodDriver } from "./lifecycle.ts";
import { Screens } from "./live/index.ts";
import { type MachineSsh, openSsh, type RigBus } from "./machines/index.ts";
import { McpServers } from "./mcp-servers/index.ts";
import { PageNotes } from "./notes.ts";
import { ChatGPTLogins, PlanUsageReader } from "./providers/index.ts";
import type { RigImages } from "./rigs/index.ts";
import { ControlTunnels, RunpodRigs, RunpodTests } from "./runpod/index.ts";
import { SecretBox } from "./secrets.ts";
import type { ControlStore } from "./store/index.ts";
import { keepFolds, type RigView, type RunOnRig } from "./views/index.ts";

/**
 * What control is made of, built once in createControlApi (goal 125, T5): the dashboard, REST
 * and MCP each call the same operations on it (rigs/agent-models.ts, campaigns/start-run.ts and the like), so
 * each has one set of checks and one set of refusals in words.
 */
export interface ControlParts {
  store: ControlStore;
  /** Control's signing key: every command it sends a rig is signed with it. */
  privateKeyPem: string;
  /** Its public key, which every rig control sets up pins. */
  controlPublicKey: string;
  /** Control's address as rigs and machines reach it (THERMITE_CONTROL_PUBLIC_URL). */
  publicUrl?: string | undefined;
  /** The images control deploys rigs from (none: control can't set rigs up). */
  rigImages?: RigImages | undefined;
  /**
   * The message bus as the rigs control sets up reach it: its address, and control's authority
   * they trust its server through. None: those rigs keep to HTTP.
   */
  rigBus?: RigBus | undefined;
  /** How control reaches machines over SSH. */
  machineSsh: MachineSsh;
  /** How control reaches Kubernetes clusters. */
  kube: ClusterKubectl;
  /** Seals every key and sign-in control stores. */
  secrets: SecretBox;
  /** The kits control keeps (New campaign, Start a run); none: it keeps none. */
  kits?: KitRepos | undefined;
  /** ChatGPT subscriptions' logins: control alone renews them (the dashboard signs them in). */
  chatgpt: ChatGPTLogins;
  /** Subscriptions' usage windows (goal 151), on Providers and over MCP. */
  planUsage: PlanUsageReader;
  /** Test pods on GPU clouds. */
  runpodTests: RunpodTests;
  /** MCP servers for the agents (goal 068). */
  mcpServers: McpServers;
  /** Control's end of the tunnels of rigs in pull mode. */
  tunnels: ControlTunnels;
  /** Rigs the owner launches on RunPod: a stopped pod is started before its run is assigned. */
  runpodRigs: RunpodRigs;
  /** Their stop, start, restart and terminate, beside the driver THERMITE_LIFECYCLE names. */
  runpodDriver: RunpodDriver;
  /** The message bus (THERMITE_NATS_URL), for its state; none only in a test's control. */
  bus?: BusView | undefined;
  /** Control's loops and when each last came around, for its health route (goal 173). */
  loops: Loops;
  /** Why a dashboard form failed, kept for the page it returns to (notes.ts). */
  notes: PageNotes;
  /** The screens of the trials the owner watches, in memory only (goal 169). */
  screens: Screens;
  /** Every rig as control sees it now (views.ts), through the folds control keeps. */
  views(): RigView[];
  /**
   * A run wherever it ran (goal 170), read now; undefined for a run no rig created. A run of an
   * earlier ledger may be read from the message bus first.
   */
  run(id: string): Promise<RunOnRig | undefined>;
  /** Every run of a campaign a rig created, newest first, earlier ones too (goal 170). */
  campaignRuns(campaign: string): Promise<RunOnRig[]>;
}

/** What controlParts takes from control's options; tests give their own of each. */
export interface PartsOptions {
  staleAfterMs: number;
  secrets?: SecretBox | undefined;
  kits?: KitRepos | undefined;
  publicUrl?: string | undefined;
  rigImages?: RigImages | undefined;
  rigBus?: RigBus | undefined;
  machineSsh?: MachineSsh | undefined;
  clusterKubectl?: ClusterKubectl | undefined;
  providerFetch?: typeof fetch | undefined;
  cloudFetch?: typeof fetch | undefined;
  runpodTests?: RunpodTests | undefined;
  runpodTestImage?: string | undefined;
  mcpServers?: McpServers | undefined;
  tunnels?: ControlTunnels | undefined;
  runpodRigs?: RunpodRigs | undefined;
  runpodRigImage?: string | undefined;
  bus?: BusView | undefined;
  /** Control's loops (tests give their own clock). */
  loops?: Loops | undefined;
}

/** Control's parts, made from the store, its key and its options. */
export function controlParts(
  store: ControlStore,
  privateKeyPem: string,
  opts: PartsOptions,
  viewOpts: { staleAfterMs: number; offlineAfterMs?: number | undefined; control: BuildInfo },
): ControlParts {
  const secrets = opts.secrets ?? SecretBox.ephemeral();
  const chatgpt = new ChatGPTLogins(store, secrets, opts.providerFetch);
  const runpodTests =
    opts.runpodTests ??
    new RunpodTests(store, secrets, { fetch: opts.cloudFetch, image: opts.runpodTestImage });
  // MCP servers: made first, so an older control's outside knowledge bases become servers now.
  const mcpServers = opts.mcpServers ?? new McpServers(store, secrets);
  // A rig in pull mode makes the same calls as any rig; control's end of the tunnel brings them
  // in-process, bound to the rig whose signed answer carried them.
  const tunnels = opts.tunnels ?? new ControlTunnels(store, secrets, privateKeyPem);
  // The rigs' events folded once and kept up to date: every view of the store reads through them.
  const folds = keepFolds(store);
  const runpodRigs =
    opts.runpodRigs ??
    new RunpodRigs(store, secrets, tunnels, {
      fetch: opts.cloudFetch,
      image: opts.runpodRigImage,
      staleAfterMs: opts.staleAfterMs,
      privateKeyPem,
    });
  return {
    store,
    privateKeyPem,
    controlPublicKey: createPublicKey(privateKeyPem)
      .export({ type: "spki", format: "pem" })
      .toString(),
    publicUrl: opts.publicUrl,
    rigImages: opts.rigImages,
    rigBus: opts.rigBus,
    machineSsh: opts.machineSsh ?? openSsh,
    kube: opts.clusterKubectl ?? realKubectl,
    secrets,
    kits: opts.kits,
    chatgpt,
    planUsage: new PlanUsageReader(store, (p) => chatgpt.usage(p)),
    runpodTests,
    mcpServers,
    tunnels,
    runpodRigs,
    runpodDriver: new RunpodDriver(runpodRigs),
    bus: opts.bus,
    loops: opts.loops ?? new Loops(),
    notes: new PageNotes(),
    screens: new Screens(),
    views: () => folds.views(viewOpts),
    run: (id) => folds.run(id, viewOpts),
    campaignRuns: (campaign) => folds.campaignRuns(campaign, viewOpts),
  };
}
