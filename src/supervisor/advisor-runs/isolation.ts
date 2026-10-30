import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { harnessClient } from "../../common/api/harness.ts";
import { errorText } from "../../common/errors.ts";
import { log } from "../../common/log.ts";
import { ADVISOR_RUNS_ENV, ADVISOR_RUNS_SOCKET } from "../../core/advisor-runs.ts";
import {
  SUPERVISOR_ISOLATION,
  SUPERVISOR_ISOLATION_MAX,
  type SupervisorIsolation,
} from "../../core/api/harness/supervisor.ts";
import type { SignedCommand } from "../../core/commands.ts";
import { BUS_KEY_FILE, SEAL_KEY_FILE } from "../relay/index.ts";
import { type AdvisorRunner, advisorRunner } from "./runner.ts";

/**
 * The supervisor's part of the isolation check: an advisor user, as the runner starts each
 * advisor's program, tries to read the supervisor's tokens, keys and seeds, to list its state, the
 * inbox, the results and the other runs' root, to open the runner's socket, and to signal the
 * supervisor or read its environment. Every probe must be refused. The supervisor does it at its
 * start and before it hands the harness each isolation check, and gives the harness the result,
 * which the check shows (core/api/harness/supervisor.ts: SUPERVISOR_ISOLATION).
 */

export interface AdvisorProbe {
  name: string;
  op: "read" | "list" | "access" | "signal";
  path: string;
}

/**
 * The script an advisor user runs (node -e, the probes as JSON in argv[1]): each probe's error
 * code when it was refused, and "ALLOWED" when it got through, as the harness's probes say it.
 * `signal` sends signal 0 to the process `path` names.
 */
export const ADVISOR_PROBE = `
const fs = require("node:fs");
const out = {};
for (const p of JSON.parse(process.argv[1])) {
  try {
    if (p.op === "read") fs.readFileSync(p.path);
    else if (p.op === "list") fs.readdirSync(p.path);
    else if (p.op === "signal") process.kill(Number(p.path), 0);
    else fs.accessSync(p.path, fs.constants.W_OK);
    out[p.name] = "ALLOWED";
  } catch (e) {
    out[p.name] = e.code || String(e);
  }
}
process.stdout.write(JSON.stringify(out));
`;

/** The first file under a folder, at most three folders down, by its full path. */
function firstFile(dir: string, depth = 3): string | undefined {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return undefined;
  }
  for (const n of names) {
    const p = join(dir, n);
    try {
      const st = statSync(p);
      if (st.isFile()) return p;
      if (st.isDirectory() && depth > 0) {
        const f = firstFile(p, depth - 1);
        if (f) return f;
      }
    } catch {
      // gone while it was looked at
    }
  }
  return undefined;
}

/** Every `api_key_file` the advisors file names, at any depth. */
function keyFiles(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) keyFiles(v, out);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      if (k === "api_key_file" && typeof v === "string") out.push(v);
      else keyFiles(v, out);
    }
  return out;
}

/** What an advisor user must not reach on this supervisor: only what is there. */
export function advisorProbes(o: {
  env: Record<string, string | undefined>;
  /** The supervisor's state (THERMITE_SUPERVISOR_HOME). */
  home: string;
  inboxDir: string;
  runner: AdvisorRunner;
  /** The supervisor's process. */
  pid: number;
}): AdvisorProbe[] {
  const { env, home } = o;
  const probes: AdvisorProbe[] = [
    { name: "state-list", op: "list", path: home },
    { name: "inbox-list", op: "list", path: o.inboxDir },
    { name: "runs-list", op: "list", path: o.runner.root },
    {
      name: "runner-socket",
      op: "access",
      path: env[ADVISOR_RUNS_ENV.socket] ?? ADVISOR_RUNS_SOCKET,
    },
    { name: "supervisor-signal", op: "signal", path: String(o.pid) },
    { name: "supervisor-environ", op: "read", path: `/proc/${o.pid}/environ` },
  ];
  const files: [string, string | undefined][] = [
    ["bus-key", join(home, BUS_KEY_FILE)],
    ["seal-key", join(home, SEAL_KEY_FILE)],
    ["relay-state", join(home, "relay-state.json")],
    [
      "tunnel-keys",
      env.THERMITE_TUNNEL_DIR ? join(env.THERMITE_TUNNEL_DIR, "keys.json") : undefined,
    ],
    ["harness-token", env.THERMITE_HARNESS_TOKEN_FILE],
    ["control-token", env.THERMITE_CONTROL_TOKEN_FILE],
    ["results-key", env.THERMITE_RESULTS_KEY_FILE],
    ["hf-token", env.THERMITE_HF_TOKEN_FILE],
    ["advisors-file", env.THERMITE_ADVISORS_FILE],
    ["inbox-read", firstFile(o.inboxDir)],
  ];
  const advisors = env.THERMITE_ADVISORS_FILE;
  if (advisors) {
    probes.push({ name: "advisors-folder", op: "list", path: dirname(advisors) });
    try {
      for (const [i, f] of keyFiles(JSON.parse(readFileSync(advisors, "utf8"))).entries())
        files.push([`advisor-key-${i + 1}`, f]);
    } catch {
      // The supervisor stops at start on an advisors file it can't read; nothing more to try.
    }
  }
  for (const [name, path] of files)
    if (path && existsSync(path)) probes.push({ name, op: "read", path });
  for (const [name, path] of [
    ["secrets-list", "/run/secrets"],
    ["results-list", "/results"],
  ] as const)
    if (existsSync(path)) probes.push({ name, op: "list", path });
  return probes.slice(0, SUPERVISOR_ISOLATION_MAX.probes);
}

