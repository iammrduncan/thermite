#!/usr/bin/env node
// The message bus's permissions and limits, against a real NATS server (goal 168): the server's
// pinned image, started as compose.yaml starts it, with a users file and a certificate that
// control's own code writes, on a host port of its own. Control's side and the rigs' sign in with
// keys made here, over TLS. Then:
//   - control makes the streams, each rig's two consumers (bus/consumers.ts), publishes a command
//     and a config value for rig-a, and can't delete or purge the EVENTS stream;
//   - rig-a takes its command and reads its config through the supervisor's own code (follow and
//     watch in common/bus), on the consumers control made;
//   - rig-a may make no consumer of its own, push or pull, nor remove one; may not read or take
//     from rig-b's consumers or config, nor read EVENTS, CONFIG or KB_FILES by any other way;
//     may not publish rig-b's reports, files or live lines, nor live lines of a run it was not
//     given; and may not subscribe outside its own inbox;
//   - streams made with the settings of before are brought to today's in place: REPORTS gains
//     its limit for each rig, and KB_FILES its one subject for each rig;
//   - REPORTS holds at most REPORTS_WAITING_PER_RIG of one rig's reports, and KB_FILES at most
//     KB_FILE_CHUNKS_WAITING_PER_RIG of one rig's chunks, each at most KB_FILE_MAX_MESSAGE_BYTES:
//     the next is refused, and rig-b's still go;
//   - rig-b retired (its user taken out of the users file, and the server reloaded) is cut off.
// It needs Podman or Docker and the server's image pulled already (it pulls nothing). It runs the
// server's container, thermite-bus-check, with 512 MiB of memory, as compose's user, on a store
// volume, thermite-bus-check-store, that a short run of compose's nats-init gives to that user
// first; it removes both at the end, and prunes no image. With Podman on a machine VM it trims the
// VM's disk after.
//
//   COMPOSE="podman compose" node scripts/acceptance/bus.mjs
//   BUS_CHECK_PORT sets the host port (14480 by default; never 4222, which the stack uses).
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JetStreamApiError, jetstream, jetstreamManager } from "@nats-io/jetstream";
import { createUser } from "@nats-io/nkeys";
import { connect, errors, nkeyAuthenticator } from "@nats-io/transport-node";
import { acceptanceChecks } from "./lib/checks.mjs";
import { engine, natsInitRun, natsService, sh } from "./lib/smoke-env.mjs";

// Control's own code, as control runs it (Node.js strips the types of these files).
const { natsBus } = await import("../../src/common/bus/index.ts");
const { tlsOf } = await import("../../src/common/bus/tls.ts");
const { BusTls, RigConsumers, reloadBus } = await import("../../src/control/bus/index.ts");
const { ControlStore } = await import("../../src/control/store/index.ts");
const commands = await import("../../src/core/link/commands.ts");
const config = await import("../../src/core/link/config.ts");
const { EVENT_STREAM, EVENT_STREAM_CONFIG } = await import("../../src/core/link/events.ts");
const kbFiles = await import("../../src/core/link/kb-files.ts");
const live = await import("../../src/core/link/live.ts");
const report = await import("../../src/core/link/report.ts");
const { rigInboxPrefix, usersFile } = await import("../../src/core/link/users.ts");

const { check, failed } = acceptanceChecks();
const box = "thermite-bus-check";
/** JetStream's store: a volume of the check's own, given to the server's user as compose does. */
const storeVolume = "thermite-bus-check-store";
const port = Number(process.env.BUS_CHECK_PORT ?? "14480");
if (port === 4222 || (port >= 14244 && port <= 14400)) {
  console.log(`bus check: port ${port} is kept for the stack and the other checks; choose another`);
  process.exit(1);
}
const url = `nats://127.0.0.1:${port}`;
const work = mkdtempSync(join(tmpdir(), "thermite-bus-check-"));
const files = join(work, "nats");
mkdirSync(files);

