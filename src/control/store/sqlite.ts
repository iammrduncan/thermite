import type { DatabaseSync } from "node:sqlite";
import { openDatabase, transaction } from "../../common/sqlite.ts";
import { SqliteCampaignArchive } from "./archive.ts";
import { SqliteAuditLog } from "./audit.ts";
import { SqliteBuilds } from "./builds.ts";
import { SqliteBusKeys } from "./bus.ts";
import { SqliteCampaignVersions } from "./campaigns.ts";
import { SqliteChampionPatches } from "./champions.ts";
import { SqliteClusters } from "./clusters.ts";
import { SqliteIssuedCommands } from "./commands.ts";
import { SqliteEnrollments } from "./enrollments.ts";
import { SqliteEventsTable } from "./events.ts";
import { SqliteRigExports } from "./exports.ts";
import { SqliteCampaignFolders } from "./folders.ts";
import { SqliteGitAccessStore } from "./git-access.ts";
import { SqliteGpuClouds } from "./gpu-clouds.ts";
import { SqliteRigHistory } from "./history.ts";
import { SqliteJoinedRigs } from "./joined.ts";
import { SqliteKnowledgeBase } from "./kb/index.ts";
import { SqliteLiveLines } from "./live.ts";
import { SqliteMachines } from "./machines.ts";
import { SqliteMcpServerRows } from "./mcp-servers.ts";
import { SqliteModelAssignments } from "./models.ts";
import { SqliteOwnSettings } from "./own-settings.ts";
import { SqliteBusPositions } from "./positions.ts";
import { SqliteCampaignProposals } from "./proposals.ts";
import { SqliteModelProviders } from "./providers.ts";
import { SqliteReachableAddresses } from "./reachable.ts";
import { SqliteRigRefusals } from "./refusals.ts";
import { SqliteFullResets } from "./resets.ts";
import { SqliteRetentionPolicies } from "./retention.ts";
import { SqliteRetiredRigs } from "./retired.ts";
import { SqliteRigReports } from "./rig-reports.ts";
import { SqliteReportedRigs } from "./rigs.ts";
import { SqliteRunnerUse } from "./runner-use.ts";
import { SqliteRigRunners } from "./runners.ts";
import { SqliteRunpodStore } from "./runpod.ts";
import { SqliteRunRegistry } from "./runs.ts";
import { type MigrateGiven, migrateStore } from "./schema.ts";
import { SqliteUiSessions } from "./sessions.ts";
import { SqliteStoreSize } from "./size.ts";
import { SqliteTunnelRigs } from "./tunnels.ts";
import { SqliteRigUpdates } from "./updates.ts";
import { SqliteUsageRecords } from "./usage.ts";
import { SqliteRigWorkers } from "./workers.ts";

/**
 * Control's store on SQLite: one file (or one database in memory), opened once by one process.
 * Each of its calls answers at once. Nothing outside this folder calls it: the rest of control
 * calls the store through its interface (index.ts), whose calls wait, and this is the store
 * behind it (waits.ts).
 *
 * Its tables are kept by sub-stores, one for each domain (goal 125, T6): each owns its tables'
 * SQL, and no other production code reads or writes them.
 */

