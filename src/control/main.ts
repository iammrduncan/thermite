import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { serve } from "@hono/node-server";
import { buildInfo } from "../common/build-info.ts";
import { busHost, natsBus } from "../common/bus/index.ts";
import { log, optionalSecretFromFile, parseListen } from "../common/env.ts";
import { writeAtomic } from "../common/fs.ts";
import { every } from "../common/health.ts";
import { logWarn, startLogging } from "../common/log.ts";
import { readNumber } from "../common/settings.ts";
import { CONTROL_STATE } from "../core/backup.ts";
import { generateSigningKeys } from "../core/commands.ts";
import { EVENT_STREAM_CONFIG } from "../core/link/events.ts";
import { createControlApi } from "./api/index.ts";
import {
  BUS_CA_EXPORT_SETTING,
  BUS_USERS_FILE,
  BUS_USERS_SYNC_MS,
  BusTls,
  BusUsers,
  busConfigDir,
  busHealth,
  busPublicUrl,
  busStoreUse,
  CONFIG_WRITE_MS,
  ConfigWriter,
  ConfigWritten,
  controlBusUrl,
  RigConsumers,
  reloadBus,
} from "./bus/index.ts";
import { Credential } from "./credential.ts";
import { mountDashboard } from "./dashboard/index.ts";
import { CONTROL_DISK_CHECK_MS, ControlDisk } from "./disk.ts";
import { EventsApply, EventsMove, EventsWriter } from "./events/index.ts";
import { followReports } from "./ingest.ts";
import { sendCommandsOn } from "./issue/index.ts";
import { followKbFiles, KB_ORPHANS_LOOK_MS, KbFiles, serveKbAsks } from "./kb/index.ts";
import { KitRepos } from "./kits/index.ts";
import { advanceResets, driverFromEnv } from "./lifecycle.ts";
import { followLive, LiveTaken } from "./live/index.ts";
import { controlParts } from "./parts.ts";
import { checkQuietRigs, checkRigPlace } from "./rigs/index.ts";
import { refreshGpuClouds } from "./runpod/index.ts";
import { SecretBox } from "./secrets.ts";
import { CONTROL_NUMBERS, controlPublicUrl, notReadWords } from "./settings.ts";
import { ControlStore } from "./store/index.ts";

