import type { TerminalProfile } from "../terminal.ts";

/**
 * OpenCode in its own terminal (goal 169), as the spike ran OpenCode 2.1.4: its server, with a
 * password of the trial's own (OPENCODE_SERVER_PASSWORD, in the environment of both), and its
 * terminal attached to it. The server outlives the terminal, so the host ends it after the
 * terminal. OpenCode writes no session log the host can mirror: its server's event stream and
 * its messages are its record.
 */

export const OPENCODE_TERMINAL: TerminalProfile = {
  // Esc twice within 200 ms stops the turn and its command; Esc once does nothing.
  interrupt: [{ keys: ["esc"] }, { pauseMs: 100 }, { keys: ["esc"] }],
  end: [{ text: "/exit" }],
};

/** The server's address on the trial's own port: on localhost, which every lane shares. */
export const opencodeServerUrl = (port: number): string => `http://127.0.0.1:${port}`;

/** Its server's command line, after the binary. */
export const opencodeServerArgs = (port: number): string[] => [
  "serve",
  "--hostname",
  "127.0.0.1",
  "--port",
  String(port),
];

/**
 * Its terminal's command line, after the binary: attached to the server on `port`, in the folder
 * `dir`, with nothing to answer (`--auto`) and the first message, when there is one. After a crash,
 * `session` continues the session it had (OpenCode 2.1.4's `--session`), with no message.
 */
export function opencodeTerminalArgs(
  port: number,
  dir: string,
  first?: string,
  session?: string,
): string[] {
  return [
    "--server",
    opencodeServerUrl(port),
    "--auto",
    ...(session !== undefined ? ["--session", session] : []),
    ...(first !== undefined ? ["--prompt", first] : []),
    dir,
  ];
}
