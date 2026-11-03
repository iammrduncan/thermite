import { parseArgs } from "node:util";
import { CONTROL_LOG_LEVEL, ISSUE, SET_CONTROL_LOG_LEVEL } from "../../core/api/control/owner.ts";
import { LOG_LEVELS, LOG_PARTS, type LogLevel } from "../../core/log-levels.ts";
import { controlAt, orFail } from "../calls.ts";
import { fail } from "./shared.ts";
import { USAGE } from "./usage.ts";

/**
 * thermite log-level (the guide's question 16), with the owner's token: control's own level, read
 * (`GET /v1/control/log-level`) or set at once and kept (`PUT`); or one rig part's, the harness's
 * or the supervisor's, by a signed `log_level` command (`POST /v1/commands`), which lasts until
 * another changes it or the part restarts. `default` is the part's THERMITE_LOG_LEVEL. It prints
 * control's answer as JSON on one line.
 */
export async function thermiteLogLevel(rest: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      rig: { type: "string" },
      ttl: { type: "string" },
      control: { type: "string" },
      "token-file": { type: "string" },
    },
  });
  const [part = "control", given, ...extra] = positionals;
  if (!values.control || !values["token-file"] || extra.length) fail(USAGE);
  const parts = ["control", ...LOG_PARTS];
  if (!parts.includes(part)) fail(`log-level takes ${parts.join(", ")}, not "${part}"`);
  const levels = [...LOG_LEVELS, "default"];
  if (given !== undefined && !levels.includes(given))
    fail(`log-level takes a level, ${levels.join(", ")}, not "${given}"`);
  const level = given === undefined || given === "default" ? null : (given as LogLevel);
  const control = controlAt(values.control, values["token-file"]);
  let out: unknown;
  if (part === "control") {
    if (values.rig || values.ttl)
      fail("log-level control takes no --rig or --ttl: they are a rig part's");
    out = await orFail(
      given === undefined
        ? control.call(CONTROL_LOG_LEVEL)
        : control.call(SET_CONTROL_LOG_LEVEL, { body: { level } }),
    );
  } else {
    if (given === undefined) fail(`log-level ${part} takes a level: ${levels.join(", ")}`);
    if (!values.rig) fail(`log-level ${part} takes --rig: the rig whose ${part} it changes`);
    out = await orFail(
      control.call(ISSUE, {
        body: {
          rig: values.rig,
          kind: "log_level",
          payload: { part, level },
          ...(values.ttl ? { ttl_minutes: Number(values.ttl) } : {}),
        },
      }),
    );
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}
