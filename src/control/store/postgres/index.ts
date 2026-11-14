import { errorText } from "../../../common/errors.ts";
import {
  numbered,
  type PgConnection,
  POSTGRES_OLDEST,
  postgresVersion,
  Sql,
} from "../../../common/postgres.ts";
import { keepStatements } from "../behind.ts";
import type { ControlStore, KnowledgeBase } from "../index.ts";
import { PostgresKbFileRows, PostgresKbSettingRows, PostgresKnowledgeBase } from "../kb/index.ts";
import type { MigrateGiven } from "../schema.ts";
import { inOrder, Order } from "./order.ts";
import { migratePostgres } from "./schema/index.ts";
import { PostgresStore } from "./store.ts";

/**
 * Control's store on PostgreSQL, behind the same interface as the store on SQLite (goal 268). It
 * is for trial until the move (goal 270): a release supports a control on SQLite.
 */

/**
 * Opens control's store on the PostgreSQL database `conn` reaches. It answers at once: the
 * store's first call checks the server's version, brings the schema to this code's version, and
 * fails in words when it can't; every call after it fails the same way.
 *
 * `path` is where the store's file would be, in control's state folder (`:memory:`: control has
 * none). No file is there: the store is on its server. Control's figures of its state folder
 * read the folder by it, and find a store that takes nothing of it, and no copies.
 */
export function openPostgresStore(conn: PgConnection, path: string): ControlStore {
  const q = new Sql(conn);
  const pg = new PostgresStore(q);
  const order = new Order();
  order.start(async () => {
    let version: number;
    try {
      version = await postgresVersion(conn);
    } catch (err) {
      throw new Error(`control could not reach its store on PostgreSQL: ${errorText(err)}`);
    }
    if (version < POSTGRES_OLDEST)
      throw new Error(
        `control's store needs PostgreSQL ${POSTGRES_OLDEST} or newer, and this server is PostgreSQL ${version}`,
      );
    await migratePostgres(q);
  });
  const part = <T extends object>(of: T, asIs: readonly string[] = []): T =>
    inOrder(() => of, Object.getPrototypeOf(of), order, asIs);
  // Made at its first call, as the SQLite store's is.
  const kb: KnowledgeBase = {
    ...inOrder<KnowledgeBase>(() => pg.kb(), PostgresKnowledgeBase.prototype, order),
    files: inOrder(() => pg.kb().files, PostgresKbFileRows.prototype, order),
    settings: inOrder(() => pg.kb().settings, PostgresKbSettingRows.prototype, order),
  };
  const store: ControlStore = {
    path,
    reportedRigs: part(pg.reportedRigs),
    eventsTable: part(pg.eventsTable),
    liveLines: part(pg.liveLines, ["watch"]),
    rigReports: part(pg.rigReports),
    fullResets: part(pg.fullResets),
    uiSessions: part(pg.uiSessions),
    auditLog: part(pg.auditLog),
    championPatches: part(pg.championPatches),
    exports: part(pg.exports),
    modelProviders: part(pg.modelProviders),
    agentModels: part(pg.agentModels),
    usage: part(pg.usage),
    commands: part(pg.commands),
    runRegistry: part(pg.runRegistry),
    gitAccess: part(pg.gitAccess),
    machines: part(pg.machines),
    rigHistory: part(pg.rigHistory),
    joinedRigs: part(pg.joinedRigs),
    gpuClouds: part(pg.gpuClouds),
    retired: part(pg.retired),
    builds: part(pg.builds),
    refusals: part(pg.refusals),
    tunnels: part(pg.tunnels),
    runpod: part(pg.runpod),
    clusters: part(pg.clusters),
    campaigns: part(pg.campaigns),
    folders: part(pg.folders),
    archive: part(pg.archive),
    enrollments: part(pg.enrollments),
    busKeys: part(pg.busKeys),
    rigRunners: part(pg.rigRunners),
    rigWorkers: part(pg.rigWorkers),
    runnerUse: part(pg.runnerUse),
    rigUpdates: part(pg.rigUpdates),
    mcpServers: part(pg.mcpServers),
    proposals: part(pg.proposals),
    busPositions: part(pg.busPositions),
    reachable: part(pg.reachable),
    ownSettings: part(pg.ownSettings),
    retention: part(pg.retention),
    size: part(pg.size),
    tx: <T>(fn: () => Promise<T>) => order.tx(q, fn),
    onceKept: (fn: () => void) => order.onceKept(fn),
    kb: () => kb,
    migrate: (given: MigrateGiven) => order.call(() => pg.migrate(given)),
    close: () => order.call(() => conn.close()),
  };
  keepStatements(store, async (sql, values) => {
    // Behind the order of the store's calls, but never before the store's start.
    await order.ready();
    const r = await conn.query(numbered(sql), values);
    return { rows: r.rows, changed: r.changed };
  });
  return store;
}
