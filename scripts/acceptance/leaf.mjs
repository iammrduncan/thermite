#!/usr/bin/env node
// A rig on RunPod on the message bus (goal 168, step 5): its pod's own server, which control's
// server dials as a leaf node, against the real server. Two containers of the bus's pinned image,
// on a network of their own: control's server, started as compose.yaml starts it, with the users
// file and the certificates control's own code writes (BusTls, BusUsers, the launch's leaf keys
// from ControlTunnels.mint); and the pod's, with the files the supervisor's own code writes from
// those launch values (writePodBus). The supervisor's bus client signs in to the pod's server, as
// in a pod. Then:
//   - control's server dials the pod once its address is in the store, and the supervisor's report,
//     command (through the consumer control made, acked), config, live lines, knowledge base ask
//     and file all go through the leaf, the JetStream API under the leaf's own name;
//   - the leaf may do only what the rig may: a subscription to everything on the pod sees nothing
//     of the bus, and no other rig's subject, no stream's removal, no other JetStream call and no
//     system request gets an answer; a live line of a run not given to the rig goes nowhere;
//   - the pod's leaf port takes only control's certificate: none, or a stranger's, is refused;
//   - control's server refuses a pod whose certificate another authority signed;
//   - the pod's server on a new address (a stop and a start on RunPod), with the same launch
//     values: control dials it there, and the supervisor's reports go again;
//   - the rig retired: its connection and its account are gone.
// It needs Podman or Docker and the server's image pulled already (it pulls nothing). It runs its
// containers with 256 MiB of memory each, control's server as compose's user on a store volume,
// thermite-leaf-check-store, that a short run of compose's nats-init gives to that user first, and
// removes them, the volume and their network at the end; it prunes no image. With Podman on a
// machine VM it trims the VM's disk after.
//
//   COMPOSE="podman compose" node scripts/acceptance/leaf.mjs
//   LEAF_CHECK_PORT sets the first of the five host ports (14490 by default; never 4222).
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { jetstreamManager } from "@nats-io/jetstream";
import { createUser } from "@nats-io/nkeys";
import { connect, nkeyAuthenticator } from "@nats-io/transport-node";
import { acceptanceChecks } from "./lib/checks.mjs";
import { engine, natsInitRun, natsService, sh } from "./lib/smoke-env.mjs";

// Control's and the supervisor's own code, as they run it (Node.js strips the types).
const { natsBus } = await import("../../src/common/bus/index.ts");
const { tlsOf } = await import("../../src/common/bus/tls.ts");
const { BusTls, BusUsers, reloadBus } = await import("../../src/control/bus/index.ts");
const { ControlTunnels } = await import("../../src/control/runpod/tunnel.ts");
const { SecretBox } = await import("../../src/control/secrets.ts");
const { ControlStore } = await import("../../src/control/store/index.ts");
const { generateSigningKeys } = await import("../../src/core/commands.ts");
const commands = await import("../../src/core/link/commands.ts");
const config = await import("../../src/core/link/config.ts");
const kb = await import("../../src/core/link/kb.ts");
const kbFiles = await import("../../src/core/link/kb-files.ts");
const leafLink = await import("../../src/core/link/leaf.ts");
const live = await import("../../src/core/link/live.ts");
const report = await import("../../src/core/link/report.ts");
const { rigInboxPrefix } = await import("../../src/core/link/users.ts");
const { leafValues, writePodBus } = await import("../../src/supervisor/leaf.ts");

const { check, failed } = acceptanceChecks();
const base = Number(process.env.LEAF_CHECK_PORT ?? "14490");
const ports = { control: base, pod: base + 1, leaf: base + 2, impostor: base + 3, moved: base + 4 };
if (Object.values(ports).some((p) => p === 4222 || (p >= 14244 && p <= 14400) || p === 14480)) {
  console.log(
    `leaf check: port ${base} is kept for the stack and the other checks; choose another`,
  );
  process.exit(1);
}
const net = "thermite-leaf-check";
const subnet = "10.199.77";
const box = { control: "thermite-leaf-check-control", pod: "thermite-leaf-check-pod" };
/** Control's server's store: a volume of the check's own, given to its user as compose does. */
const storeVolume = "thermite-leaf-check-store";
const RIG = "rp-check";
const url = `nats://127.0.0.1:${ports.control}`;
const work = mkdtempSync(join(tmpdir(), "thermite-leaf-check-"));
const files = join(work, "nats");
mkdirSync(files);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const containers = new Set();