export class SqliteStore {
  readonly db: DatabaseSync;
  // One sub-store for each domain, each over this database (goal 125, T6).
  /** The rigs as they report: their rows, report-signing keys and supervisors' figures. */
  readonly reportedRigs: SqliteReportedRigs;
  /** The events table of a store from before the events stream, until it is moved there. */
  readonly eventsTable: SqliteEventsTable;
  readonly liveLines: SqliteLiveLines;
  readonly rigReports: SqliteRigReports;
  readonly fullResets: SqliteFullResets;
  readonly uiSessions: SqliteUiSessions;
  readonly auditLog: SqliteAuditLog;
  readonly championPatches: SqliteChampionPatches;
  readonly exports: SqliteRigExports;
  readonly modelProviders: SqliteModelProviders;
  readonly agentModels: SqliteModelAssignments;
  readonly usage: SqliteUsageRecords;
  readonly commands: SqliteIssuedCommands;
  readonly runRegistry: SqliteRunRegistry;
  readonly gitAccess: SqliteGitAccessStore;
  readonly machines: SqliteMachines;
  readonly rigHistory: SqliteRigHistory;
  readonly joinedRigs: SqliteJoinedRigs;
  readonly gpuClouds: SqliteGpuClouds;
  readonly retired: SqliteRetiredRigs;
  readonly builds: SqliteBuilds;
  readonly refusals: SqliteRigRefusals;
  readonly tunnels: SqliteTunnelRigs;
  readonly runpod: SqliteRunpodStore;
  readonly clusters: SqliteClusters;
  readonly campaigns: SqliteCampaignVersions;
  readonly folders: SqliteCampaignFolders;
  readonly archive: SqliteCampaignArchive;
  readonly enrollments: SqliteEnrollments;
  readonly busKeys: SqliteBusKeys;
  /** The runner processes control set up for its rigs (goal 206). */
  readonly rigRunners: SqliteRigRunners;
  /** Add a rig's Workers at a time, until the new rig takes it (goal 206). */
  readonly rigWorkers: SqliteRigWorkers;
  /** How a rig's runners spent their time (goal 231). */
  readonly runnerUse: SqliteRunnerUse;
  readonly rigUpdates: SqliteRigUpdates;
  readonly mcpServers: SqliteMcpServerRows;
  /** Changes the operator proposes to a campaign's settings, for the owner to approve. */
  readonly proposals: SqliteCampaignProposals;
  /** How far the store applied the bus's streams: the events stream's apply (control/events). */
  readonly busPositions: SqliteBusPositions;
  /** The addresses cluster rigs' harnesses may reach beside the internet, set by the owner. */
  readonly reachable: SqliteReachableAddresses;
  /** Control's own settings the owner sets on control (store migration 27). */
  readonly ownSettings: SqliteOwnSettings;
  /** The owner's retention policies, what they removed, and what each rig keeps (goal 125). */
  readonly retention: SqliteRetentionPolicies;
  /** control.db's own size, as SQLite counts it, for Metrics (goal 179). */
  readonly size: SqliteStoreSize;
  private knowledge: SqliteKnowledgeBase | undefined;

  /** The store's file, or `:memory:`. */
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.db = openDatabase(path);
    migrateStore(this.db, path);
    // Each sub-store holds the store and its database, and calls no other while it is built.
    this.reportedRigs = new SqliteReportedRigs(this, this.db);
    this.eventsTable = new SqliteEventsTable(this, this.db);
    this.liveLines = new SqliteLiveLines(this, this.db);
    this.rigReports = new SqliteRigReports(this, this.db);
    this.fullResets = new SqliteFullResets(this, this.db);
    this.uiSessions = new SqliteUiSessions(this, this.db);
    this.auditLog = new SqliteAuditLog(this, this.db);
    this.championPatches = new SqliteChampionPatches(this, this.db);
    this.exports = new SqliteRigExports(this, this.db);
    this.modelProviders = new SqliteModelProviders(this, this.db);
    this.agentModels = new SqliteModelAssignments(this, this.db);
    this.usage = new SqliteUsageRecords(this, this.db);
    this.commands = new SqliteIssuedCommands(this, this.db);
    this.runRegistry = new SqliteRunRegistry(this, this.db);
    this.gitAccess = new SqliteGitAccessStore(this, this.db);
    this.machines = new SqliteMachines(this, this.db);
    this.rigHistory = new SqliteRigHistory(this, this.db);
    this.joinedRigs = new SqliteJoinedRigs(this, this.db);
    this.gpuClouds = new SqliteGpuClouds(this, this.db);
    this.retired = new SqliteRetiredRigs(this, this.db);
    this.builds = new SqliteBuilds(this, this.db);
    this.refusals = new SqliteRigRefusals(this, this.db);
    this.tunnels = new SqliteTunnelRigs(this, this.db);
    this.runpod = new SqliteRunpodStore(this, this.db);
    this.clusters = new SqliteClusters(this, this.db);
    this.campaigns = new SqliteCampaignVersions(this, this.db);
    this.folders = new SqliteCampaignFolders(this, this.db);
    this.archive = new SqliteCampaignArchive(this, this.db);
    this.enrollments = new SqliteEnrollments(this, this.db);
    this.busKeys = new SqliteBusKeys(this, this.db);
    this.rigRunners = new SqliteRigRunners(this, this.db);
    this.rigWorkers = new SqliteRigWorkers(this, this.db);
    this.runnerUse = new SqliteRunnerUse(this, this.db);
    this.rigUpdates = new SqliteRigUpdates(this, this.db);
    this.mcpServers = new SqliteMcpServerRows(this, this.db);
    this.proposals = new SqliteCampaignProposals(this, this.db);
    this.busPositions = new SqliteBusPositions(this, this.db);
    this.reachable = new SqliteReachableAddresses(this, this.db);
    this.ownSettings = new SqliteOwnSettings(this, this.db);
    this.retention = new SqliteRetentionPolicies(this, this.db);
    this.size = new SqliteStoreSize(this, this.db);
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
  kb(): SqliteKnowledgeBase {
    this.knowledge ??= new SqliteKnowledgeBase(this.db);
    return this.knowledge;
  }
}
