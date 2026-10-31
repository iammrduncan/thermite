import { readFileSync } from "node:fs";
import { ApiError } from "../common/api/call.ts";
import { type ControlClient, controlClient } from "../common/api/control.ts";
import { type HarnessClient, harnessClient } from "../common/api/harness.ts";

/**
 * The command line's calls to control and to a rig's harness (core/api/ has their routes), with
 * the token in the file it was given. An answer that refuses ends the command, as it always has:
 * the address, the status and the answer, on standard error, with exit code 2.
 */

const tokenIn = (file: string) => readFileSync(file, "utf8").trim();

/** Control's API at `url`, with the token in `tokenFile` (the owner's). */
export function controlAt(url: string, tokenFile: string): ControlClient {
  return controlClient({ url, token: tokenIn(tokenFile) });
}

/** A rig's harness at `url`, with the token in `tokenFile` (a proposer's). */
export function harnessAt(url: string, tokenFile: string): HarnessClient {
  return harnessClient({ url, token: tokenIn(tokenFile) });
}

/** A call's answer; an answer that refuses ends the command with what control or the harness said. */
export async function orFail<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (err) {
    if (!(err instanceof ApiError) || err.status === undefined || err.code === "bad_answer")
      throw err;
    process.stderr.write(`${err.url} -> ${err.status} ${err.text}\n`);
    process.exit(2);
  }
}
