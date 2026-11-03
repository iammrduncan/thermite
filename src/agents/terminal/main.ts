import { chmodSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { errorText } from "../../common/errors.ts";
import { log, logError } from "../../common/log.ts";
import { TerminalHost } from "./host.ts";
import { START_MAX, TERMINAL_SOCKET, TerminalStart } from "./protocol.ts";
import { serveTerminal } from "./server.ts";

/**
 * The terminal host's entry (goal 169): one process for one run of an agent program in its own
 * terminal, started by its caller's runner as the role's user, in the run's area (by the broker,
 * under the lane's limits, its GPU fence and its network rules, as the program is). It reads its
 * start, one JSON line, on its stdin; serves its caller on its socket in its working folder
 * (TERMINAL_SOCKET); and exits
 * when the program has ended, its last line on stdout `{"msg":"the program ended", ...}` with how.
 * The program's environment is the host's own, with TERM an xterm's.
 */

const area = process.cwd();
const socket = join(area, TERMINAL_SOCKET);

/** A socket, or a link, left in the socket's place by an earlier run is removed. */
function clearSocket(): void {
  try {
    const st = lstatSync(socket);
    if (st.isSocket() || st.isSymbolicLink()) unlinkSync(socket);
  } catch {
    // nothing there
  }
}

async function main(): Promise<number> {
  const line = readFileSync(0, "utf8");
  if (line.length > START_MAX) throw new Error(`its start is over ${START_MAX} bytes`);
  const start = TerminalStart.parse(JSON.parse(line));
  const env = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
  );
  const host = new TerminalHost(start, env, area);
  clearSocket();
  const server = serveTerminal(host, socket, start.secret);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  // The caller's user is in neither the role's user nor its group: it may connect only through
  // "other". The area is the role's, which only the caller's group may enter besides.
  chmodSync(socket, 0o666);
  log("terminal", "the host listens", { trial: start.trial, socket });
  await host.run();
  // The answer to an end the harness asked for goes out before the host exits.
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    setTimeout(resolve, 2000).unref();
  });
  clearSocket();
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    logError("terminal", "the host could not run", { error: errorText(err) });
    clearSocket();
    process.exit(1);
  },
);
