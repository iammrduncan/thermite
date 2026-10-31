import { join } from "node:path";
import { newToken } from "../../common/secrets.ts";
import { opencodeOwn } from "../compaction/index.ts";
import {
  newTally,
  OPENCODE_DROPS,
  OPENCODE_PLUGIN,
  OPENCODE_PLUGIN_LINK,
  type OpencodeTally,
  opencodeArgs,
  opencodeBin,
  opencodeConfig,
  opencodeExe,
  opencodeExitWords,
  opencodeFound,
  opencodeKeepEnv,
  opencodeModelId,
  opencodeServerArgs,
  opencodeSession,
  opencodeTerminalArgs,
  readOpencodeEvents,
  runEnv,
} from "../programs/index.ts";
import type { CliProgram, CliRun } from "./program.ts";

/**
 * Trials (hill-climb, goal and research), model checks and planner calls in OpenCode v2 instead
 * of Pi. OpenCode runs headless with its permissions approved (`--auto`), or in its own terminal
 * where the rig says so (goal 169; terminal.ts), as the lane's own user, in the lane's
 * workspace, under the same memory, disk and time limits as the lane's commands: it has exactly
 * the lane's access, and none of the judge's. Its permission rules are not a boundary
 * (its Code Mode reaches the network whatever they say); the user it runs as is.
 *
 * Thermite's own tools are the `thermite-trial` command (submit, dev-run, status, and a research
 * trial's tools), which calls the harness API with the trial's token. A provider's key never
 * reaches the lane: OpenCode calls the provider through the harness API's model proxy, which
 * checks the trial's token and adds the key. OpenCode's own models (its free ones) need no key.
 */

/**
 * What OpenCode itself uses, as its limits note says: in its own terminal, the default, its server,
 * its terminal and the terminal host, as the harness image's terminal check measured them
 * (2026-10-29: 636 to 640 MiB at their peak).
 */
export const OPENCODE_MEMORY = "about 650 MiB";

/** A trial's configuration for OpenCode: its route through the proxy, and its MCP servers. */
const trialConfig = (run: CliRun) =>
  opencodeConfig(run.model, `${run.apiUrl}/v1/model-proxy`, run.mcp);

/**
 * OpenCode in the CLI trial loop and the one-prompt call: `opencode run` continues its session
 * with each continuation; in its own terminal (goal 169), its server and its terminal attached to
 * it. It runs research trials too.
 */
export const opencodeProgram: CliProgram<OpencodeTally> = {
  id: "opencode",
  name: "OpenCode",
  research: true,
  prefix: "opencode",
  eventsVar: "THERMITE_OPENCODE_EVENTS",
  turnWords: "each model reply is one",
  memory: OPENCODE_MEMORY,
  bin: opencodeBin,
  exe: opencodeExe,
  // The configuration may hold the trial's own token (its MCP servers): only the lane reads it.
  // Thermite's plugin is linked into its settings: it writes OpenCode's events to the trial's
  // signals file and steers the owner's messages in inside the agent's turn (goal 169), and, with
  // a place to keep the conversation, keeps it before each compaction in its folder (goal 070).
  setup: (run) => {
    const keep = run.keptAt !== undefined;
    return {
      script: `mkdir -p opencode-home/.config/opencode/plugins opencode-tmp && ln -sf "$1" opencode-home/${OPENCODE_PLUGIN_LINK} && : > opencode-signals.jsonl && chmod 0644 opencode-signals.jsonl${keep ? ` && mkdir -p ${OPENCODE_DROPS} && chmod 0755 ${OPENCODE_DROPS}` : ""} && umask 077 && cat > opencode-home/.config/opencode/opencode.jsonc && : > opencode-events.jsonl && chmod 0644 opencode-events.jsonl`,
      args: ["sh", OPENCODE_PLUGIN],
      stdin: JSON.stringify(trialConfig(run)),
    };
  },
  env: (run) => ({
    ...runEnv(run.home, run.apiUrl, run.auth, run.env ?? {}),
    // Its own temp directory: the shared /tmp is not the lane's.
    TMPDIR: run.tmp,
    ...(run.keptAt ? opencodeKeepEnv(join(run.area, OPENCODE_DROPS), run.keptAt) : {}),
  }),
  args: (run, session) => [
    ...opencodeArgs(run.model),
    ...(session ? ["--session", session] : ["--title", `trial ${run.id}`]),
  ],
  newTally,
  read: readOpencodeEvents,
  found: (_t, read) => opencodeFound(read.area, [OPENCODE_DROPS], read.count, read.at),
  // Each compaction Thermite's plugin saw end, with the session it kept before it (goal 070).
  own: (run) => opencodeOwn({ root: run.area, drops: [OPENCODE_DROPS], title: run.title }),
  exitWords: opencodeExitWords,
  // OpenCode's events, as Thermite's plugin writes them (goal 169). It steers a message in after a
  // tool; at the turn's end `opencode run` ends, and the continuation carries it.
  signals: {
    adapter: () => opencodeSession,
    how: {
      "after-tool": "Thermite's OpenCode plugin",
      "turn-end": "Thermite's OpenCode plugin",
    },
  },
  // In its own terminal: its server first, on a free port of localhost with a password of the
  // run's own, then its terminal attached to it, the model in its configuration (`opencode run`
  // takes it as a flag). It writes no session log the host can copy: Thermite's plugin writes its
  // events to the trial's signals file, which is its record (goal 169).
  terminal: {
    server: true,
    start: (run, at) => {
      const port = at.port;
      if (port === undefined) throw new Error("OpenCode's terminal needs a port for its server");
      return {
        args: opencodeTerminalArgs(port, at.cwd, undefined, at.resume ? at.session : undefined),
        env: { OPENCODE_SERVER_PASSWORD: newToken().token, OPENCODE_DISABLE_AUTOUPDATE: "1" },
        seeds: [
          {
            path: join(run.home, ".config", "opencode", "opencode.jsonc"),
            content: JSON.stringify({ ...trialConfig(run), model: opencodeModelId(run.model) }),
            mode: 0o600,
          },
        ],
        server: { args: opencodeServerArgs(port), port },
      };
    },
    log: { adapter: () => opencodeSession, from: "signals" },
  },
  call: {
    // Thermite's compaction plugin, when the call's conversation is kept (goal 070).
    setup: (c) => {
      const keep = c.keptAt !== undefined;
      return {
        script: `mkdir -p home/.config/opencode tmp && umask 077 && cat > home/.config/opencode/opencode.jsonc${keep ? ` && mkdir -p home/.config/opencode/plugins compactions && ln -sf "$1" home/${OPENCODE_PLUGIN_LINK}` : ""}`,
        args: keep ? ["sh", OPENCODE_PLUGIN] : [],
        stdin: JSON.stringify(opencodeConfig(c.model, `${c.apiUrl}/v1/model-proxy`, c.mcp)),
      };
    },
    // A credential minted for the call reaches the proxy (none needed for OpenCode's own models).
    env: (c) => ({
      ...runEnv(c.home, c.apiUrl, c.proxyAuth(), {}),
      TMPDIR: c.tmp,
      ...(c.keptAt ? opencodeKeepEnv(join(c.dir, "compactions"), c.keptAt) : {}),
    }),
    args: (c) => opencodeArgs(c.model),
    // The plugin's records, which the controller reads once it has the call's folder back.
    kept: (c, at) => opencodeFound(c.dir, ["compactions"], 0, at),
    own: (c, title) => opencodeOwn({ root: c.dir, drops: ["compactions"], title }),
  },
  check: { baseUrl: (m) => (m.api === "opencode" ? "opencode" : m.baseUrl) },
};