/** Control service entry point. Generates its signing key on first start. */
async function main(): Promise<void> {
  const env = process.env;
  startLogging("control", env);
  // The message bus (goal 168), which control needs: every rig's events are kept in its events
  // stream, and what control derives from them is applied from there. Rigs report over the bus,
  // or over HTTP; control publishes the events of both. Commands and live lines go over it too.
  const natsUrl = controlBusUrl(env);
  // How rigs and the machines control sets rigs up on reach control: https, or plain http only to
  // this computer, a compose service, or where the owner allows it (settings.ts).
  const publicUrl = controlPublicUrl(env);
  const dir = env.THERMITE_CONTROL_DIR ?? "/var/lib/thermite-control";
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, CONTROL_STATE.signingKey);
  const pubPath = join(dir, CONTROL_STATE.signingPub);
  if (!existsSync(keyPath)) {
    const keys = generateSigningKeys();
    writeFileSync(keyPath, keys.privateKeyPem, { mode: 0o600 });
    writeFileSync(pubPath, keys.publicKeyPem, { mode: 0o644 });
    log("control", "generated signing key");
  }
  chmodSync(keyPath, 0o600);
  const privateKeyPem = readFileSync(keyPath, "utf8");
  const publicKeyPem = readFileSync(pubPath, "utf8");
  if (env.THERMITE_CONTROL_PUBKEY_EXPORT) {
    mkdirSync(dirname(env.THERMITE_CONTROL_PUBKEY_EXPORT), { recursive: true });
    writeFileSync(env.THERMITE_CONTROL_PUBKEY_EXPORT, publicKeyPem, { mode: 0o644 });
  }
  // Each credential is the token's SHA-256 (THERMITE_CONTROL_<ROLE>_TOKEN_SHA256), so control's
  // machine holds nothing that signs in, or for local development a token file
  // (THERMITE_CONTROL_<ROLE>_TOKEN_FILE). The owner's is required.
  const credential = (role: string): Credential | undefined => {
    const hash = env[`THERMITE_CONTROL_${role}_TOKEN_SHA256`];
    const file = env[`THERMITE_CONTROL_${role}_TOKEN_FILE`];
    if (hash && file)
      throw new Error(`set THERMITE_CONTROL_${role}_TOKEN_SHA256 or _FILE, not both`);
    if (hash) return Credential.ofHash(hash);
    const token = file ? optionalSecretFromFile(`THERMITE_CONTROL_${role}_TOKEN_FILE`) : undefined;
    return token ? Credential.ofToken(token) : undefined;
  };
  const admin = credential("ADMIN");
  if (!admin) {
    throw new Error(
      "control needs the owner's credential: THERMITE_CONTROL_ADMIN_TOKEN_SHA256 (from `thermite token new`) or THERMITE_CONTROL_ADMIN_TOKEN_FILE",
    );
  }
  const tokens = {
    admin,
    operator: credential("OPERATOR"),
    agent: credential("AGENT"),
    read: credential("READ"),
  };
  // Rigs enroll through control, which keeps only their tokens' hashes. A rig tokens file still
  // set is not read: said at start, in words, and control starts.
  const notRead = notReadWords(env);
  if (notRead) logWarn("control", notRead);
  const store = new ControlStore(join(dir, CONTROL_STATE.db));
  const { host, port } = parseListen(env.THERMITE_CONTROL_LISTEN ?? "0.0.0.0:8800");
  // A rig is stale after 3 missed reports (the supervisor reports every 60 s by default).
  const staleAfterMs = readNumber(env, CONTROL_NUMBERS.staleSeconds) * 1000;
  // Offline after 15 minutes without a report (never before it is stale).
  const offlineAfterMs = readNumber(env, CONTROL_NUMBERS.offlineSeconds) * 1000;
  // The free space control keeps on its state and in the bus's store (goal 173).
  const diskFloorGib = readNumber(env, CONTROL_NUMBERS.diskFloorGib);
  // How long a knowledge-base file no item names is kept; 0, the default: for good.
  const kbOrphanHours = readNumber(env, CONTROL_NUMBERS.kbOrphanHours);
  const driver = driverFromEnv(env);
  // Optional: the owner accepts each rig's first report key (no trust on first use).
  const requireKeyAcceptance = env.THERMITE_CONTROL_REQUIRE_KEY_ACCEPT === "1";
  // The bus as the rigs control sets up reach it (none: they keep to HTTP), and its TLS: control's
  // own authority, kept beside its signing key, and the server's certificate for the names control
  // and those rigs reach it by, written to the folder the server reads (bus/tls.ts).
  const rigBusUrl = busPublicUrl(env, publicUrl);
  const busDir = busConfigDir(env);
  const busTls = new BusTls({
    stateDir: dir,
    configDir: busDir,
    names: [busHost(natsUrl), ...(rigBusUrl ? [busHost(rigBusUrl)] : [])],
  });
  // The rigs beside control in compose read the authority's certificate from control's volume.
  const caExport = env[BUS_CA_EXPORT_SETTING];
  if (caExport) writeAtomic(caExport, busTls.caCert, 0o644);
  const trust = { ca: busTls.caCert };
  // The key that seals model routes' API keys: its own file, made on first use. Mount it
  // from a separate secret to keep it off the database's volume.
  const secrets = SecretBox.fromFile(
    env.THERMITE_CONTROL_SECRETS_KEY_FILE ?? join(dir, CONTROL_STATE.secretsKey),
  );
  // Who may use the bus: control's own users and each rig's that registered its key, written to
  // the server's users file, which the server reloads on control's request (bus/users.ts).
  const busUsers = new BusUsers({
    store,
    secrets,
    file: join(busDir, BUS_USERS_FILE),
    tls: busTls,
    reload: (seed) => reloadBus(natsUrl, seed, trust),
    // The backup's own user, which `thermite backup` and `thermite restore` sign in as (goal 173).
    backupSeedFile: join(dir, CONTROL_STATE.busBackupSeed),
  });
  // Control's connection to the bus, signed in as its own user; the apply of the events stream,
  // which writes what control derives from the events; the writer of the stream, which publishes
  // each report's events first and waits for the apply; the move of the events table a store from
  // before the stream holds, which nudges the apply after each batch; and what control took from
  // the live stream and wrote to the config bucket, which the bus's state shows.
  const bus = natsBus(natsUrl, "control", { seed: busUsers.controlSeed, trust });
  const eventsApply = new EventsApply({ store, bus });
  const eventsWriter = new EventsWriter({ store, bus, apply: eventsApply });
  const eventsMove = new EventsMove({ store, bus, published: () => void eventsApply.nudge() });
  const liveTaken = new LiveTaken();
  const configWritten = new ConfigWritten();
  // What the dashboard, REST, MCP and the loops below share, made once here (parts.ts): the test
  // pods on GPU clouds, the agents' MCP servers (goal 068), the rigs in pull mode and the rigs the
  // owner launches on RunPod among them, and the bus.
  const parts = controlParts(
    store,
    privateKeyPem,
    {
      staleAfterMs,
      secrets,
      runpodTestImage: env.THERMITE_RUNPOD_TEST_IMAGE || undefined,
      runpodRigImage: env.THERMITE_RUNPOD_RIG_IMAGE || undefined,
      // Kits written on the new-campaign page, kept as git repositories in control's state.
      kits: new KitRepos(join(dir, CONTROL_STATE.kits)),
      publicUrl,
      // The images rigs on machines run (none: control can't set rigs up there).
      rigImages:
        env.THERMITE_RIG_HARNESS_IMAGE && env.THERMITE_RIG_SUPERVISOR_IMAGE
          ? {
              harness: env.THERMITE_RIG_HARNESS_IMAGE,
              harnessCuda: env.THERMITE_RIG_HARNESS_CUDA_IMAGE || undefined,
              supervisor: env.THERMITE_RIG_SUPERVISOR_IMAGE,
            }
          : undefined,
      rigBus: rigBusUrl ? { url: rigBusUrl, ca: busTls.caCert } : undefined,
      // A rig on RunPod joins the bus through a leaf node in its pod, which trusts this authority.
      busCa: busTls.caCert,
      bus: {
        server: new URL(natsUrl).host,
        bus,
        events: eventsWriter,
        move: eventsMove,
        apply: eventsApply,
        live: liveTaken,
        config: configWritten,
      },
    },
    { staleAfterMs, offlineAfterMs, control: buildInfo() },
  );
  const { runpodTests, tunnels, runpodRigs } = parts;
  // Each rig's config, written to the config bucket when it changes (bus/config.ts).
  const busConfig = new ConfigWriter({ parts, bus, figures: configWritten });
  // Control's port opens at once, but it answers every request that it is starting until its
  // views are built (below): its health with 503 and the bus's state, so that a check waits, and
  // every other route with 503 and the reason.
  let ready = false;
  const api = createControlApi(store, tokens, privateKeyPem, {
    staleAfterMs,
    offlineAfterMs,
    driver,
    requireKeyAcceptance,
    sessionDays: readNumber(env, CONTROL_NUMBERS.sessionDays),
    parts,
    // The dashboard's pages.
    pages: mountDashboard,
    // Exports from rigs without a results repository, kept in control's state.
    exportsDir: join(dir, CONTROL_STATE.exports),
    // Who may use the message bus: a rig's new key gets its user there, and a new seal key its
    // config.
    busUsers,
    busConfig,
  });
  const starting = (req: Request) =>
    new URL(req.url).pathname === "/v1/health"
      ? Response.json({ ok: false, bus: busHealth(parts.bus), starting: true }, { status: 503 })
      : Response.json(
          { error: "control is starting: it builds its views from the events stream first" },
          { status: 503, headers: { "retry-after": "5" } },
        );
  const server = serve({
    fetch: (req, env) => (ready ? api.fetch(req, env) : starting(req)),
    hostname: host,
    port,
  });
  log("control", "listening", {
    host,
    port,
    build: buildInfo(),
    enrolled: store.enrollments
      .rigs()
      .filter((r) => !r.retired_at)
      .map((r) => r.rig),
    lifecycle: driver?.kind ?? null,
    bus: new URL(natsUrl).host,
    bus_for_rigs: rigBusUrl ? new URL(rigBusUrl).host : null,
    kb_orphan_hours: kbOrphanHours,
  });
  // Before control serves a page or takes a report: the users file, so that the server can start,
  // kept up to date after; the events stream made, waiting for the bus; the store's place checked
  // against the stream's end; the events
  // table of a store from before the stream, moved there in the writer's turn, checked, and
  // dropped with a copy of the store kept; and the stream applied to its end, which builds the
  // views' folds in one pass from its first message (control/events).
  // Control's loops, each ticked as its round ends, for its health route and /metrics (goal 173).
  const { loops } = parts;
  // Each rig's consumers of its commands and its config, which control makes (bus/consumers.ts).
  const rigConsumers = new RigConsumers({ store, bus });
  void busUsers.sync();
  const usersSync = every(loops, "control", "bus_users", BUS_USERS_SYNC_MS, async () => {
    await busUsers.sync();
    await rigConsumers.make();
  });
  const started = performance.now();
  await bus.makeStream(EVENT_STREAM_CONFIG);
  await eventsApply.start();
  // A store that applied the stream past its end holds records the stream lacks: control does
  // not go on with it.
  if (eventsApply.stopped) {
    log("control", "fatal", { error: eventsApply.stopped }, "error");
    process.exit(1);
  }
  await eventsWriter.alone(() => eventsMove.run());
  // A table the stream can't hold whole stays, and control takes no report on top of it: the
  // stream must hold the table's rows before the events published first.
  if (eventsMove.stopped) {
    const { error, ...at } = eventsMove.stopped;
    log(
      "control",
      "fatal",
      { error: `control's events table can't go to the events stream: ${error}`, ...at },
      "error",
    );
    process.exit(1);
  }
  await eventsApply.nudge();
  ready = true;
  log("control", "control's views built from the events stream", {
    place: eventsApply.folds.through,
    rigs: eventsApply.folds.held().length,
    ms: Math.round(performance.now() - started),
  });
  // Reports from the bus, folded through the ingest route's checks as they arrive, each report's
  // events published to the events stream and applied before it is acked, as over HTTP; live
  // lines, folded into the live view as they arrive; each command
  // control issues, published to its rig's subject as well as kept in the store; and each rig's
  // config, written when it changes.
  void busConfig.start().then(() => busConfig.write());
  const configWrite = every(loops, "control", "bus_config", CONFIG_WRITE_MS, () =>
    busConfig.write(),
  );
  followReports(bus, { store, control: buildInfo(), requireKeyAcceptance }).catch((err) =>
    log("control", "reports from the bus stopped", { error: String(err) }, "error"),
  );
  followLive(bus, { store, taken: liveTaken }).catch((err) =>
    log("control", "live lines from the bus stopped", { error: String(err) }, "error"),
  );
  // The knowledge base's files, each kept once by its SHA-256 in control's state (goal 175); a
  // file no item names, kept for good unless the owner set how many hours it stays: then control
  // looks at start and every hour.
  const kbFiles = new KbFiles(join(dir, CONTROL_STATE.kbFiles), store);
  followKbFiles(bus, kbFiles).catch((err) =>
    log("control", "files for the knowledge base stopped", { error: String(err) }, "error"),
  );
  const removeOrphans = () => kbFiles.removeOrphans(kbOrphanHours);
  if (kbOrphanHours > 0) removeOrphans();
  const orphans =
    kbOrphanHours > 0
      ? every(loops, "control", "kb_orphans", KB_ORPHANS_LOOK_MS, removeOrphans)
      : undefined;
  // Searches and reads of the knowledge base for the rigs' agents, each answered from its run's scope.
  serveKbAsks(bus, store).catch((err) =>
    log("control", "knowledge base searches stopped", { error: String(err) }, "error"),
  );
  sendCommandsOn(store, bus).catch((err) =>
    log("control", "commands stream not made", { error: String(err) }, "error"),
  );
  // Full resets advance as their evidence arrives.
  const resets = every(loops, "control", "resets", 10_000, () =>
    advanceResets({ store, privateKeyPem, driver, staleAfterMs }).catch((err) =>
      log("control", "reset step error", { error: String(err) }, "error"),
    ),
  );
  // Test pods move on as their pods do; every path ends with the pod removed.
  const tests = every(loops, "control", "runpod_tests", 15_000, () =>
    runpodTests
      .advance()
      .catch((err) => log("control", "runpod test error", { error: String(err) }, "error")),
  );
  // Rigs in pull mode: each rig's next exchange starts as soon as its last one ends (an exchange
  // waits up to 20 s at the pod for the rig's calls), each failing rig after its retry time.
  const pulls = every(loops, "control", "pull_mode", 250, () =>
    tunnels
      .advance()
      .catch((err) => log("control", "pull mode error", { error: String(err) }, "error")),
  );
  // Rigs on RunPod: each pod's status, price and spend; the owner's limits, where set; the stop,
  // start, restart or terminate under way. At start too: a limit a pod passed while control was
  // away stops it at once (goal 165).
  const followPods = () =>
    runpodRigs
      .advance()
      .catch((err) => log("control", "runpod rig error", { error: String(err) }, "error"));
  void followPods();
  const launched = every(loops, "control", "runpod_rigs", 30_000, followPods);
  // Rigs control set up that stopped reporting: their containers checked once when they turn
  // stale, and once more when they turn offline (rigs/watch.ts). One check at a time: a round
  // while one runs waits for it, so a check that hangs makes the loop late.
  let watching: Promise<unknown> | undefined;
  const quiet = every(loops, "control", "quiet_rigs", 60_000, () => {
    watching ??= checkQuietRigs({
      store,
      // Where a quiet rig runs is checked as its page's Check again does.
      check: (rig, by) => checkRigPlace(parts, rig, by),
      staleAfterMs,
      offlineAfterMs,
    })
      .catch((err) => log("control", "quiet rig check error", { error: String(err) }, "error"))
      .finally(() => {
        watching = undefined;
      });
    return watching;
  });
  // Control's disk floor (goal 173): its state folder, and the room left in the bus's store, as
  // control's system user reads it. At the floor, new runs wait; nothing else does.
  const disk = new ControlDisk({
    store,
    stateDir: dir,
    floorGib: diskFloorGib,
    busStore: () => busStoreUse(natsUrl, busUsers.systemSeed, trust),
  });
  void disk.check();
  const diskWatch = every(loops, "control", "disk", CONTROL_DISK_CHECK_MS, () => disk.check());
  // GPU clouds' prices, pods and spend, read again every 15 minutes.
  const clouds = every(loops, "control", "gpu_clouds", 15 * 60_000, () =>
    refreshGpuClouds(store, secrets).catch((err) =>
      log("control", "gpu cloud read error", { error: String(err) }, "error"),
    ),
  );
  const stop = () => {
    clearInterval(resets);
    clearInterval(tests);
    clearInterval(pulls);
    clearInterval(launched);
    clearInterval(quiet);
    clearInterval(clouds);
    clearInterval(usersSync);
    clearInterval(configWrite);
    clearInterval(diskWatch);
    clearInterval(orphans);
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((err) => {
  log("control", "fatal", { error: err instanceof Error ? err.stack : String(err) }, "error");
  process.exit(1);
});
