// @ts-check
// Control's message bus for an acceptance check that runs control in its own process (the RunPod
// and the one-container rig image checks): the bus's server in a container of its pinned image,
// on a network of the check's own, started as compose.yaml starts it, with the users file and the
// certificates control's own code writes; control's store on it; and control's loops on the bus,
// as control's main runs them: the users kept up to date (with each pod's leaf node), each rig's
// consumers, the reports, live lines and the knowledge base's files followed, the commands
// published, the rigs' asks and searches answered, and each rig's config written. A pod joins the
// check's network, so that control's server dials its leaf node there, as RunPod's public address.
// It pulls nothing: the server's image must be there.
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engine, natsInitRun, natsService, rmFast, sh } from "./smoke-env.mjs";

const { natsBus } = await import("../../../src/common/bus/index.ts");
const { buildInfo } = await import("../../../src/common/build-info.ts");
const { BusTls, BusUsers, ConfigWriter, ConfigWritten, RigConsumers, reloadBus, serveRigAsks } =
  await import("../../../src/control/bus/index.ts");
const { followReports } = await import("../../../src/control/ingest.ts");
const { sendCommandsOn } = await import("../../../src/control/issue/index.ts");
const { followKbFiles, KbFiles, serveKbAsks } = await import("../../../src/control/kb/index.ts");
const { followLive, LiveTaken } = await import("../../../src/control/live/index.ts");
const { openControlStore } = await import("../../../src/control/store/index.ts");
const { storeOnBus } = await import("../../../tests/helpers/control-store.ts");

/** How often control's loops on the bus look again here: faster than main.ts's, for a check. */
const LOOK_MS = 2_000;

/**
 * Starts the bus's server for a check named `name`, its host port at `port` (never 4222), and
 * control's store on it. `secrets` seals control's own keys on the bus.
 * @param {{ name: string, port: number, secrets: import("../../../src/control/secrets.ts").SecretBox }} options
 */
export async function startControlBus({ name, port, secrets }) {
  if (port === 4222) throw new Error("the check's bus port is never the stack's 4222");
  const work = mkdtempSync(join(tmpdir(), `${name}-bus-`));
  const files = join(work, "nats");
  mkdirSync(files);
  const net = `${name}-net`;
  const box = `${name}-nats`;
  const storeVolume = `${name}-nats-store`;
  const url = `nats://127.0.0.1:${port}`;
  const quiet = (/** @type {string[]} */ args) => {
    try {
      sh(engine, args);
    } catch {}
  };
  quiet(["rm", "-f", "-v", box]);
  quiet(["network", "rm", "-f", net]);
  quiet(["volume", "rm", "-f", storeVolume]);
  sh(engine, ["network", "create", net]);
  const tls = new BusTls({ stateDir: work, configDir: files, names: ["127.0.0.1"] });
  const trust = { ca: tls.caCert };
  // Control's files for its server, into its container: readable by the server's user whichever
  // engine copies them (Docker gives copied files to root).
  const copyFiles = () => {
    for (const f of readdirSync(files, { withFileTypes: true }))
      if (f.isFile()) chmodSync(join(files, f.name), 0o644);
    sh(engine, ["cp", `${files}/.`, `${box}:/etc/nats/thermite`]);
  };
  let serverUp = false;
  const store = openControlStore(join(work, "control.db"));
  const busUsers = await BusUsers.open({
    store,
    secrets,
    file: join(files, "users.conf"),
    tls,
    reload: async (seed) => {
      if (!serverUp) throw new Error("the server is not started yet");
      copyFiles();
      await reloadBus(url, seed, trust);
    },
  });
  await busUsers.sync().catch(() => {});
  const nats = natsService();
  sh(engine, natsInitRun([`${storeVolume}:/data`, "/etc/nats/thermite"]));
  sh(engine, [
    "create",
    "--name",
    box,
    "--pull=never",
    "--memory",
    "256m",
    "--user",
    nats.user,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--network",
    net,
    "-p",
    `127.0.0.1:${port}:4222`,
    "-v",
    `${storeVolume}:/data`,
    nats.image,
    ...nats.command,
  ]);
  copyFiles();
  sh(engine, ["start", box]);
  serverUp = true;
  const bus = natsBus(url, "control", { seed: busUsers.controlSeed, trust });
  // Control's store on the real bus: the events stream, its writer, its move and its apply, as
  // control's main puts them there.
  // storeOnBus is typed for the tests' fake bus, a Bus with more for the tests to look at; it uses
  // only the Bus's own methods, so the real bus serves it (`any` for that reason).
  storeOnBus(store, /** @type {any} */ (bus));
  return {
    url,
    net,
    store,
    bus,
    caCert: tls.caCert,
    busUsers,
    /** Control's server's log, for a check that failed. */
    logs: () => {
      try {
        return sh(engine, ["logs", "--tail", "60", box]);
      } catch {
        return "";
      }
    },
    /** Removes the server, its network and its store, and control's files. */
    remove: async () => {
      await bus.close().catch(() => {});
      quiet([...rmFast, "-v", box]);
      quiet(["network", "rm", "-f", net]);
      quiet(["volume", "rm", "-f", storeVolume]);
      rmSync(work, { recursive: true, force: true });
    },
  };
}

