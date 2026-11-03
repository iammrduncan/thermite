import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ApiError } from "../../common/api/call.ts";
import { ATTEMPT, ATTEMPTS } from "../../core/api/harness/proposer.ts";
import { harnessAt, orFail } from "../calls.ts";
import { fail } from "./shared.ts";
import { USAGE } from "./usage.ts";

/** The scripted proposer's calls against a harness: submit a patch, and an attempt's status. */

/** thermite submit: submit a patch as a proposer. */
export async function thermiteSubmit(rest: string[]): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: {
      harness: { type: "string" },
      "token-file": { type: "string" },
      run: { type: "string" },
      "patch-file": { type: "string" },
      hypothesis: { type: "string" },
      "known-flaw": { type: "string", multiple: true },
    },
  });
  if (
    !values.harness ||
    !values["token-file"] ||
    !values.run ||
    !values["patch-file"] ||
    !values.hypothesis
  ) {
    fail(USAGE);
  }
  const out = await orFail(
    harnessAt(values.harness, values["token-file"]).call(ATTEMPTS, {
      body: {
        run: values.run,
        patch_base64: readFileSync(values["patch-file"]).toString("base64"),
        hypothesis: values.hypothesis,
        known_flaws: values["known-flaw"] ?? [],
      },
    }),
  );
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

/** thermite status: an attempt's lifecycle and verdict. */
export async function thermiteStatus(rest: string[]): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: {
      harness: { type: "string" },
      "token-file": { type: "string" },
      attempt: { type: "string" },
    },
  });
  if (!values.harness || !values["token-file"] || !values.attempt) fail(USAGE);
  const harness = harnessAt(values.harness, values["token-file"]);
  // What the harness sent, as before; an error answer ends with a non-zero exit (goal 164).
  const sent = await harness.call(ATTEMPT, { params: { id: values.attempt } }).then(
    (answer) => JSON.stringify(answer),
    (err: unknown) => {
      if (!(err instanceof ApiError) || err.status === undefined) throw err;
      process.exitCode = 1;
      return err.text;
    },
  );
  process.stdout.write(`${sent}\n`);
}
