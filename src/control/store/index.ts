import {
  EFFORTS,
  type Effort,
  HARNESSES,
  type Harness,
  type ProviderType,
} from "../../core/agents.ts";
import { fingerprint } from "../../core/commands.ts";
import { RIG_ID } from "../../core/ids.ts";
import type { CampaignArchive } from "./archive.ts";
import type { AuditLog } from "./audit.ts";
import { keepBehind } from "./behind.ts";
import type { Builds } from "./builds.ts";
import type { BusKeys } from "./bus.ts";
import type { CampaignVersions } from "./campaigns.ts";
import type { ChampionPatches } from "./champions.ts";
import type { Clusters } from "./clusters.ts";
import type { IssuedCommands } from "./commands.ts";
import type { Enrollments } from "./enrollments.ts";
import type { EventsTable } from "./events.ts";
import type { RigExports } from "./exports.ts";
import type { CampaignFolders } from "./folders.ts";
import type { GitAccessStore } from "./git-access.ts";
import type { GpuClouds } from "./gpu-clouds.ts";
import type { RigHistory } from "./history.ts";
import type { JoinedRigs } from "./joined.ts";
import {
  type KnowledgeBase,
  SqliteKbFileRows,
  SqliteKbSettingRows,
  SqliteKnowledgeBase,
} from "./kb/index.ts";
import type { LiveLines } from "./live.ts";
import type { Machines } from "./machines.ts";
import type { McpServerRows } from "./mcp-servers.ts";
import type { ModelAssignments } from "./models.ts";
import type { OwnSettings } from "./own-settings.ts";
import type { BusPositions } from "./positions.ts";
import type { CampaignProposals } from "./proposals.ts";
import type { ModelProviders } from "./providers.ts";
import type { ReachableAddresses } from "./reachable.ts";
import type { RigRefusals } from "./refusals.ts";
import type { IngestReport } from "./report.ts";
import type { FullResets } from "./resets.ts";
import type { RetentionPolicies } from "./retention.ts";
import type { RetiredRigs } from "./retired.ts";
import type { RigReports } from "./rig-reports.ts";
import type { ReportedRigs } from "./rigs.ts";
import type { RunnerUse } from "./runner-use.ts";
import type { RigRunners } from "./runners.ts";
import type { RunpodStore } from "./runpod.ts";
import type { RunRegistry } from "./runs.ts";
import type { MigrateGiven } from "./schema.ts";
import type { UiSessions } from "./sessions.ts";
import type { StoreSize } from "./size.ts";
import { SqliteStore } from "./sqlite.ts";
import type { TunnelRigs } from "./tunnels.ts";
import type { RigUpdates } from "./updates.ts";
import type { UsageRecords } from "./usage.ts";
import { Turns, waiting, waitingOnce } from "./waits.ts";
import type { RigWorkers } from "./workers.ts";

/**
 * Control's store: rigs, what control derives from the events they report (the events themselves
 * are on the message bus, control/events), and command queues.
 *
 * This is its interface (goal 267), and the one way the rest of control calls it. Each of its
 * calls gives its answer later: the caller waits for it. The store behind is SQLite (sqlite.ts),
 * one file that one control process owns; all of control's SQL is in this folder, and no file
 * outside it reaches the database.
 *
 * Its tables are kept by sub-stores, one for each domain (goal 125, T6): each owns its tables'
 * SQL, and no other production code reads or writes them.
 */

