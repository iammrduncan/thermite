import type { Sql } from "../../../common/postgres.ts";
import { PostgresKnowledgeBase } from "../kb/index.ts";
import type { MigrateGiven } from "../schema.ts";
import { PostgresCampaignArchive } from "./archive.ts";
import { PostgresAuditLog } from "./audit.ts";
import { PostgresBuilds } from "./builds.ts";
import { PostgresBusKeys } from "./bus.ts";
import { PostgresCampaignVersions } from "./campaigns.ts";
import { PostgresChampionPatches } from "./champions.ts";
import { PostgresClusters } from "./clusters.ts";
import { PostgresIssuedCommands } from "./commands.ts";
import { PostgresEnrollments } from "./enrollments.ts";
import { PostgresEventsTable } from "./events.ts";
import { PostgresRigExports } from "./exports.ts";
import { PostgresCampaignFolders } from "./folders.ts";
import { PostgresGitAccessStore } from "./git-access.ts";
import { PostgresGpuClouds } from "./gpu-clouds.ts";
import { PostgresRigHistory } from "./history.ts";
import { PostgresJoinedRigs } from "./joined.ts";
import { PostgresLiveLines } from "./live.ts";
import { PostgresMachines } from "./machines.ts";
import { PostgresMcpServerRows } from "./mcp-servers.ts";
import { PostgresModelAssignments } from "./models.ts";
import { PostgresOwnSettings } from "./own-settings.ts";
import { PostgresBusPositions } from "./positions.ts";
import { PostgresCampaignProposals } from "./proposals.ts";
import { PostgresModelProviders } from "./providers.ts";
import { PostgresReachableAddresses } from "./reachable.ts";
import { PostgresRigRefusals } from "./refusals.ts";
import { PostgresFullResets } from "./resets.ts";
import { PostgresRetentionPolicies } from "./retention.ts";
import { PostgresRetiredRigs } from "./retired.ts";
import { PostgresRigReports } from "./rig-reports.ts";
import { PostgresReportedRigs } from "./rigs.ts";
import { PostgresRunnerUse } from "./runner-use.ts";
import { PostgresRigRunners } from "./runners.ts";
import { PostgresRunpodStore } from "./runpod.ts";
import { PostgresRunRegistry } from "./runs.ts";
import { PostgresUiSessions } from "./sessions.ts";
import { PostgresStoreSize } from "./size.ts";
import { PostgresTunnelRigs } from "./tunnels.ts";
import { PostgresRigUpdates } from "./updates.ts";
import { PostgresUsageRecords } from "./usage.ts";
import { PostgresRigWorkers } from "./workers.ts";

/**
 * Control's store on PostgreSQL (goal 268): one database, reached over one connection by the one
 * control process that writes. Nothing outside this folder calls it: the rest of control calls
 * the store through its interface (../index.ts), and this is the store behind it, as the SQLite
 * store is (../sqlite.ts). Until the move (goal 270) it is for trial.
 *
 * Its tables are kept by sub-stores, one for each domain, each the PostgreSQL form of the SQLite
 * sub-store of the same name.
 */
export class PostgresStore {
  readonly q: Sql;
  /** The rigs as they report: their rows, report-signing keys and supervisors' figures. */
  readonly reportedRigs: PostgresReportedRigs;
  /** The events table of a store from before the events stream, until it is moved there. */
  readonly eventsTable: PostgresEventsTable;
  readonly liveLines: PostgresLiveLines;
  readonly rigReports: PostgresRigReports;
  readonly fullResets: PostgresFullResets;
  readonly uiSessions: PostgresUiSessions;
  readonly auditLog: PostgresAuditLog;
  readonly championPatches: PostgresChampionPatches;
  readonly exports: PostgresRigExports;
  readonly modelProviders: PostgresModelProviders;
  readonly agentModels: PostgresModelAssignments;
  readonly usage: PostgresUsageRecords;
  readonly commands: PostgresIssuedCommands;
  readonly runRegistry: PostgresRunRegistry;
  readonly gitAccess: PostgresGitAccessStore;
  readonly machines: PostgresMachines;
  readonly rigHistory: PostgresRigHistory;
  readonly joinedRigs: PostgresJoinedRigs;
  readonly gpuClouds: PostgresGpuClouds;
  readonly retired: PostgresRetiredRigs;
  readonly builds: PostgresBuilds;
  readonly refusals: PostgresRigRefusals;
  readonly tunnels: PostgresTunnelRigs;
  readonly runpod: PostgresRunpodStore;
  readonly clusters: PostgresClusters;
  readonly campaigns: PostgresCampaignVersions;
  readonly folders: PostgresCampaignFolders;
  readonly archive: PostgresCampaignArchive;
  readonly enrollments: PostgresEnrollments;
  readonly busKeys: PostgresBusKeys;
  /** The runner processes control set up for its rigs (goal 206). */
  readonly rigRunners: PostgresRigRunners;
  /** Add a rig's Workers at a time, until the new rig takes it (goal 206). */
  readonly rigWorkers: PostgresRigWorkers;
  /** How a rig's runners spent their time (goal 231). */
  readonly runnerUse: PostgresRunnerUse;
  readonly rigUpdates: PostgresRigUpdates;
  readonly mcpServers: PostgresMcpServerRows;
  /** Changes the operator proposes to a campaign's settings, for the owner to approve. */
  readonly proposals: PostgresCampaignProposals;
  /** How far the store applied the bus's streams: the events stream's apply (control/events). */
  readonly busPositions: PostgresBusPositions;
  /** The addresses cluster rigs' harnesses may reach beside the internet, set by the owner. */
  readonly reachable: PostgresReachableAddresses;
  /** Control's own settings the owner sets on control (store migration 27). */
  readonly ownSettings: PostgresOwnSettings;
  /** The owner's retention policies, what they removed, and what each rig keeps (goal 125). */
  readonly retention: PostgresRetentionPolicies;
  /** control.db's own size, as SQLite counts it, for Metrics (goal 179). */
  readonly size: PostgresStoreSize;
  private knowledge: PostgresKnowledgeBase | undefined;