/**
 * Control's files for its server, into its container: readable by the server's user whichever
 * engine copies them (Docker gives copied files to root).
 */
const copyBusFiles = () => {
  for (const f of readdirSync(files, { withFileTypes: true }))
    if (f.isFile()) chmodSync(join(files, f.name), 0o644);
  sh(engine, ["cp", `${files}/.`, `${box.control}:/etc/nats/thermite`]);
};

const cleanup = () => {
  for (const c of containers) {
    try {
      sh(engine, ["rm", "-f", "-v", "-t", "3", c]);
    } catch {}
  }
  try {
    sh(engine, ["network", "rm", "-f", net]);
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

/** Waits until `fn` gives something truthy, checking every half second; undefined at the end. */
async function until(fn, ms = 30_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() > deadline) return undefined;
    await pause(500);
  }
}

/** What a request met: its answer's text, or the error in words. */
async function asked(nc, subject, data = "") {
  try {
    const r = await nc.request(subject, data, { timeout: 2_000 });
    return `answered: ${new TextDecoder().decode(r.data).slice(0, 80)}`;
  } catch (err) {
    return `no answer (${String(err?.message ?? err).slice(0, 40)})`;
  }
}

/**
 * A pod's server: the supervisor's files for these launch values, in a container at `ip` on the
 * check's network, its supervisor's port published on the host at `port` (the pod's own listens
 * on its loopback only: here on every address, so that this process can stand in for the
 * supervisor), and its leaf port at `leafPort` when given.
 */
function podServer(name, ip, port, values, supervisorKey, leafPort) {
  const dir = join(work, name);
  const written = writePodBus(dir, values, supervisorKey);
  const text = readFileSync(written.config, "utf8")
    .replaceAll(dir, "/pod")
    .replace(`127.0.0.1:${leafLink.POD_BUS_PORT}`, `0.0.0.0:${leafLink.POD_BUS_PORT}`);
  writeFileSync(written.config, text);
  sh(engine, ["rm", "-f", "-v", name]);
  containers.add(name);
  sh(engine, [
    "create",
    "--name",
    name,
    "--pull=never",
    "--memory",
    "256m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--network",
    net,
    "--ip",
    ip,
    "-p",
    `127.0.0.1:${port}:${leafLink.POD_BUS_PORT}`,
    ...(leafPort ? ["-p", `127.0.0.1:${leafPort}:${leafLink.LEAF_PORT}`] : []),
    natsService().image,
    "nats-server",
    "-c",
    "/pod/server.conf",
  ]);
  sh(engine, ["cp", `${dir}/.`, `${name}:/pod`]);
  sh(engine, ["start", name]);
  return `${ip}:${leafLink.LEAF_PORT}`;
}

/** The supervisor's bus client on a pod's server, as main.ts makes it there. */
const supervisorOn = (port, seed, values) =>
  natsBus(`nats://127.0.0.1:${port}`, `supervisor ${RIG}`, {
    seed,
    inboxPrefix: rigInboxPrefix(RIG),
    trust: { ca: values.cert },
    apiPrefix: leafLink.LEAF_JS_API,
  });

/**
 * Whether the supervisor's report is acked within `ms`: the leaf is up. Across a leaf with no
 * interest yet, a publish meets no "no responders" and waits for its ack's full time, so each try
 * here waits 3 s at most (a try left waiting is acked later, or not, harmlessly).
 */
const reportAcked = (sup, ms) =>
  until(
    () =>
      Promise.race([
        sup
          .publish(report.reportSubject(RIG), "a report", { id: `r-${Date.now()}` })
          .then((ack) => ack.seq > 0),
        pause(3_000).then(() => false),
      ]),
    ms,
  );

/**
 * What a TLS client meets on the pod's leaf port with this certificate (none: no certificate). A
 * NATS server sends its first line in plain text, then TLS begins on the same connection.
 */
