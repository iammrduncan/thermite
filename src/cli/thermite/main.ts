#!/usr/bin/env node
import { errorText } from "../../common/errors.ts";
import { thermiteAgents } from "./agents.ts";
import { thermiteBackup, thermiteRestore } from "./backup.ts";
import { thermiteCampaign, thermiteRun } from "./campaigns.ts";
import { thermiteInvalidate } from "./evidence.ts";
import { thermiteAssign, thermiteAssignPayload, thermiteCommand } from "./issue.ts";
import { thermiteKb } from "./kb.ts";
import { thermiteKit } from "./kits.ts";
import {
  thermiteContract,
  thermiteDoctor,
  thermiteKeys,
  thermiteLocal,
  thermiteSelftest,
  thermiteToken,
} from "./local.ts";
import { thermiteMcp } from "./mcp.ts";
import { thermiteStatus, thermiteSubmit } from "./proposer.ts";
import { thermiteRig } from "./rigs.ts";
import { thermiteRunpod } from "./runpod.ts";
import { fail } from "./shared.ts";
import { USAGE } from "./usage.ts";

/**
 * The thermite command line: the machine's checks, contract checks, key generation, issuing
 * commands through control, the scripted proposer's submit/status calls against a harness, and
 * control's backup and restore.
 * Each command is a function in a module of thermite/, and the usage text is thermite/usage.ts.
 */

export { formatMcpServers } from "./mcp.ts";

async function main(argv: string[]): Promise<void> {
  // --instance and --unit are the flags' names before the 2026-10-15 rename: still read.
  const [cmd, ...rest] = argv.map((a) =>
    a.replace(/^--instance(?==|$)/, "--run").replace(/^--unit(?==|$)/, "--rig"),
  );
  switch (cmd) {
    case "doctor":
      return thermiteDoctor(rest);
    case "contract":
      return thermiteContract(rest);
    case "keys":
      return thermiteKeys(rest);
    case "token":
      return thermiteToken(rest);
    case "assign-payload":
      return thermiteAssignPayload(rest);
    case "assign":
      return thermiteAssign(rest);
    case "rig":
      return thermiteRig(rest);
    case "runpod":
      return thermiteRunpod(rest);
    case "run":
      return thermiteRun(rest);
    case "campaign":
      return thermiteCampaign(rest);
    case "kit":
      return thermiteKit(rest);
    case "kb":
      return thermiteKb(rest);
    case "agents":
      return thermiteAgents(rest);
    case "mcp":
      return thermiteMcp(rest);
    case "command":
      return thermiteCommand(rest);
    case "invalidate":
      return thermiteInvalidate(rest);
    case "submit":
      return thermiteSubmit(rest);
    case "status":
      return thermiteStatus(rest);
    case "local":
      return thermiteLocal(rest);
    case "selftest":
      return thermiteSelftest(rest);
    case "backup":
      return thermiteBackup(rest);
    case "restore":
      return thermiteRestore(rest);
    default:
      process.stdout.write(USAGE);
      if (cmd && cmd !== "help" && cmd !== "--help") process.exit(2);
  }
}

main(process.argv.slice(2)).catch((err) => fail(errorText(err)));