/** Runs the probes as an advisor user, through the runner; without one, says why it can't. */
export async function probeAdvisorUsers(o: {
  env: Record<string, string | undefined>;
  home: string;
  inboxDir: string;
  runner: AdvisorRunner | undefined;
  pid?: number | undefined;
}): Promise<SupervisorIsolation> {
  const at = new Date().toISOString();
  const runner = o.runner;
  if (!runner)
    return {
      at,
      separated: false,
      probes: {
        "advisor-users":
          "ALLOWED: no advisors' runner, so advisor programs run as the supervisor's own user",
      },
    };
  const probes = advisorProbes({ ...o, runner, pid: o.pid ?? process.pid });
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(runner.root, "probe-"));
    const r = await runner.client.run({
      dir,
      argv: [process.execPath, "-e", ADVISOR_PROBE, JSON.stringify(probes)],
      env: {},
      stdin: "",
      timeoutMs: 30_000,
    });
    let results: Record<string, string>;
    try {
      results = JSON.parse(r.stdout) as Record<string, string>;
    } catch {
      results = { "advisor-probe": `failed: exit ${r.exitCode} ${r.stderr.slice(-200)}` };
    }
    // User 0 of the runner is its own: it does not run as root, and keeps no run apart.
    if (r.user === 0)
      results["advisor-user"] = "ALLOWED: the runner runs each program as the supervisor's user";
    const cut = (t: string) => t.slice(0, SUPERVISOR_ISOLATION_MAX.result);
    return {
      at,
      separated: r.user !== 0,
      probes: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, cut(String(v))])),
    };
  } catch (err) {
    return { at, separated: true, probes: { "advisor-probe": `failed: ${errorText(err)}` } };
  } finally {
    if (dir) await runner.client.remove(dir).catch(() => undefined);
  }
}

/**
 * The supervisor's part of the isolation check, given to its harness: at its start (`report`),
 * and before it hands over each isolation check (`before`, with each command it relays).
 */
export function advisorIsolation(o: {
  env: Record<string, string | undefined>;
  home: string;
  inboxDir: string;
  harnessUrl: string;
  harnessToken: string;
}): { report(why: string): Promise<void>; before(cmd: SignedCommand): Promise<void> } {
  const harness = harnessClient({ url: o.harnessUrl, token: o.harnessToken });
  const report = async (why: string) => {
    const r = await probeAdvisorUsers({ ...o, runner: advisorRunner(o.env) });
    const through = Object.entries(r.probes).filter(([, v]) => /^(ALLOWED|failed)/.test(v));
    log(
      "supervisor",
      through.length ? "advisor users are NOT kept apart" : "advisor users are kept apart",
      { why, probes: Object.keys(r.probes).length, through: Object.fromEntries(through) },
      through.length ? "warn" : "info",
    );
    await harness
      .call(SUPERVISOR_ISOLATION, { body: r })
      .catch((err) =>
        log(
          "supervisor",
          "the harness did not take the advisor users' isolation probe",
          { error: errorText(err) },
          "warn",
        ),
      );
  };
  return {
    report,
    before: async (cmd) => {
      const payload = cmd.envelope.payload as { check?: unknown } | undefined;
      if (cmd.envelope.kind === "rig_check" && payload?.check === "isolation")
        await report("before an isolation check");
    },
  };
}