/** A user key: its seed for signing in, and its public part for the users file. */
const key = () => {
  const k = createUser();
  return { seed: k.getSeed(), publicKey: k.getPublicKey() };
};
const keys = { control: key(), system: key(), a: key(), b: key() };
const tls = new BusTls({ stateDir: work, configDir: files, names: ["127.0.0.1"] });
tls.write();
const trust = { ca: tls.caCert };
const users = (rigs) =>
  usersFile({
    control: keys.control.publicKey,
    system: keys.system.publicKey,
    rigs: rigs.map(([rig, k, runs]) => ({ rig, key: k.publicKey, runs })),
  });
writeFileSync(
  join(files, "users.conf"),
  users([
    ["rig-a", keys.a, ["run-a"]],
    ["rig-b", keys.b, []],
  ]),
);

const cleanup = () => {
  try {
    sh(engine, ["rm", "-f", "-v", "-t", "3", box]);
  } catch {}
  try {
    sh(engine, ["volume", "rm", "-f", storeVolume]);
  } catch {}
  rmSync(work, { recursive: true, force: true });
  // Images stay: they may be other projects'. The VM's disk is trimmed.
  try {
    if (engine === "podman" && process.platform !== "linux")
      sh("podman", ["machine", "ssh", "sudo", "fstrim", "-a"]);
  } catch {}
};

/** Signs in as a user over TLS; a rig takes its replies at its own inbox. */
const signIn = (k, rig) =>
  connect({
    servers: url,
    authenticator: nkeyAuthenticator(k.seed),
    // An address, not a name: checked against the certificate's addresses, as the parts do.
    tls: tlsOf(trust, url),
    timeout: 5_000,
    maxReconnectAttempts: 0,
    ...(rig ? { inboxPrefix: rigInboxPrefix(rig) } : {}),
  });

/** Whether an error is the server refusing the user, at any depth of its causes. */
function deniedBy(err) {
  for (let e = err, depth = 0; e && depth < 6; e = e.cause, depth++) {
    if (e instanceof errors.PermissionViolationError) return true;
    if (/permissions violation|authorization violation/i.test(String(e?.message ?? e))) return true;
  }
  return false;
}