  constructor(q: Sql) {
    this.q = q;
    // Each sub-store holds the store and its statements, and calls no other while it is built.
    this.reportedRigs = new PostgresReportedRigs(this, this.q);
    this.eventsTable = new PostgresEventsTable(this, this.q);
    this.liveLines = new PostgresLiveLines(this, this.q);
    this.rigReports = new PostgresRigReports(this, this.q);
    this.fullResets = new PostgresFullResets(this, this.q);
    this.uiSessions = new PostgresUiSessions(this, this.q);
    this.auditLog = new PostgresAuditLog(this, this.q);
    this.championPatches = new PostgresChampionPatches(this, this.q);
    this.exports = new PostgresRigExports(this, this.q);
    this.modelProviders = new PostgresModelProviders(this, this.q);
    this.agentModels = new PostgresModelAssignments(this, this.q);
    this.usage = new PostgresUsageRecords(this, this.q);
    this.commands = new PostgresIssuedCommands(this, this.q);
    this.runRegistry = new PostgresRunRegistry(this, this.q);
    this.gitAccess = new PostgresGitAccessStore(this, this.q);
    this.machines = new PostgresMachines(this, this.q);
    this.rigHistory = new PostgresRigHistory(this, this.q);
    this.joinedRigs = new PostgresJoinedRigs(this, this.q);
    this.gpuClouds = new PostgresGpuClouds(this, this.q);
    this.retired = new PostgresRetiredRigs(this, this.q);
    this.builds = new PostgresBuilds(this, this.q);
    this.refusals = new PostgresRigRefusals(this, this.q);
    this.tunnels = new PostgresTunnelRigs(this, this.q);
    this.runpod = new PostgresRunpodStore(this, this.q);
    this.clusters = new PostgresClusters(this, this.q);
    this.campaigns = new PostgresCampaignVersions(this, this.q);
    this.folders = new PostgresCampaignFolders(this, this.q);
    this.archive = new PostgresCampaignArchive(this, this.q);
    this.enrollments = new PostgresEnrollments(this, this.q);
    this.busKeys = new PostgresBusKeys(this, this.q);
    this.rigRunners = new PostgresRigRunners(this, this.q);
    this.rigWorkers = new PostgresRigWorkers(this, this.q);
    this.runnerUse = new PostgresRunnerUse(this, this.q);
    this.rigUpdates = new PostgresRigUpdates(this, this.q);
    this.mcpServers = new PostgresMcpServerRows(this, this.q);
    this.proposals = new PostgresCampaignProposals(this, this.q);
    this.busPositions = new PostgresBusPositions(this, this.q);
    this.reachable = new PostgresReachableAddresses(this, this.q);
    this.ownSettings = new PostgresOwnSettings(this, this.q);
    this.retention = new PostgresRetentionPolicies(this, this.q);
    this.size = new PostgresStoreSize(this, this.q);
  }

  /** A PostgreSQL store has no events table of an older version to move: nothing is brought further. */
  async migrate(_given: MigrateGiven): Promise<string | undefined> {
    return undefined;
  }

  /**
   * Runs fn in one transaction: all of it is kept, or none of it. Nested calls become savepoints
   * of the outer one. For writes to more than one sub-store that stand or fall together.
   */
  tx<T>(fn: () => Promise<T>): Promise<T> {
    return this.q.tx(fn);
  }

  /**
   * Thermite's own knowledge base (goal 065), which the apply of the events stream feeds as it
   * applies each event.
   */
  kb(): PostgresKnowledgeBase {
    this.knowledge ??= new PostgresKnowledgeBase(this.q);
    return this.knowledge;
  }
}
