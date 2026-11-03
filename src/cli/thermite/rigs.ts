import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ENROLL, RETIRE, RIG_TOKEN, RIGS } from "../../core/api/control/owner.ts";
import { controlAt, orFail } from "../calls.ts";
import { formatRigList, writeRigFiles } from "../rig.ts";
import { fail } from "./shared.ts";
import { USAGE } from "./usage.ts";

/** thermite rig add, token, retire and list: rigs enrolled with control. */
export async function thermiteRig(rest: string[]): Promise<void> {
  if (rest[0] === "list") {
    const { values } = parseArgs({
      args: rest.slice(1),
      options: {
        control: { type: "string" },
        "token-file": { type: "string" },
        json: { type: "boolean" },
      },
    });
    if (!values.control || !values["token-file"]) fail(USAGE);
    const listed = await orFail(controlAt(values.control, values["token-file"]).call(RIGS));
    process.stdout.write(values.json ? `${JSON.stringify(listed)}\n` : formatRigList(listed));
    return;
  }
  const [sub, rig, ...args] = rest;
  const { values } = parseArgs({
    args,
    options: {
      control: { type: "string" },
      "token-file": { type: "string" },
      out: { type: "string" },
    },
  });
  if (!rig || !values.control || !values["token-file"]) fail(USAGE);
  const url = values.control.replace(/\/$/, "");
  const control = controlAt(url, values["token-file"]);
  if (sub === "add") {
    if (!values.out) fail(USAGE);
    if (existsSync(values.out) && readdirSync(values.out).length)
      fail(`${values.out} is not empty; a rig's files are never overwritten`);
    const enrolled = await orFail(control.call(ENROLL, { body: { rig } }));
    const files = writeRigFiles(values.out, enrolled, url);
    process.stdout.write(
      `enrolled ${rig}; control's key fingerprint ${enrolled.control_fingerprint}\nwrote ${files.map((f) => join(values.out as string, f)).join("\n      ")}\n`,
    );
    return;
  }
  if (sub === "token") {
    if (!values.out) fail(USAGE);
    if (existsSync(values.out)) fail(`${values.out} exists; a token is never overwritten`);
    const out = await orFail(control.call(RIG_TOKEN, { params: { rig }, body: {} }));
    writeFileSync(values.out, `${out.token}\n`, { mode: 0o600, flag: "wx" });
    process.stdout.write(
      `${rig} has a new token, in ${values.out}; its old token no longer works\n`,
    );
    return;
  }
  if (sub === "retire") {
    await orFail(control.call(RETIRE, { params: { rig }, body: {} }));
    process.stdout.write(`${rig} is retired: its token no longer works\n`);
    return;
  }
  fail(USAGE);
}