export {
  AUDIT_ACTORS,
  AUDIT_KINDS,
  type AuditEntry,
  type AuditFilter,
  cursorOf,
  RETENTION_REMOVED_ACTION,
} from "./audit.ts";
export type { RigComponent, StoredBuild } from "./builds.ts";
export type { BusIdentityName } from "./bus.ts";
export type { CampaignResults, CampaignSources, CopiedFrom } from "./campaigns.ts";
export type {
  Cluster,
  ClusterRig,
  ClusterRigResize,
  ClusterRigSize,
} from "./clusters.ts";
export type { CommandRow, Decision } from "./commands.ts";
export type { EventsMoved, StoredEvent } from "./events.ts";
export type { RigExport } from "./exports.ts";
export { GIT_HOST, GIT_HOST_WORDS, type GitAccess } from "./git-access.ts";
export type { JoinedRig } from "./joined.ts";
export type {
  KbCounts,
  KbFind,
  KbFindAnswer,
  KbFolderRow,
  KbListAt,
  KbListCounts,
  KbListed,
  KbSettingKey,
  KbStoredFigures,
  KbTextState,
  KbTotals,
} from "./kb/index.ts";
export { KB_STORED_FILES } from "./kb/index.ts";
export { OPEN_TRIAL_LINES } from "./live.ts";
export type { Machine, MachineRig } from "./machines.ts";
export { AGENT_ROLES, type AgentRole, codexTakes, harnessOf } from "./models.ts";
export type { CampaignProposal, ProposedField } from "./proposals.ts";
export type { ModelProvider, ProviderModel } from "./providers.ts";
export type { ReachableAddress } from "./reachable.ts";
export type { RigRefusal } from "./refusals.ts";
export type { RetentionRemovalRow } from "./retention.ts";
export type { RunnerUseSample } from "./runner-use.ts";
export type { RigRunner } from "./runners.ts";
export type { StoredRunpodRig, StoredRunpodTest } from "./runpod.ts";
export type { RegisteredRun } from "./runs.ts";
export { STORE_VERSION } from "./schema.ts";
export type { DbFigures } from "./size.ts";
export type { TunnelRig } from "./tunnels.ts";
export type { RunningRun } from "./usage.ts";
export type { IngestReport };
export { EFFORTS, type Effort, fingerprint, HARNESSES, type Harness, type ProviderType, RIG_ID };

/**
 * Control's store, as every caller outside this folder sees it: one sub-store for each domain,
 * each an interface whose calls give a promise. Wait for it, and for a call that gives nothing
 * too, since the call may fail.
 */
export interface ControlStore {
  /** The store's file, or `:memory:`. */
  readonly path: string;
  /** The rigs as they report: their rows, report-signing keys and supervisors' figures. */
  readonly reportedRigs: ReportedRigs;
  /** The events table of a store from before the events stream, until it is moved there. */
  readonly eventsTable: EventsTable;
  readonly liveLines: LiveLines;
  readonly rigReports: RigReports;
  readonly fullResets: FullResets;
  readonly uiSessions: UiSessions;
  readonly auditLog: AuditLog;
  readonly championPatches: ChampionPatches;
  readonly exports: RigExports;
  readonly modelProviders: ModelProviders;
  readonly agentModels: ModelAssignments;
  readonly usage: UsageRecords;
  readonly commands: IssuedCommands;
  readonly runRegistry: RunRegistry;
  readonly gitAccess: GitAccessStore;
  readonly machines: Machines;
  readonly rigHistory: RigHistory;
  readonly joinedRigs: JoinedRigs;
  readonly gpuClouds: GpuClouds;
  readonly retired: RetiredRigs;
  readonly builds: Builds;
  readonly refusals: RigRefusals;
  readonly tunnels: TunnelRigs;
  readonly runpod: RunpodStore;
  readonly clusters: Clusters;
  readonly campaigns: CampaignVersions;
  readonly folders: CampaignFolders;
  readonly archive: CampaignArchive;
  readonly enrollments: Enrollments;
  readonly busKeys: BusKeys;
  /** The runner processes control set up for its rigs (goal 206). */
  readonly rigRunners: RigRunners;
  /** Add a rig's Workers at a time, until the new rig takes it (goal 206). */
  readonly rigWorkers: RigWorkers;
  /** How a rig's runners spent their time (goal 231). */
  readonly runnerUse: RunnerUse;
  readonly rigUpdates: RigUpdates;
  readonly mcpServers: McpServerRows;
  /** Changes the operator proposes to a campaign's settings, for the owner to approve. */
  readonly proposals: CampaignProposals;
  /** How far the store applied the bus's streams: the events stream's apply (control/events). */
  readonly busPositions: BusPositions;
  /** The addresses cluster rigs' harnesses may reach beside the internet, set by the owner. */
  readonly reachable: ReachableAddresses;
  /** Control's own settings the owner sets on control (store migration 27). */
  readonly ownSettings: OwnSettings;
  /** The owner's retention policies, what they removed, and what each rig keeps (goal 125). */
  readonly retention: RetentionPolicies;
  /** control.db's own size, as SQLite counts it, for Metrics (goal 179). */
  readonly size: StoreSize;
  /**
   * Runs `fn` in one transaction: all of its calls to the store are kept, or none of them. A
   * call inside another is a savepoint of the outer one. For writes that stand or fall together,
   * and for a read that a write relies on. While it is open, every other caller of the store
   * waits; so `fn` waits for the store and for nothing else.
   */
  tx<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Does `fn` once what the caller wrote is kept: at once outside a transaction; inside one, when
   * the outermost one is kept, and never when it is dropped. For what leaves control and can't be
   * taken back, such as a command published to a rig: a transaction that is dropped must not
   * have sent it. It answers at once, and `fn` waits for nothing.
   */
  onceKept(fn: () => void): void;
  /**
   * Thermite's own knowledge base (goal 065), which the apply of the events stream feeds
   * (control/events) as it applies each event. It is made at its first call.
   */
  kb(): KnowledgeBase;
  /**
   * Brings the store as far as it may go now, given what control found outside it: the events
   * table goes once the move found the events stream to hold it whole (schema.ts). Gives the path
   * of a copy of the store kept outside the copies' rotation, made now.
   */
  migrate(given: MigrateGiven): Promise<string | undefined>;
  /** Closes the store. No call is made after it. */
  close(): Promise<void>;
}

