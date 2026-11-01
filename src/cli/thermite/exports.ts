import { parseArgs } from "node:util";
import { EXPORTS_DELETE } from "../../core/api/control/owner.ts";
import { controlAt, orFail } from "../calls.ts";
import { fail } from "./shared.ts";
import { USAGE } from "./usage.ts";

/**
 * thermite exports delete: exports control keeps, deleted by hand with the owner's token, as
 * Delete on the dashboard's Exports page does. It prints what went, in control's words.
 */
export async function thermiteExports(rest: string[]): Promise<void> {
  const [sub, ...args] = rest;
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { control: { type: "string" }, "token-file": { type: "string" } },
  });
  const [rig, ...names] = positionals;
  if (sub !== "delete" || !values.control || !values["token-file"] || !rig || !names.length)
    fail(USAGE);
  const control = controlAt(values.control, values["token-file"]);
  const body = { exports: names.map((name) => ({ rig, name })) };
  const out = await orFail(control.call(EXPORTS_DELETE, { body }));
  process.stdout.write(`${out.said}\n`);
}
