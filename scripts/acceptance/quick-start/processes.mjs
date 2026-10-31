import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandsFor, rewrite } from "../../../tests/helpers/quick-start.ts";
import { COMPOSE } from "./context.mjs";

// ---------------------------------------------------------------- processes

export const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
export const quiet = (cmd, args, opts = {}) =>
  sh(cmd, args, { stdio: ["ignore", "pipe", "ignore"], ...opts });
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createNetServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
export const portInUse = (port) =>
  new Promise((resolve) => {
    const s = createNetServer();
    s.once("error", () => resolve(true));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(false)));
  });

// The tester's shell: this one's, without Thermite's or compose's own variables.
export const testerEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(THERMITE_|COMPOSE)/.test(k)),
);
export const work = mkdtempSync(join(tmpdir(), "thermite-quick-start-"));
export const home = join(work, "home");
mkdirSync(home);
export let cwd = home;
/** Takes the tester back to a folder, as `cd` does. */
export function cd(dir) {
  cwd = dir;
}
export const rewrites = [];
export const hits = new Map();

/**
 * Runs a page's commands as the tester types them, in the tester's folder, and follows its `cd`.
 * Returns what they print. Output that holds a token is not shown.
 */
export async function typed(lines, what, { secret = false } = {}) {
  const cmds = commandsFor(lines, COMPOSE).map((l) => rewrite(l, rewrites, hits));
  for (const c of cmds) console.log(`  $ ${c}`);
  const cwdFile = join(work, "cwd");
  // Not a synchronous child: the release's server and the scripted model answer from this process.
  const child = spawn(
    "sh",
    ["-c", `set -e\ncd ${sq(cwd)}\n${cmds.join("\n")}\npwd > ${sq(cwdFile)}\n`],
    { env: testerEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (d) => {
    out += d;
    if (!secret) process.stdout.write(d.replace(/^(?=.)/gm, "    "));
  });
  child.stderr
    .setEncoding("utf8")
    .on("data", (d) => process.stderr.write(d.replace(/^(?=.)/gm, "    ")));
  const timer = setTimeout(() => child.kill("SIGTERM"), 30 * 60_000);
  const [code, signal] = await new Promise((resolve) =>
    child.on("close", (c, s) => resolve([c, s])),
  );
  clearTimeout(timer);
  if (code !== 0) throw new Error(`${what}: the commands ended with exit ${code ?? signal}`);
  cwd = readFileSync(cwdFile, "utf8").trim();
  return out;
}