/**
 * Opens control's store at `path` (`:memory:` for one in memory) and brings it to this code's
 * version (schema.ts).
 */
export function openControlStore(path: string): ControlStore {
  const sqlite = new SqliteStore(path);
  const turns = new Turns();
  // Made at its first call, in that call's turn: making it writes to the store.
  const kb: KnowledgeBase = {
    ...waitingOnce(SqliteKnowledgeBase.prototype, () => sqlite.kb(), turns),
    files: waitingOnce(SqliteKbFileRows.prototype, () => sqlite.kb().files, turns),
    settings: waitingOnce(SqliteKbSettingRows.prototype, () => sqlite.kb().settings, turns),
  };
  // Each sub-store's waiting calls stand where its interface is asked for: a call the SQLite
  // class has and its interface names otherwise does not typecheck here.
  const store: ControlStore = {
    path: sqlite.path,
    reportedRigs: waiting(sqlite.reportedRigs, turns),
    eventsTable: waiting(sqlite.eventsTable, turns),
    liveLines: waiting(sqlite.liveLines, turns, ["watch"]),
    rigReports: waiting(sqlite.rigReports, turns),
    fullResets: waiting(sqlite.fullResets, turns),
    uiSessions: waiting(sqlite.uiSessions, turns),
    auditLog: waiting(sqlite.auditLog, turns),
    championPatches: waiting(sqlite.championPatches, turns),
    exports: waiting(sqlite.exports, turns),
    modelProviders: waiting(sqlite.modelProviders, turns),
    agentModels: waiting(sqlite.agentModels, turns),
    usage: waiting(sqlite.usage, turns),
    commands: waiting(sqlite.commands, turns),
    runRegistry: waiting(sqlite.runRegistry, turns),
    gitAccess: waiting(sqlite.gitAccess, turns),
    machines: waiting(sqlite.machines, turns),
    rigHistory: waiting(sqlite.rigHistory, turns),
    joinedRigs: waiting(sqlite.joinedRigs, turns),
    gpuClouds: waiting(sqlite.gpuClouds, turns),
    retired: waiting(sqlite.retired, turns),
    builds: waiting(sqlite.builds, turns),
    refusals: waiting(sqlite.refusals, turns),
    tunnels: waiting(sqlite.tunnels, turns),
    runpod: waiting(sqlite.runpod, turns),
    clusters: waiting(sqlite.clusters, turns),
    campaigns: waiting(sqlite.campaigns, turns),
    folders: waiting(sqlite.folders, turns),
    archive: waiting(sqlite.archive, turns),
    enrollments: waiting(sqlite.enrollments, turns),
    busKeys: waiting(sqlite.busKeys, turns),
    rigRunners: waiting(sqlite.rigRunners, turns),
    rigWorkers: waiting(sqlite.rigWorkers, turns),
    runnerUse: waiting(sqlite.runnerUse, turns),
    rigUpdates: waiting(sqlite.rigUpdates, turns),
    mcpServers: waiting(sqlite.mcpServers, turns),
    proposals: waiting(sqlite.proposals, turns),
    busPositions: waiting(sqlite.busPositions, turns),
    reachable: waiting(sqlite.reachable, turns),
    ownSettings: waiting(sqlite.ownSettings, turns),
    retention: waiting(sqlite.retention, turns),
    size: waiting(sqlite.size, turns),
    tx: <T>(fn: () => Promise<T>) => turns.tx(sqlite.db, fn),
    onceKept: (fn: () => void) => turns.onceKept(fn),
    kb: () => kb,
    migrate: (given: MigrateGiven) => turns.call(() => sqlite.migrate(given)),
    close: () => turns.call(() => sqlite.db.close()),
  };
  keepBehind(store, sqlite);
  return store;
}

export type { KnowledgeBase, McpServerRows };