/**
 * Control's loops on the bus, as control's main runs them, for `started` (startControlBus) and
 * control's `parts` (controlParts, with the same store). Returns the config writer, which control's
 * API takes, and a stop.
 * @param {Awaited<ReturnType<typeof startControlBus>>} started
 * @param {import("../../../src/control/parts.ts").ControlParts} parts
 * @param {{ requireKeyAcceptance?: boolean }} [o]
 */
export function followControlBus(started, parts, o = {}) {
  const { store, bus, busUsers } = started;
  /** @type {ReturnType<typeof setInterval>[]} */
  const timers = [];
  /** @type {(what: string) => (err: unknown) => void} */
  const said = (what) => (err) => console.error(`control's bus, ${what}: ${String(err)}`);
  const control = buildInfo();
  const rigConsumers = new RigConsumers({ store, bus });
  const busConfig = new ConfigWriter({ parts, bus, figures: new ConfigWritten() });
  const kbFiles = new KbFiles(mkdtempSync(join(tmpdir(), "thermite-check-kb-files-")), store);
  const keep = async () => {
    await busUsers.sync();
    await rigConsumers.make();
  };
  void keep().catch(said("users"));
  timers.push(setInterval(() => void keep().catch(said("users")), LOOK_MS));
  void busConfig.start().then(() => busConfig.write());
  timers.push(setInterval(() => void busConfig.write(), LOOK_MS));
  const intake = { store, control, requireKeyAcceptance: Boolean(o.requireKeyAcceptance) };
  followReports(bus, intake).catch(said("reports"));
  followLive(bus, { store, taken: new LiveTaken() }).catch(said("live lines"));
  followKbFiles(bus, kbFiles).catch(said("files"));
  serveKbAsks(bus, store).catch(said("searches"));
  serveRigAsks(bus, {
    store,
    control,
    privateKeyPem: parts.privateKeyPem,
    screens: parts.screens,
  }).catch(said("asks"));
  sendCommandsOn(store, bus).catch(said("commands"));
  return {
    busConfig,
    stop: () => {
      for (const t of timers) clearInterval(t);
    },
  };
}

/**
 * A container's address on the check's network: where control's server dials its leaf node.
 * @param {string} net
 * @param {string} container
 */
export function addressOn(net, container) {
  const out = sh(engine, [
    "inspect",
    container,
    "--format",
    `{{(index .NetworkSettings.Networks "${net}").IPAddress}}`,
  ]).trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(out))
    throw new Error(`${container} has no address on ${net}: ${out}`);
  return out;
}