/** What a call met: "allowed", "denied" (the user's permissions), or the error in words. */
async function tried(fn) {
  try {
    await fn();
    return "allowed";
  } catch (err) {
    if (deniedBy(err)) return "denied";
    if (err instanceof JetStreamApiError) return `refused ${err.code}: ${err.message}`;
    return `error: ${String(err?.message ?? err)}`;
  }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const data = (n = 16) => new Uint8Array(n).fill(65);

let control;
let rigA;
let rigB;
try {
  // The server as compose.yaml runs it, from its pinned image, which must be here already.
  const nats = natsService();
  try {
    sh(engine, ["rm", "-f", "-v", box]);
    sh(engine, ["volume", "rm", "-f", storeVolume]);
  } catch {}
  // The store's folder given to the server's user first, as compose's nats-init gives it.
  sh(engine, natsInitRun([`${storeVolume}:/data`, "/etc/nats/thermite"]));
  sh(engine, [
    "create",
    "--name",
    box,
    "--pull=never",
    "--memory",
    "512m",
    "--user",
    nats.user,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "-p",
    `127.0.0.1:${port}:4222`,
    "-v",
    `${storeVolume}:/data`,
    nats.image,
    ...nats.command,
  ]);
  // Readable by the server's user whichever engine copies them: Docker gives them to root.
  for (const f of readdirSync(files, { withFileTypes: true }))
    if (f.isFile()) chmodSync(join(files, f.name), 0o644);
  sh(engine, ["cp", `${files}/.`, `${box}:/etc/nats/thermite`]);
  sh(engine, ["start", box]);
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      control = await signIn(keys.control);
      break;
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`the server did not take control: ${err}`);
      await pause(1000);
    }
  }
  check("the server takes control's user over TLS", true, url);

  // Control's side: the streams, with REPORTS and KB_FILES first as a control of before made them.
  const bus = natsBus(url, "control", { seed: keys.control.seed, trust });
  await bus.makeStream({
    ...report.REPORT_STREAM_CONFIG,
    max_msgs_per_subject: -1,
    discard_new_per_subject: false,
  });
  await bus.makeStream({
    ...kbFiles.KB_FILES_STREAM_CONFIG,
    subjects: ["thermite.rig.*.kbfile.*"],
    max_msgs_per_subject: -1,
    discard_new_per_subject: false,
  });
  for (const s of [
    EVENT_STREAM_CONFIG,
    report.REPORT_STREAM_CONFIG,
    commands.COMMAND_STREAM_CONFIG,
    config.CONFIG_STREAM_CONFIG,
    kbFiles.KB_FILES_STREAM_CONFIG,
    live.LIVE_STREAM_CONFIG,
  ])
    await bus.makeStream(s);
  const jsm = await jetstreamManager(control);
  const reports = (await jsm.streams.info(report.REPORT_STREAM)).config;
  check(
    "REPORTS made before is brought to its limit for each rig",
    reports.max_msgs_per_subject === report.REPORTS_WAITING_PER_RIG &&
      reports.discard_new_per_subject === true,
    { max_msgs_per_subject: reports.max_msgs_per_subject },
  );
  const kb = (await jsm.streams.info(kbFiles.KB_FILES_STREAM)).config;
  check(
    "KB_FILES made before is brought to one subject for each rig, and its limits",
    kb.subjects.join() === kbFiles.KB_FILES_SUBJECTS &&
      kb.max_msgs_per_subject === kbFiles.KB_FILE_CHUNKS_WAITING_PER_RIG &&
      kb.max_msg_size === kbFiles.KB_FILE_MAX_MESSAGE_BYTES,
    { subjects: kb.subjects, max_msgs_per_subject: kb.max_msgs_per_subject },
  );

  const store = new ControlStore(":memory:");
  // Two rigs enrolled, as control enrolls every rig: only their tokens' hashes kept.
  for (const rig of ["rig-a", "rig-b"]) store.enrollments.enroll(rig, "0".repeat(64), "check");
  store.busKeys.setRigKey("rig-a", keys.a.publicKey);
  store.busKeys.setRigKey("rig-b", keys.b.publicKey);
  await new RigConsumers({ store, bus }).make();
  const made = [];
  for await (const c of jsm.consumers.list(commands.COMMAND_STREAM)) made.push(c.name);
  for await (const c of jsm.consumers.list(config.CONFIG_STREAM)) made.push(c.name);
  check(
    "control makes each rig's two consumers",
    ["rig-a", "rig-b"].every(
      (r) =>
        made.includes(commands.commandConsumerName(r)) &&
        made.includes(config.configConsumerName(r)),
    ),
    made.sort().join(", "),
  );
  await bus.publish(commands.commandSubject("rig-a"), JSON.stringify({ for: "rig-a" }), {
    id: "command-1",
  });
  await bus.publish(config.configSubject("rig-a", "model-route"), "sealed for rig-a", {
    id: "config-1",
  });
  await bus.publish(config.configSubject("rig-b", "model-route"), "sealed for rig-b", {
    id: "config-2",
  });
  check(
    "control may not delete the EVENTS stream",
    (await tried(() => jsm.streams.delete(EVENT_STREAM))) === "denied",
  );
  check(
    "control may not purge the EVENTS stream",
    (await tried(() => jsm.streams.purge(EVENT_STREAM))) === "denied",
  );

  // Rig-a, through the supervisor's own code: its command, and its config read by its subject.
  const rigBus = natsBus(url, "supervisor rig-a", {
    seed: keys.a.seed,
    inboxPrefix: rigInboxPrefix("rig-a"),
    trust,
  });
  const got = { command: "", config: "" };
  void rigBus.follow(commands.COMMAND_STREAM, commands.commandConsumerName("rig-a"), (m) => {
    got.command = new TextDecoder().decode(m.data);
  });
  void rigBus.watch(
    config.CONFIG_STREAM,
    config.configConsumerName("rig-a"),
    config.configSubjects("rig-a"),
    (m) => {
      got.config = new TextDecoder().decode(m.data);
    },
  );
  for (let i = 0; i < 100 && !(got.command && got.config); i++) await pause(100);
  check("rig-a takes its command from the consumer control made", got.command.includes("rig-a"));
  check("rig-a reads its config by its subject", got.config === "sealed for rig-a");
  await rigBus.close();

  // Rig-a's own connection, for what it may not do.
  rigA = await signIn(keys.a, "rig-a");
  const aJs = jetstream(rigA);
  const aJsm = await jetstreamManager(rigA, { checkAPI: false });
  const denied = async (name, fn) => {
    const r = await tried(fn);
    check(name, r === "denied", r);
  };
  const own = {
    durable_name: commands.commandConsumerName("rig-a"),
    filter_subject: commands.commandSubject("rig-a"),
    ack_policy: "explicit",
  };
  await denied("rig-a may not make its commands consumer itself", () =>
    aJsm.consumers.add(commands.COMMAND_STREAM, own),
  );
  await denied("rig-a may not make a push consumer that delivers onto another stream", () =>
    aJsm.consumers.add(commands.COMMAND_STREAM, {
      ...own,
      deliver_subject: "thermite.rig.rig-b.ev.forged",
    }),
  );
  await denied("rig-a may not make a consumer the old way", () =>
    rigA.request(
      `$JS.API.CONSUMER.DURABLE.CREATE.${commands.COMMAND_STREAM}.${own.durable_name}`,
      JSON.stringify({ stream_name: commands.COMMAND_STREAM, config: own }),
      { timeout: 5_000 },
    ),
  );
  await denied("rig-a may not make its config consumer again", () =>
    aJsm.consumers.add(config.CONFIG_STREAM, config.configConsumerConfig("rig-a")),
  );
  await denied("rig-a may not remove its config consumer", () =>
    aJsm.consumers.delete(config.CONFIG_STREAM, config.configConsumerName("rig-a")),
  );
  check(
    "rig-a reads its own consumer",
    (await tried(() =>
      aJsm.consumers.info(commands.COMMAND_STREAM, commands.commandConsumerName("rig-a")),
    )) === "allowed",
  );
  await denied("rig-a may not read rig-b's consumer", () =>
    aJsm.consumers.info(commands.COMMAND_STREAM, commands.commandConsumerName("rig-b")),
  );
  await denied("rig-a may not take from rig-b's consumer", () =>
    rigA.request(
      `$JS.API.CONSUMER.MSG.NEXT.${commands.COMMAND_STREAM}.${commands.commandConsumerName("rig-b")}`,
      JSON.stringify({ batch: 1, no_wait: true }),
      { timeout: 5_000 },
    ),
  );
  await denied("rig-a may not read rig-b's config by its subject", () =>
    aJsm.direct.getMessage(config.CONFIG_STREAM, {
      last_by_subj: config.configSubject("rig-b", "model-route"),
    }),
  );
  await denied("rig-a may not read a config message by its place", () =>
    aJsm.streams.getMessage(config.CONFIG_STREAM, { seq: 1 }),
  );
  await denied("rig-a may not read the EVENTS stream", () => aJsm.streams.info(EVENT_STREAM));
  await denied("rig-a may not read a message of EVENTS", () =>
    aJsm.streams.getMessage(EVENT_STREAM, { seq: 1 }),
  );
  await denied("rig-a may not read KB_FILES", () => aJsm.streams.info(kbFiles.KB_FILES_STREAM));
  await denied("rig-a may not publish rig-b's reports", () =>
    aJs.publish(report.reportSubject("rig-b"), data(), { msgID: "forged-report" }),
  );
  await denied("rig-a may not put a file on rig-b's subject", () =>
    aJs.publish(kbFiles.kbFileSubject("rig-b"), data(), { msgID: "forged-file" }),
  );
  await denied("rig-a may not publish live lines of a run it was not given", () =>
    aJs.publish(live.liveSubject("rig-a", { run: "run-b", source: "judge" }), data(), {
      msgID: "forged-live",
    }),
  );
  check(
    "rig-a publishes live lines of the run it was given",
    (await tried(() =>
      aJs.publish(live.liveSubject("rig-a", { run: "run-a", source: "judge" }), data(), {
        msgID: "live-1",
      }),
    )) === "allowed",
  );
  const wide = rigA.subscribe("thermite.>");
  const closed = await Promise.race([wide.closed, pause(3000).then(() => "open")]);
  check(
    "rig-a may not subscribe outside its own inbox",
    closed instanceof Error && deniedBy(closed),
    String(closed),
  );

  // The limits for each rig: the next report and chunk are refused, and rig-b's still go.
  let last = "allowed";
  for (let i = 0; i <= report.REPORTS_WAITING_PER_RIG && last === "allowed"; i++)
    last = await tried(() =>
      aJs.publish(report.reportSubject("rig-a"), data(), { msgID: `report-${i}` }),
    );
  const reportsA = await (await jetstreamManager(control)).streams.info(report.REPORT_STREAM, {
    subjects_filter: report.reportSubject("rig-a"),
  });
  check(
    `REPORTS holds ${report.REPORTS_WAITING_PER_RIG} of one rig's reports, and refuses the next`,
    last.startsWith("refused") &&
      reportsA.state.subjects?.[report.reportSubject("rig-a")] === report.REPORTS_WAITING_PER_RIG,
    last,
  );
  rigB = await signIn(keys.b, "rig-b");
  const bJs = jetstream(rigB);
  check(
    "rig-b's report still goes",
    (await tried(() => bJs.publish(report.reportSubject("rig-b"), data(), { msgID: "b-1" }))) ===
      "allowed",
  );
  last = "allowed";
  for (let i = 0; i <= kbFiles.KB_FILE_CHUNKS_WAITING_PER_RIG && last === "allowed"; i++)
    last = await tried(() =>
      aJs.publish(kbFiles.kbFileSubject("rig-a"), data(), { msgID: `chunk-${i}` }),
    );
  check(
    `KB_FILES holds ${kbFiles.KB_FILE_CHUNKS_WAITING_PER_RIG} of one rig's chunks, and refuses the next`,
    last.startsWith("refused"),
    last,
  );
  check(
    "rig-b's chunk still goes",
    (await tried(() => bJs.publish(kbFiles.kbFileSubject("rig-b"), data(), { msgID: "b-c1" }))) ===
      "allowed",
  );
  const large = await tried(() =>
    bJs.publish(kbFiles.kbFileSubject("rig-b"), data(kbFiles.KB_FILE_MAX_MESSAGE_BYTES + 1), {
      msgID: "b-large",
    }),
  );
  check("KB_FILES refuses a chunk over its largest", large.startsWith("refused"), large);

  // Rig-b retired: its user goes from the users file, and the server, reloaded, cuts it off.
  writeFileSync(join(files, "users.conf"), users([["rig-a", keys.a, ["run-a"]]]));
  sh(engine, ["cp", join(files, "users.conf"), `${box}:/etc/nats/thermite/users.conf`]);
  await reloadBus(url, keys.system.seed, trust);
  await pause(1000);
  const after = await tried(() =>
    bJs.publish(report.reportSubject("rig-b"), data(), { msgID: "b-2", timeout: 3_000 }),
  );
  const again = await tried(async () => (await signIn(keys.b, "rig-b")).close());
  check(
    "a rig retired is cut off, and can't sign in again",
    after !== "allowed" && again !== "allowed",
    { publish: after, sign_in: again },
  );
  const stats = execFileSync(engine, ["stats", "--no-stream", "--format", "{{.MemUsage}}", box], {
    encoding: "utf8",
  }).trim();
  console.log(`the server's memory at the end: ${stats}`);
  await bus.close();
} catch (err) {
  check("the check ran to its end", false, String(err?.stack ?? err));
  try {
    console.log(sh(engine, ["logs", "--tail", "40", box]));
  } catch {}
} finally {
  for (const nc of [rigA, rigB, control]) await nc?.close().catch(() => {});
  cleanup();
}
const n = failed();
console.log(n ? `bus check: ${n} failed` : "bus check: every check passed");
process.exit(n ? 1 : 0);
