import type { DatabaseSync } from "node:sqlite";
import { openDatabase, transaction } from "../../common/sqlite.ts";
import {
  EFFORTS,
  type Effort,
  HARNESSES,
  type Harness,
  type ProviderType,
} from "../../core/agents.ts";
import { fingerprint } from "../../core/commands.ts";
import { RIG_ID } from "../../core/ids.ts";
import { CampaignArchive } from "./archive.ts";
import { AuditLog } from "./audit.ts";
import { Builds } from "./builds.ts";
import { BusKeys } from "./bus.ts";
import { CampaignVersions } from "./campaigns.ts";
import { ChampionPatches } from "./champions.ts";
import { Clusters } from "./clusters.ts";
import { IssuedCommands } from "./commands.ts";
import { Enrollments } from "./enrollments.ts";
import { EventsTable } from "./events.ts";
import { RigExports } from "./exports.ts";
import { CampaignFolders } from "./folders.ts";
import { GitAccessStore } from "./git-access.ts";
import { GpuClouds } from "./gpu-clouds.ts";
import { RigHistory } from "./history.ts";
import { JoinedRigs } from "./joined.ts";
import { KnowledgeBase } from "./kb/index.ts";
import { LiveLines } from "./live.ts";
import { Machines } from "./machines.ts";
import { McpServerRows } from "./mcp-servers.ts";
import { ModelAssignments } from "./models.ts";
import { BusPositions } from "./positions.ts";
import { CampaignProposals } from "./proposals.ts";
import { ModelProviders } from "./providers.ts";
import { ReachableAddresses } from "./reachable.ts";
import { RigRefusals } from "./refusals.ts";
import type { IngestReport } from "./report.ts";
import { FullResets } from "./resets.ts";
import { RetiredRigs } from "./retired.ts";
import { RigReports } from "./rig-reports.ts";
import { ReportedRigs } from "./rigs.ts";
import { RunpodStore } from "./runpod.ts";
import { RunRegistry } from "./runs.ts";
import { type MigrateGiven, migrateStore } from "./schema.ts";
import { UiSessions } from "./sessions.ts";
import { TunnelRigs } from "./tunnels.ts";
import { RigUpdates } from "./updates.ts";
import { UsageRecords } from "./usage.ts";

/**
 * Control's store: rigs, what control derives from the events they report (the events themselves
 * are on the message bus, control/events), and command queues. A single control process owns it.
 *
 * Its tables are kept by sub-stores, one for each domain (goal 125, T6), in store/: each owns its
 * tables' SQL, and no other production code reads or writes them.
 */

export { cursorOf } from "./audit.ts";
export type { RigComponent, StoredBuild } from "./builds.ts";
export type { BusIdentityName } from "./bus.ts";
export type { CampaignSources, CopiedFrom } from "./campaigns.ts";
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
  KbTotals,
} from "./kb/index.ts";
export { OPEN_TRIAL_LINES } from "./live.ts";
export type { Machine, MachineRig } from "./machines.ts";
export type { McpServerRows } from "./mcp-servers.ts";
export { AGENT_ROLES, type AgentRole, codexTakes, harnessOf } from "./models.ts";
export type { CampaignProposal, ProposedField } from "./proposals.ts";
export type { ModelProvider, ProviderModel } from "./providers.ts";
export type { ReachableAddress } from "./reachable.ts";
export type { RigRefusal } from "./refusals.ts";
export type { StoredRunpodRig, StoredRunpodTest } from "./runpod.ts";
export type { RegisteredRun } from "./runs.ts";
export type { TunnelRig } from "./tunnels.ts";
export type { RunningRun } from "./usage.ts";
export type { IngestReport };
export { EFFORTS, type Effort, fingerprint, HARNESSES, type Harness, type ProviderType, RIG_ID };

export class ControlStore {
  readonly db: DatabaseSync;
  // One sub-store for each domain, each over this database (goal 125, T6).
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
  readonly rigUpdates: RigUpdates;
  readonly mcpServers: McpServerRows;
  /** Changes the operator proposes to a campaign's settings, for the owner to approve. */
  readonly proposals: CampaignProposals;
  /** How far the store applied the bus's streams: the events stream's apply (control/events). */
  readonly busPositions: BusPositions;
  /** The addresses cluster rigs' harnesses may reach beside the internet, set by the owner. */
  readonly reachable: ReachableAddresses;
  private knowledge: KnowledgeBase | undefined;

  /** The store's file, or `:memory:`. */
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.db = openDatabase(path);
    migrateStore(this.db, path);
    // Each sub-store holds the store and its database, and calls no other while it is built.
    this.reportedRigs = new ReportedRigs(this, this.db);
    this.eventsTable = new EventsTable(this, this.db);
    this.liveLines = new LiveLines(this, this.db);
    this.rigReports = new RigReports(this, this.db);
    this.fullResets = new FullResets(this, this.db);
    this.uiSessions = new UiSessions(this, this.db);
    this.auditLog = new AuditLog(this, this.db);
    this.championPatches = new ChampionPatches(this, this.db);
    this.exports = new RigExports(this, this.db);
    this.modelProviders = new ModelProviders(this, this.db);
    this.agentModels = new ModelAssignments(this, this.db);
    this.usage = new UsageRecords(this, this.db);
    this.commands = new IssuedCommands(this, this.db);
    this.runRegistry = new RunRegistry(this, this.db);
    this.gitAccess = new GitAccessStore(this, this.db);
    this.machines = new Machines(this, this.db);
    this.rigHistory = new RigHistory(this, this.db);
    this.joinedRigs = new JoinedRigs(this, this.db);
    this.gpuClouds = new GpuClouds(this, this.db);
    this.retired = new RetiredRigs(this, this.db);
    this.builds = new Builds(this, this.db);
    this.refusals = new RigRefusals(this, this.db);
    this.tunnels = new TunnelRigs(this, this.db);
    this.runpod = new RunpodStore(this, this.db);
    this.clusters = new Clusters(this, this.db);
    this.campaigns = new CampaignVersions(this, this.db);
    this.folders = new CampaignFolders(this, this.db);
    this.archive = new CampaignArchive(this, this.db);
    this.enrollments = new Enrollments(this, this.db);
    this.busKeys = new BusKeys(this, this.db);
    this.rigUpdates = new RigUpdates(this, this.db);
    this.mcpServers = new McpServerRows(this, this.db);
    this.proposals = new CampaignProposals(this, this.db);
    this.busPositions = new BusPositions(this, this.db);
    this.reachable = new ReachableAddresses(this, this.db);
  }

  /**
   * Brings the store as far as it may go now, given what control found outside it: the events
   * table goes once the move found the events stream to hold it whole (schema.ts). Returns the path
   * of a copy of the store kept outside the copies' rotation, made now.
   */
  migrate(given: MigrateGiven): string | undefined {
    return migrateStore(this.db, this.path, given);
  }

  /**
   * Runs fn in one transaction: all of it is kept, or none of it. Nested calls become savepoints
   * of the outer one. For writes to more than one sub-store that stand or fall together.
   */
  tx<T>(fn: () => T): T {
    return transaction(this.db, fn);
  }

  /**
   * Thermite's own knowledge base (goal 065), which the apply of the events stream feeds
   * (control/events) as it applies each event. It makes its tables on first use.
   */
  kb(): KnowledgeBase {
    this.knowledge ??= new KnowledgeBase(this.db);
    return this.knowledge;
  }
}
