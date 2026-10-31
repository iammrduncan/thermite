import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ApiError, UPLOAD_TIMEOUT_MS } from "../../common/api/call.ts";
import { errorText } from "../../common/errors.ts";
import { KIT_ADD, KITS } from "../../core/api/control/owner.ts";
import { controlAt, orFail } from "../calls.ts";
import { fail } from "./shared.ts";
import { USAGE } from "./usage.ts";

/** thermite kit add and list: the kits control keeps. */
export async function thermiteKit(rest: string[]): Promise<void> {
  // Kits control keeps (goal 096): a kit repository written elsewhere, given as a git bundle.
  const [sub, ...args] = rest;
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      control: { type: "string" },
      "token-file": { type: "string" },
      ref: { type: "string" },
      force: { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  if (!values.control || !values["token-file"])
    fail("give --control and --token-file: control keeps the kits");
  const control = controlAt(values.control, values["token-file"]);
  if (sub === "list" && !positionals.length) {
    const out = await orFail(control.call(KITS));
    if (values.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    else if (!out.kits.length) process.stdout.write("control keeps no kit\n");
    else
      for (const k of out.kits)
        process.stdout.write(
          `${k.name}  ${k.head}  ${k.commits} commit${k.commits === 1 ? "" : "s"}  ${k.kit ? `${k.kit.name} on ${k.kit.target}` : (k.kit_error ?? "no valid kit.json")}\n`,
        );
    return;
  }
  const [name, file] = positionals;
  if (sub !== "add" || !name || !file || positionals.length > 2) fail(USAGE);
  let bundle: Buffer;
  try {
    bundle = readFileSync(file);
  } catch (err) {
    fail(`${file}: ${errorText(err)}`);
  }
  const out = await control
    .call(KIT_ADD, {
      params: { name },
      query: { ref: values.ref || undefined, force: values.force ? "true" : undefined },
      bytes: new Uint8Array(bundle),
      timeoutMs: UPLOAD_TIMEOUT_MS,
    })
    .catch((err: unknown) => {
      if (!(err instanceof ApiError) || err.status === undefined) throw err;
      const said = (err.answer as { error?: string } | undefined)?.error ?? err.text;
      return fail(`control refused the kit (${err.status}): ${said}`);
    });
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.said) process.stderr.write(`${out.said}\n`);
}
