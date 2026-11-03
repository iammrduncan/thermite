import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { errorText } from "../../common/errors.ts";
import {
  CAMPAIGN_ADDITIONS,
  CAMPAIGN_CONTEXT,
  CAMPAIGN_COPY,
  START_RUN,
} from "../../core/api/control/owner.ts";
import { controlAt, orFail } from "../calls.ts";
import { briefFromFlags, contextFromFlags, fail } from "./shared.ts";
import { USAGE } from "./usage.ts";

/**
 * The commands for the campaigns control keeps: start a run of one, copy one, set its context, set
 * the owner's additions to its roles.
 */

/** thermite run start: start a run of a campaign control keeps. */
export async function thermiteRun(rest: string[]): Promise<void> {
  const [sub, campaign, ...args] = rest;
  if (sub !== "start" || !campaign || campaign.startsWith("-")) fail(USAGE);
  const { values } = parseArgs({
    args,
    options: {
      rig: { type: "string" },
      agents: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      promotion: { type: "string" },
      ask: { type: "string", multiple: true },
      "judge-gpus": { type: "string" },
      "queue-from": { type: "string" },
      past: { type: "string", multiple: true },
      fresh: { type: "boolean" },
      granted: { type: "string", multiple: true },
      "no-granted": { type: "boolean" },
      control: { type: "string" },
      "token-file": { type: "string" },
    },
  });
  if (!values.control || !values["token-file"])
    fail("give --control and --token-file: control starts the run");
  const { runStartBody, runStartSaid } = await import("../run.ts");
  let body: Record<string, unknown>;
  try {
    body = runStartBody(values);
  } catch (err) {
    fail(errorText(err));
  }
  const out = await orFail(
    controlAt(values.control, values["token-file"]).call(START_RUN, {
      params: { campaign },
      body,
    }),
  );
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.stderr.write(runStartSaid(out));
  // Not started yet (the rig was given a model first): a script must not take it as started.
  if (out.started === false) process.exitCode = 1;
}

/**
 * The owner's additions as `--add ROLE=FILE` gives them: each role's text, read from its file.
 * A word without `=`, or a file that can't be read, ends the command.
 */
function additionsFromFlags(adds: readonly string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of adds ?? []) {
    const at = a.indexOf("=");
    if (at < 1) fail(`--add takes ROLE=FILE, such as worker=worker-notes.md: not ${a}`);
    const role = a.slice(0, at);
    const file = a.slice(at + 1);
    try {
      out[role] = readFileSync(file, "utf8");
    } catch (err) {
      fail(`--add ${role}: ${file} can't be read: ${errorText(err)}`);
    }
  }
  return out;
}

/** thermite campaign copy, context and additions. */
export async function thermiteCampaign(rest: string[]): Promise<void> {
  // The owner's additions to a campaign's roles (goal 166), through POST
  // /v1/campaigns/<name>/additions.
  if (rest[0] === "additions") {
    const [, campaign, ...args] = rest;
    if (!campaign || campaign.startsWith("-")) fail(USAGE);
    const { values } = parseArgs({
      args,
      options: {
        control: { type: "string" },
        "token-file": { type: "string" },
        add: { type: "string", multiple: true },
      },
    });
    if (!values.control || !values["token-file"])
      fail("give --control and --token-file: control keeps the campaign");
    const out = await orFail(
      controlAt(values.control, values["token-file"]).call(CAMPAIGN_ADDITIONS, {
        params: { campaign },
        body: { additions: additionsFromFlags(values.add) },
      }),
    );
    process.stdout.write(`${JSON.stringify(out)}\n`);
    if (out.said) process.stderr.write(`${out.said}\n`);
    return;
  }
  // A campaign's own context settings (goal 070), through POST /v1/campaigns/<name>/context.
  if (rest[0] === "context") {
    const [, campaign, ...args] = rest;
    if (!campaign || campaign.startsWith("-")) fail(USAGE);
    const { values } = parseArgs({
      args,
      options: {
        control: { type: "string" },
        "token-file": { type: "string" },
        "context-window": { type: "string" },
        "compact-at": { type: "string" },
      },
    });
    if (!values.control || !values["token-file"])
      fail("give --control and --token-file: control keeps the campaign");
    const out = await orFail(
      controlAt(values.control, values["token-file"]).call(CAMPAIGN_CONTEXT, {
        params: { campaign },
        body: contextFromFlags(values) ?? {},
      }),
    );
    process.stdout.write(`${JSON.stringify(out)}\n`);
    if (out.said) process.stderr.write(`${out.said}\n`);
    return;
  }
  // Copy a campaign control keeps (goal 069), through POST /v1/campaigns/<from>/copy.
  const [sub, from, name, ...args] = rest;
  if (sub !== "copy" || !from || !name || from.startsWith("-") || name.startsWith("-")) fail(USAGE);
  const { values } = parseArgs({
    args,
    options: {
      control: { type: "string" },
      "token-file": { type: "string" },
      "mcp-servers-json": { type: "string" },
      "context-window": { type: "string" },
      "compact-at": { type: "string" },
      "info-file": { type: "string" },
      link: { type: "string", multiple: true },
      idea: { type: "string", multiple: true },
      hypothesis: { type: "string", multiple: true },
    },
  });
  if (!values.control || !values["token-file"])
    fail("give --control and --token-file: control copies the campaign");
  // The copy's own context settings, in place of its source's (goal 070).
  const ownContext = contextFromFlags(values);
  // A research copy's MCP servers, as a JSON list in a file; control checks it.
  let mcpServers: unknown;
  const mcpFile = values["mcp-servers-json"];
  if (mcpFile !== undefined) {
    try {
      mcpServers = JSON.parse(readFileSync(mcpFile, "utf8"));
    } catch (err) {
      fail(`--mcp-servers-json: ${mcpFile} is not a JSON list: ${errorText(err)}`);
    }
  }
  const out = await orFail(
    controlAt(values.control, values["token-file"]).call(CAMPAIGN_COPY, {
      params: { campaign: from },
      body: {
        name,
        ...(mcpFile !== undefined ? { mcp_servers: mcpServers } : {}),
        ...(ownContext ? { agents_context: ownContext } : {}),
        // The copy's own brief (goal 078), each part in place of FROM's.
        ...briefFromFlags(values),
      },
    }),
  );
  process.stdout.write(`${JSON.stringify(out)}\n`);
}
