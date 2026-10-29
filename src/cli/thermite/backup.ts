import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  backupControl,
  checkBackup,
  natsBackupBus,
  ownerFor,
  RestoreRefused,
  restoreControl,
  setBusStoreAside,
} from "../../common/backup/index.ts";
import { buildInfo } from "../../common/build-info.ts";
import { busUrl } from "../../common/bus/index.ts";
import { errorText } from "../../common/errors.ts";
import { CONTROL_STATE } from "../../core/backup.ts";
import { fail } from "./shared.ts";
import { USAGE } from "./usage.ts";

/**
 * thermite backup and thermite restore (goal 173): control's state and its events, run where
 * control's state folder is mounted and the bus is reached as control reaches it: in the compose
 * stack, its `backup` service. Both sign in to the bus as the backup's own user, whose seed control
 * keeps in its state folder, and trust the server through control's authority there.
 */

/** Control's state folder, unless --state names one: THERMITE_CONTROL_DIR, as control reads it. */
const DEFAULT_STATE = "/var/lib/thermite-control";
/** How long the look at whether control or the bus answers may take. */
const ANSWERS_TIMEOUT_MS = 5_000;

const say = (line: string) => process.stdout.write(`${line}\n`);

/** Control's state folder and the bus, from the options and control's own settings. */
function placesOf(values: { state?: string | undefined; bus?: string | undefined }) {
  const stateDir = resolve(values.state ?? process.env.THERMITE_CONTROL_DIR ?? DEFAULT_STATE);
  if (!existsSync(join(stateDir, CONTROL_STATE.db)))
    fail(`${stateDir} holds no ${CONTROL_STATE.db}: give control's state folder with --state`);
  let url: string | undefined;
  try {
    url = values.bus ?? busUrl(process.env);
  } catch (err) {
    fail(errorText(err));
  }
  if (!url) fail("give the bus's address with --bus, or THERMITE_NATS_URL, as control has it");
  return { stateDir, url };
}

/** The bus as the backup's user: its seed and control's authority, from control's state folder. */
function backupBusOf(stateDir: string, url: string) {
  const seedFile = join(stateDir, CONTROL_STATE.busBackupSeed);
  if (!existsSync(seedFile))
    fail(
      `${seedFile} is not there: control makes the backup's key on the bus as it starts. Start control once, then run this again`,
    );
  const seed = new TextEncoder().encode(readFileSync(seedFile, "utf8").trim());
  return natsBackupBus(url, seed, { caFile: join(stateDir, CONTROL_STATE.busCaCert) });
}

/** Whether something answers at a TCP address within ANSWERS_TIMEOUT_MS. */
function answers(host: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = connect({ host, port, timeout: ANSWERS_TIMEOUT_MS });
    const end = (yes: boolean) => {
      s.destroy();
      done(yes);
    };
    s.once("connect", () => end(true));
    s.once("timeout", () => end(false));
    s.once("error", () => end(false));
  });
}

/** thermite backup FOLDER: control's state and its events into a dated folder in FOLDER. */
export async function thermiteBackup(rest: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: { state: { type: "string" }, bus: { type: "string" } },
    allowPositionals: true,
  });
  const [into, ...extra] = positionals;
  if (!into || extra.length) fail(USAGE);
  if (!existsSync(into)) fail(`no folder ${into}: make it first`);
  const { stateDir, url } = placesOf(values);
  const bus = backupBusOf(stateDir, url);
  try {
    const { folder, manifest } = await backupControl({
      stateDir,
      into: resolve(into),
      bus,
      build: buildInfo(),
      say,
      owner: ownerFor(into),
    });
    say(`backup: ${folder} (${manifest.files.length} files, ${manifest.streams.length} streams)`);
  } finally {
    await bus.close();
  }
}

/**
 * thermite restore BACKUP: the backup's streams, then control's state, with control stopped; or,
 * with --bus-store, the bus's store set aside, with the bus stopped.
 */
export async function thermiteRestore(rest: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      state: { type: "string" },
      bus: { type: "string" },
      control: { type: "string" },
      "bus-store": { type: "string" },
    },
    allowPositionals: true,
  });
  const [from, ...extra] = positionals;
  if (!from || extra.length) fail(USAGE);
  const { stateDir, url } = placesOf(values);
  const refused = (err: unknown) => {
    if (!(err instanceof RestoreRefused)) throw err;
    process.stderr.write(`restore refused: ${err.message}\n`);
    process.exit(1);
  };
  if (values.control) {
    const health = `${values.control.replace(/\/+$/, "")}/v1/health`;
    const up = await fetch(health, { signal: AbortSignal.timeout(ANSWERS_TIMEOUT_MS) }).then(
      () => true,
      () => false,
    );
    if (up) refused(new RestoreRefused(`control answers at ${values.control}: stop it first`));
  }
  const store = values["bus-store"];
  if (store) {
    const at = new URL(url);
    if (await answers(at.hostname.replace(/^\[(.*)\]$/, "$1"), Number(at.port || 4222)))
      refused(
        new RestoreRefused(
          `the bus answers at ${at.host}: stop it first, then set its store aside`,
        ),
      );
    try {
      await checkBackup(resolve(from));
      const aside = setBusStoreAside(resolve(store));
      say(aside ? `the bus's store: moved aside to ${aside}` : "the bus's store: empty already");
      say(
        "next: start the bus with room for the restore, then run thermite restore again, without --bus-store",
      );
    } catch (err) {
      refused(err);
    }
    return;
  }
  const bus = backupBusOf(stateDir, url);
  try {
    await restoreControl({ from: resolve(from), stateDir, bus, say });
    say("restored: start control, and it applies the events from its place in the stream");
  } catch (err) {
    refused(err);
  } finally {
    await bus.close();
  }
}
