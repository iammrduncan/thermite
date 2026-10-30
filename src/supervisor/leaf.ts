import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BusTrust } from "../common/bus/index.ts";
import { log } from "../common/env.ts";
import { writeAtomic } from "../common/fs.ts";
import {
  fromEnvLine,
  LEAF_ENV,
  LEAF_JS_API,
  POD_BUS_URL,
  type PodBusFiles,
  podServerConfig,
} from "../core/link/leaf.ts";
import { REPORT_MAX_BYTES } from "../core/link/report.ts";
import { podTunnelDirs } from "../core/tunnel.ts";
import { busKey } from "./relay/index.ts";

/**
 * A rig on RunPod on the message bus (goal 168): its pod's own NATS server, which control's
 * server dials as a leaf node (core/link/leaf.ts). The supervisor writes the server's files from
 * its launch values at each start, in the tunnel's folder, which only it may read; starts the
 * server as its own child, and again after it exits; and signs in to it on the pod's loopback with
 * the rig's key, as a supervisor elsewhere signs in to control's server. The pod's key is taken out
 * of the supervisor's environment, so nothing it starts has it.
 */

/** The pod's server's program: the rig image copies it from the bus's pinned server image. */
export const POD_BUS_PROGRAM = "/usr/local/bin/nats-server";
/** After the pod's server exits, it starts again after this long. */
export const POD_BUS_RESTART_MS = 5_000;
/** At a stop, the pod's server has this long to end, and is then killed. */
const POD_BUS_STOP_MS = 5_000;
/** The longest line of the pod's server's log the supervisor's log keeps. */
const LOG_LINE_MAX = 500;

/** The leaf's launch values, as PEM texts. */
export interface LeafValues {
  cert: string;
  key: string;
  controlCa: string;
}

/**
 * The leaf's launch values, when the launch gave them: all three, or none (a pod launched
 * without the leaf). One or two, or one that is not a PEM text, stops the supervisor, in words.
 */
export function leafValues(env: Record<string, string | undefined>): LeafValues | undefined {
  const names = Object.values(LEAF_ENV);
  const given = names.filter((n) => env[n]?.trim());
  if (!given.length) return undefined;
  if (given.length < names.length)
    throw new Error(
      `the leaf node needs ${names.join(", ")}; the launch gave only ${given.join(", ")}`,
    );
  const read = (name: string) => fromEnvLine(name, env[name] ?? "");
  return {
    cert: read(LEAF_ENV.cert),
    key: read(LEAF_ENV.key),
    controlCa: read(LEAF_ENV.controlCa),
  };
}

/**
 * Writes the pod's server's files to `dir` (0700): its certificate, its key (0600), control's
 * authority and its configuration, which lets in the supervisor's key. Returns the paths of the
 * configuration and of the certificate, which the supervisor trusts the server through.
 */
export function writePodBus(
  dir: string,
  values: LeafValues,
  supervisorKey: string,
): { config: string; cert: string } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const files: PodBusFiles = {
    cert: join(dir, "leaf-cert.pem"),
    key: join(dir, "leaf-key.pem"),
    controlCa: join(dir, "control-ca.pem"),
  };
  writeAtomic(files.key, values.key, 0o600);
  writeAtomic(files.cert, values.cert, 0o644);
  writeAtomic(files.controlCa, values.controlCa, 0o644);
  const config = join(dir, "server.conf");
  const text = podServerConfig({ files, supervisorKey, maxPayload: REPORT_MAX_BYTES });
  writeAtomic(config, text, 0o600);
  return { config, cert: files.cert };
}

/** The pod's server, as the supervisor reaches it. */
export interface PodBus {
  url: string;
  /** The file of the pod's certificate and its authority, which the supervisor trusts. */
  trust: BusTrust;
  /** Where the JetStream API answers on a leaf node (LEAF_JS_API). */
  apiPrefix: string;
  /** Stops the server, and starts it no more. */
  stop(): Promise<void>;
}

/**
 * The pod's server, when the launch gave the leaf's values: its files written in the tunnel's
 * folder, and the server started. Undefined without them. A test gives its own program and wait.
 */
export function startPodBus(
  env: NodeJS.ProcessEnv,
  home: string,
  o: { program?: string; restartMs?: number } = {},
): PodBus | undefined {
  const program = o.program ?? POD_BUS_PROGRAM;
  const restartMs = o.restartMs ?? POD_BUS_RESTART_MS;
  const values = leafValues(env);
  if (!values) return undefined;
  delete env[LEAF_ENV.key];
  const { config, cert } = writePodBus(
    join(podTunnelDirs(env, home).dir, "bus"),
    values,
    busKey(home).publicKey,
  );
  let child: ChildProcess | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const start = () => {
    if (stopped) return;
    const proc = spawn(program, ["-c", config], { env: {}, stdio: ["ignore", "ignore", "pipe"] });
    child = proc;
    let rest = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      const lines = `${rest}${chunk.toString("utf8")}`.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines)
        if (line.trim())
          log("supervisor", "the pod's bus server", { line: line.slice(0, LOG_LINE_MAX) });
    });
    const ended = (code: number | null, signal: string | null, error?: string) => {
      if (child !== proc) return;
      child = undefined;
      if (stopped) return;
      log(
        "supervisor",
        "the pod's bus server exited; starting it again",
        { code, signal, ...(error ? { error } : {}), again_in_s: restartMs / 1000 },
        "warn",
      );
      timer = setTimeout(start, restartMs);
    };
    proc.on("exit", (code, signal) => ended(code, signal));
    proc.on("error", (err) => ended(null, null, err.message));
  };
  start();
  log("supervisor", "the pod's bus server started: control's server dials it as a leaf node", {
    bus: new URL(POD_BUS_URL).host,
  });
  return {
    url: POD_BUS_URL,
    trust: { caFile: cert },
    apiPrefix: LEAF_JS_API,
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      const proc = child;
      if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        const kill = setTimeout(() => proc.kill("SIGKILL"), POD_BUS_STOP_MS);
        proc.once("exit", () => {
          clearTimeout(kill);
          resolve();
        });
        proc.kill("SIGTERM");
      });
    },
  };
}
