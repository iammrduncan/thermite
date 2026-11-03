// @ts-check
// Metrics' figures of the bus (goal 179) against the bus check's real server (bus.mjs): what the
// tests' canned answers stand in for, on the pinned NATS server.
//   - Control's system user asks the server's monitoring (VARZ, JSZ, CONNZ and LEAFZ) on one
//     kept connection (ServerLook), and control's shaping (BusFiguresLook) reads every stream
//     with its limits, every consumer control made, and the connections with whose key each is.
//   - A second look gives rates.
//   - The stream inspector reads REPORTS, a work queue, with the server's message lookup: the
//     messages come back by subject, newest first, and no consumer is made by reading.
//   - The system user may ask for nothing else: not the accounts' figures, not a kick of a client.
import { jetstreamManager } from "@nats-io/jetstream";

const { BusFiguresLook, streamPage } = await import("../../../src/control/system/index.ts");
const { ServerLook } = await import("../../../src/control/bus/index.ts");
const { LIVE_KEPT_BYTES, LIVE_STREAM } = await import("../../../src/core/link/live.ts");
const { REPORT_STREAM, reportSubject } = await import("../../../src/core/link/report.ts");
const { commandConsumerName } = await import("../../../src/core/link/commands.ts");

/** @typedef {import("@nats-io/transport-node").NatsConnection} NatsConnection */

/**
 * @param {{
 *   check: (what: string, ok: boolean, detail?: unknown) => void,
 *   tried: (fn: () => unknown) => Promise<string>,
 *   url: string,
 *   trust: { ca: string },
 *   keys: { control: { publicKey: string }, system: { seed: Uint8Array }, a: { publicKey: string } },
 *   bus: import("../../../src/common/bus/index.ts").Bus,
 *   control: NatsConnection,
 *   system: NatsConnection,
 * }} o
 */
export async function systemFiguresChecks(o) {
  const { check, tried } = o;
  const look = new ServerLook({ url: o.url, seed: o.keys.system.seed, trust: o.trust });
  try {
    const figures = new BusFiguresLook({
      look,
      holders: () =>
        new Map([
          [o.keys.control.publicKey, "control"],
          [o.keys.a.publicKey, "rig rig-a"],
        ]),
    });
    const f = await figures.read();
    check(
      "the server's figures come whole: VARZ, JSZ, CONNZ and LEAFZ",
      f.errors.length === 0,
      f.errors,
    );
    check(
      "the server: its version, memory and JetStream's store against its limit",
      /^2\./.test(f.server?.version ?? "") &&
        (f.server?.memory_bytes ?? 0) > 0 &&
        (f.server?.jetstream?.store_max ?? 0) > 0,
      f.server,
    );
    const names = f.streams.map((s) => s.name);
    check(
      "every stream, each kept on disk, with its limits",
      ["COMMANDS", "CONFIG", "EVENTS", "KB_FILES", "LIVE", "REPORTS"].every((n) =>
        names.includes(n),
      ) &&
        f.streams.every((s) => s.config.storage === "file") &&
        f.streams.find((s) => s.name === LIVE_STREAM)?.config.max_bytes === LIVE_KEPT_BYTES,
      f.streams.map((s) => [s.name, s.config]),
    );
    check(
      "the consumers control made, with what waits for each",
      f.consumers.some((c) => c.name === commandConsumerName("rig-a") && c.durable),
      f.consumers.map((c) => c.name),
    );
    // The check signs in with control's key twice: its own connection, and control's code's.
    check(
      "the connections, each named by whose key it signed in with, with its subscriptions",
      f.connections.some((c) => c.user === "control" && c.name === "control") &&
        f.connections.some((c) => c.user === "rig rig-a" && c.subscriptions.length > 0),
      f.connections.map((c) => [c.name, c.user, c.subscriptions.length]),
    );
    await new Promise((r) => setTimeout(r, 1100));
    const again = await figures.read();
    check(
      "a second look gives rates",
      again.server?.rate !== null && again.server?.rate !== undefined,
      again.server?.rate,
    );

    // The inspector reads a work queue by subject and makes no consumer.
    const jsm = await jetstreamManager(o.control);
    const before = (await jsm.streams.info(REPORT_STREAM)).state.consumer_count;
    const page = await streamPage(o.bus, REPORT_STREAM, { subject: reportSubject("rig-a") });
    const after = (await jsm.streams.info(REPORT_STREAM)).state.consumer_count;
    const seqs = page.messages.map((m) => m.seq);
    check(
      "the inspector reads REPORTS by subject, newest first, with no consumer made",
      seqs.length > 0 &&
        page.messages.every((m) => m.subject === reportSubject("rig-a")) &&
        seqs.every((s, i) => i === 0 || s < (seqs[i - 1] ?? 0)) &&
        before === after,
      { seqs, before, after },
    );

    // Nothing else for the system user.
    const id = o.system.info?.server_id ?? "";
    for (const what of ["ACCOUNTZ", "KICK"])
      check(
        `control's system user may not ask for ${what}`,
        (await tried(() =>
          o.system.request(`$SYS.REQ.SERVER.${id}.${what}`, "{}", { timeout: 3000 }),
        )) === "denied",
      );
  } finally {
    await look.close();
  }
}