function leafPortMeets(trust, cert) {
  return new Promise((resolve) => {
    let out = "";
    const plain = netConnect(ports.leaf, "127.0.0.1");
    plain.on("error", (e) => resolve(`error ${e.code ?? e.message}`));
    plain.once("data", () => {
      const s = tlsConnect({
        socket: plain,
        ca: trust,
        servername: leafLink.leafTlsName(RIG),
        ...cert,
      });
      s.on("secureConnect", () => s.write("CONNECT {}\r\nPING\r\n"));
      s.on("data", (d) => {
        out += d.toString();
      });
      s.on("error", (e) => {
        out += ` error ${e.code ?? e.message}`;
      });
      s.on("close", () => resolve(out.trim()));
      setTimeout(() => s.destroy(), 3_000);
    });
  });
}

let control;
const sups = [];
try {
  sh(engine, ["network", "rm", "-f", net]);
  sh(engine, ["network", "create", "--subnet", `${subnet}.0/24`, net]);

  // Control: its store, its authority and server certificate, its users, and a launch's leaf.
  const store = new ControlStore(join(work, "control.db"));
  const secrets = SecretBox.ephemeral();
  const tls = new BusTls({ stateDir: work, configDir: files, names: ["127.0.0.1"] });
  const trust = { ca: tls.caCert };
  let serverUp = false;
  const busUsers = new BusUsers({
    store,
    secrets,
    file: join(files, "users.conf"),
    tls,
    reload: async (seed) => {
      if (!serverUp) throw new Error("the server is not started yet");
      copyBusFiles();
      await reloadBus(url, seed, trust);
    },
  });
  const tunnels = new ControlTunnels(store, secrets, generateSigningKeys().privateKeyPem, {
    busCa: tls.caCert,
  });
  const minted = tunnels.mint({ by: "owner:check", rig: RIG });
  check(
    "a launch gives the pod its leaf node's values",
    Object.values(leafLink.LEAF_ENV).every((k) => minted.env[k]),
  );
  const values = leafValues(minted.env);
  await busUsers.sync();

  // Control's server, as compose.yaml runs it: its store given to its user first, as compose's
  // nats-init gives it.
  const nats = natsService();
  containers.add(box.control);
  try {
    sh(engine, ["volume", "rm", "-f", storeVolume]);
  } catch {}
  sh(engine, natsInitRun([`${storeVolume}:/data`, "/etc/nats/thermite"]));
  sh(engine, [
    "create",
    "--name",
    box.control,
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
    "--ip",
    `${subnet}.2`,
    "-p",
    `127.0.0.1:${ports.control}:4222`,
    "-v",
    `${storeVolume}:/data`,
    nats.image,
    ...nats.command,
  ]);
  copyBusFiles();
  sh(engine, ["start", box.control]);
  serverUp = true;
  control = natsBus(url, "control", { seed: busUsers.controlSeed, trust });
  for (const s of [
    report.REPORT_STREAM_CONFIG,
    commands.COMMAND_STREAM_CONFIG,
    config.CONFIG_STREAM_CONFIG,
    live.LIVE_STREAM_CONFIG,
    kbFiles.KB_FILES_STREAM_CONFIG,
  ])
    await control.makeStream(s);
  await control.makeConsumer(commands.COMMAND_STREAM, commands.commandConsumerConfig(RIG));
  await control.makeConsumer(config.CONFIG_STREAM, config.configConsumerConfig(RIG));
  await control.makeConsumer(commands.COMMAND_STREAM, commands.commandConsumerConfig("rig-b"));
  check("control's server takes control's user, with its certificate good for a client too", true);

  // The pod: its server from the supervisor's files, its supervisor signed in on it.
  const supKey = createUser();
  const supSeed = supKey.getSeed();
  const address = podServer(
    box.pod,
    `${subnet}.10`,
    ports.pod,
    values,
    supKey.getPublicKey(),
    ports.leaf,
  );
  const sup = supervisorOn(ports.pod, supSeed, values);
  sups.push(sup);
  check("no address yet: control's server does not dial the pod", !(await reportAcked(sup, 3_000)));
  store.tunnels.setLeafAddress(RIG, address);
  await busUsers.sync();
  const t0 = Date.now();
  check(
    "with RunPod's address, control's server dials the pod: the supervisor's report is acked",
    await reportAcked(sup, 30_000),
    `${Date.now() - t0} ms after the users file named the pod`,
  );

  // Each channel the bus carries, through the leaf.
  const got = [];
  void sup.follow(commands.COMMAND_STREAM, commands.commandConsumerName(RIG), (m) => {
    got.push(new TextDecoder().decode(m.data));
  });
  await control.publish(commands.commandSubject(RIG), "a command", { id: `c-${Date.now()}` });
  check(
    "the supervisor takes its command from the consumer control made",
    await until(() => got.length === 1, 10_000),
  );
  const ctl = await connect({
    servers: url,
    authenticator: nkeyAuthenticator(busUsers.controlSeed),
    tls: tlsOf(trust, url),
  });
  const jsm = await jetstreamManager(ctl);
  const acked = await until(async () => {
    const ci = await jsm.consumers.info(commands.COMMAND_STREAM, commands.commandConsumerName(RIG));
    return ci.num_ack_pending === 0 && ci.num_pending === 0;
  }, 10_000);
  check("and its ack reached the consumer", Boolean(acked));
  const conf = [];
  await control.publish(config.configSubject(RIG, "model-route"), "a route", {
    id: `m-${Date.now()}`,
  });
  void sup.watch(
    config.CONFIG_STREAM,
    config.configConsumerName(RIG),
    config.configSubjects(RIG),
    (m) => {
      conf.push(new TextDecoder().decode(m.data));
    },
  );
  check("it reads its config's latest value", await until(() => conf.includes("a route"), 10_000));
  const own = live.rigLiveSubject(RIG, "judge");
  check(
    "a live line on its own subject is acked",
    (await sup.publish(own, "a line", { id: `l-${Date.now()}` })).seq > 0,
  );
  void control.serve(
    kb.kbAskSubject("search", RIG),
    async (r) => `found ${new TextDecoder().decode(r.data)}`,
  );
  await pause(500);
  check(
    "control answers its ask of the knowledge base",
    new TextDecoder().decode(await sup.request(kb.kbAskSubject("search", RIG), "q", 5_000)) ===
      "found q",
  );
  const file = await sup
    .publish(kbFiles.kbFileSubject(RIG), "a chunk", {
      id: `f-${Date.now()}`,
      headers: {
        [kbFiles.KB_FILE_HEADERS.sha256]: "0".repeat(64),
        [kbFiles.KB_FILE_HEADERS.chunk]: "0",
        [kbFiles.KB_FILE_HEADERS.chunks]: "1",
        [kbFiles.KB_FILE_HEADERS.bytes]: "7",
      },
    })
    .then(
      (a) => `acked ${a.seq}`,
      (e) => String(e),
    );
  check("a file of the knowledge base reaches its stream", file.startsWith("acked"), file);

  // What the leaf may not do.
  const raw = await connect({
    servers: `nats://127.0.0.1:${ports.pod}`,
    authenticator: nkeyAuthenticator(supSeed),
    tls: tlsOf({ ca: values.cert }, `nats://127.0.0.1:${ports.pod}`),
    inboxPrefix: rigInboxPrefix(RIG),
  });
  const seen = [];
  const all = raw.subscribe(">");
  (async () => {
    for await (const m of all) if (!m.subject.includes(RIG)) seen.push(m.subject);
  })();
  await raw.flush();
  await pause(1_000);
  await control.publish(commands.commandSubject("rig-b"), "b's command", { id: `b-${Date.now()}` });
  await control.publish(report.reportSubject("rig-b"), "b's report", { id: `br-${Date.now()}` });
  ctl.publish("thermite.anything", "x");
  await pause(2_000);
  check(
    "a subscription to everything on the pod sees nothing of the bus",
    seen.length === 0,
    seen.join(", "),
  );
  const refused = {};
  for (const subject of [
    "$JS.API.STREAM.DELETE.REPORTS",
    `${leafLink.LEAF_JS_API}.STREAM.DELETE.REPORTS`,
    `${leafLink.LEAF_JS_API}.STREAM.INFO.COMMANDS`,
    `${leafLink.LEAF_JS_API}.CONSUMER.INFO.COMMANDS.${commands.commandConsumerName("rig-b")}`,
    `${leafLink.LEAF_JS_API}.CONSUMER.CREATE.COMMANDS`,
    report.reportSubject("rig-b"),
    kb.kbAskSubject("search", "rig-b"),
    "$SYS.REQ.SERVER.PING",
  ])
    refused[subject] = await asked(raw, subject);
  check(
    "no other rig's subject, no removal, no other JetStream call and no system request gets an answer",
    Object.values(refused).every((v) => v.startsWith("no answer")),
    refused,
  );
  const elsewhere = await sup
    .publish(live.liveSubject(RIG, { run: "run-not-given", source: "judge" }), "x", {
      id: `z-${Date.now()}`,
    })
    .then(
      () => "acked",
      (e) => String(e).slice(0, 80),
    );
  check("a live line of a run not given to the rig goes nowhere", elsewhere !== "acked", elsewhere);
  const ci = await jsm.consumers.info(
    commands.COMMAND_STREAM,
    commands.commandConsumerName("rig-b"),
  );
  check("rig-b's command still waits for rig-b", ci.num_pending === 1, `pending ${ci.num_pending}`);
  await raw.close();

  // The pod's leaf port: control's certificate alone.
  const serverCert = {
    cert: readFileSync(join(files, "server-cert.pem"), "utf8"),
    key: readFileSync(join(files, "server-key.pem"), "utf8"),
  };
  const stranger = new BusTls({
    stateDir: join(work, "stranger"),
    configDir: join(work, "stranger-nats"),
    names: ["127.0.0.1"],
  });
  stranger.write();
  const met = {
    none: await leafPortMeets(values.cert, {}),
    stranger: await leafPortMeets(values.cert, {
      cert: readFileSync(join(work, "stranger-nats", "server-cert.pem"), "utf8"),
      key: readFileSync(join(work, "stranger-nats", "server-key.pem"), "utf8"),
    }),
    control: await leafPortMeets(values.cert, serverCert),
  };
  check(
    "the pod's leaf port takes control's certificate, and refuses none or a stranger's",
    /error/.test(met.none) && /error/.test(met.stranger) && met.control.includes("INFO"),
    {
      none: met.none.slice(-60),
      stranger: met.stranger.slice(-60),
      control: met.control.slice(0, 30),
    },
  );

  // An impostor: a pod's server whose certificate another authority signed, at the rig's address.
  const other = leafValues(
    new ControlTunnels(new ControlStore(":memory:"), secrets, generateSigningKeys().privateKeyPem, {
      busCa: tls.caCert,
    }).mint({ by: "owner:check", rig: RIG }).env,
  );
  const impKey = createUser();
  const impAddress = podServer(
    "thermite-leaf-check-impostor",
    `${subnet}.11`,
    ports.impostor,
    other,
    impKey.getPublicKey(),
  );
  const imp = supervisorOn(ports.impostor, impKey.getSeed(), other);
  sups.push(imp);
  store.tunnels.setLeafAddress(RIG, impAddress);
  await busUsers.sync();
  check(
    "control's server refuses a pod whose certificate another authority signed",
    !(await reportAcked(imp, 10_000)),
  );

  // A stop and a start on RunPod: the pod's server on a new address, with the same launch values.
  sh(engine, ["rm", "-f", "-t", "3", box.pod]);
  const moved = podServer(
    "thermite-leaf-check-moved",
    `${subnet}.12`,
    ports.moved,
    values,
    supKey.getPublicKey(),
  );
  const again = supervisorOn(ports.moved, supSeed, values);
  sups.push(again);
  store.tunnels.setLeafAddress(RIG, moved);
  await busUsers.sync();
  check(
    "started again at a new address, with its launch values: the reports go again",
    await reportAcked(again, 30_000),
  );

  // Retired: its connection and its account go.
  store.retired.add(RIG, "owner:check");
  await busUsers.sync();
  await pause(2_000);
  check(
    "the rig retired: control's server no longer takes its reports",
    !(await reportAcked(again, 5_000)),
  );
  const text = readFileSync(join(files, "users.conf"), "utf8");
  check(
    "and the users file names neither its account nor its pod",
    !text.includes(leafLink.leafAccount(RIG)) && !text.includes("leafnodes"),
  );
  await ctl.close();
} catch (err) {
  check("the check ran to its end", false, String(err?.stack ?? err));
  for (const c of containers) {
    try {
      console.log(
        `${c}:\n${execFileSync(engine, ["logs", "--tail", "30", c], { encoding: "utf8" })}`,
      );
    } catch {}
  }
} finally {
  for (const b of [...sups, control]) await b?.close().catch(() => {});
  cleanup();
}
const n = failed();
console.log(n ? `leaf check: ${n} failed` : "leaf check: every check passed");
process.exit(n ? 1 : 0);
