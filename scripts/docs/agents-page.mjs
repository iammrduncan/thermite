#!/usr/bin/env node
// The documentation site's Agent roles page is written from src/agents/roles/index.ts, the one
// table of Thermite's agent roles and their fixed texts (goal 166). `npm run docs:agents` writes
// it; `npm run docs:check` fails when the two differ. Run with --experimental-strip-types.
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const agentsPageFile = join(root, "docs/_site/src/content/docs/reference/agent-roles.md");
const rolesModule = pathToFileURL(join(root, "src/agents/roles/index.ts")).href;
const additionsModule = pathToFileURL(join(root, "src/core/role-additions.ts")).href;

const FRONT = `---
title: "Agent roles"
description: "Every agent role Thermite runs: what it does, where it runs, its model and programs, whether your messages reach it, and its fixed instructions, word for word."
type: reference
sidebar:
  order: 4
---
`;

const NOTE =
  "<!-- Written from src/agents/roles/ by `npm run docs:agents`: change the role's module, not this page. -->\n";

const INTRO = `Thermite runs 15 agent roles. Each role's fixed instructions are in its own module in \`src/agents/roles/\`, and \`src/agents/roles/index.ts\` lists every role in one table. This page is written from that table, so the texts below are the ones the code sends, word for word.

A run adds to these texts each time it calls a role: the campaign's brief, the run's rules and queue, field notes, past research and your messages. One function in the role's module puts them together for a run, named under each role below, and the role's turn functions put together what it is told later in the same call (see [Later turns in a call](#later-turns-in-a-call)); the harness and the supervisor gather what the run adds and send what those functions render, and no prompt is built anywhere else. Every prompt sent is kept with its run: a run's **Prompts** tab on the dashboard shows each one, with where each part came from, and so do \`GET /v1/runs/{run}/prompts\`, the \`agent_prompts\` MCP tool and \`thermite agents show ROLE --run RUN\` (see [What a run's agents were sent](#what-a-runs-agents-were-sent)). Every role advises or proposes; none of them measures, judges or promotes (see [Why agents never judge](../explanation/why-agents-never-judge.md)).

| Role | What it does | Runs in | Model | Programs | Your messages reach it | Takes your additions |
| --- | --- | --- | --- | --- | --- | --- |
`;

const SENT = `## What a run's agents were sent

Each prompt is kept whole, compressed, in the rig's ledger and in the run's export (\`prompts.jsonl.gz\`), never in the run's research folder, which the workers read: a call's first message and each later turn in it (below). Control gets an \`agent_prompt\` event for each one: its role, agent program, lane and trial or call, which turn of the call it was (\`turn\`: 0 for the first message, 1 for the first later turn, and so on), the version of the role's text, and each section with its source and size. The event carries the text of each section up to 8,000 characters of the prompt in all; a section past that says it is cut. Only the owner's and the operator's tokens read that text: in \`recent_events\` and in \`get_run\`'s timeline, the agent's and the reader's tokens get each section's source, part and size, without its text. A fixed text of a role, listed below, is named by its SHA-256, and control shows it from its own copy of the definitions.

Each section's source says where it comes from: \`role\` (the role's own text), \`assignment\`, \`contract\`, \`campaign brief\`, \`queue\`, \`planner\`, \`judge\`, \`ledger\` (the run's record), \`field notes and past research\`, \`owner\` (your messages), \`owner's addition\` (your addition to the role for the campaign, below), \`kit\` (its MCP servers), \`rig\` (the rig's and the lane's limits), \`package\` (what an advisor reads), \`check\` (what code found wrong with a planner's last answer), \`provider\` (a model provider's words when a call failed), \`compaction\` (the summary an agent's own model wrote of its conversation) and \`left out\`.

A worker's or a planner's first message is cut to fit its model's window, by the advisors' rule: the window at its compaction point less 30%. Your messages and the role's own text stay whole; the largest of the run's parts are cut first, and the message says what was cut and where the rest is. Without a known window, nothing is cut.

The agent programs read no instructions of their own from the project: Claude Code reads no \`CLAUDE.md\`, Codex no \`AGENTS.md\`, and OpenCode no \`AGENTS.md\` and no configuration of the project's (Thermite starts it with \`OPENCODE_DISABLE_PROJECT_CONFIG=1\`). One thing OpenCode does that no setting turns off: when its agent reads a file with OpenCode's own read tool in a folder below the workspace's top, OpenCode adds an \`AGENTS.md\` it finds in that folder, or in one between it and the top, to the conversation.

## Later turns in a call

After its first message, an agent may be told more in the same call, and each of those texts comes from its role too:

- a worker that stops without submitting is told to go on, for as long as it keeps working (in Pi, and in OpenCode, Claude Code or Codex, where the program's session is continued); a research worker in OpenCode whose run made progress and ended while your messages wait is told to continue its research;
- a worker in Pi is told once that its trial's turns or time are nearly spent, when a limit on them is set;
- in Pi, a reply cut off at the output limit, a full context the harness compacted, and a failed model call (in a program too) each get a line, and the trial goes on;
- your message to a running trial: in Pi as a turn of its own, in a program with the run's continuation;
- in Pi, after a compaction, every agent goes on from one message that says where the conversation is kept and gives the summary, in its own role's words: a worker's, a planner's or an advisor's.

Each one is kept as the first message is, as a later turn of its call: \`renderWorkerTurn\`, \`renderResearchWorkerTurn\` and \`renderCompacted\` put them together, and the roles below list their fixed texts.

## Your additions to a role

You can add your own words to a role for one campaign, with no change to Thermite's code: the contract's [\`role_additions\`](contract.md#your-additions-to-the-agents-roles), one text for each role by its id (the last column above says which roles take one). Set them on **New campaign**, on the campaign's page under **Your additions to the agents' roles**, with \`POST /v1/campaigns/{campaign}/additions\`, the \`set_campaign_additions\` MCP tool or \`thermite campaign additions\`; each saves a new version of the contract, signed into every assignment. With the operator's token, the MCP tool proposes the change instead, and it takes effect only once you approve it on the campaign's page ([What the operator proposes](../how-to/campaigns/start-from-dashboard.md#what-the-operator-proposes)).

Each prompt of the role then carries its addition as a section of its own, after the role's own text: in Pi at the end of the system text, in another program after the role's instructions. Its source is \`owner's addition\`, and it starts with \`# The campaign owner's addition (contract version N)\` and a line that says it adds to the role's instructions and replaces none of them, which come first where the two differ. It never replaces a role's text, and it never decides a measurement, a verdict or a promotion. It is never cut to fit a model's window.`;

const cell = (s) => s.replace(/\|/g, "\\|");
const anchor = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .trim()
    .replace(/ +/g, "-");

/** The page that the table of roles makes. */
export async function agentsPage() {
  const { ROLES } = await import(rolesModule);
  const { ALL_ADDITION_ROLES } = await import(additionsModule);
  const rows = ROLES.map(
    (r) =>
      `| [${cell(r.name)}](#${anchor(r.name)}) | ${cell(r.what)} | ${r.runsIn} | ${cell(r.model)} | ${r.programs.join(", ")} | ${r.messages ? "Yes" : "No"} | ${ALL_ADDITION_ROLES.includes(r.id) ? "Yes" : "No"} |`,
  ).join("\n");
  const sections = ROLES.map((r) => {
    const texts = r.texts
      .map((x) => {
        if (x.text.includes("```")) throw new Error(`${r.id}/${x.id}: a text holds a code fence`);
        return `### ${r.name}: ${x.what}\n\n\`\`\`text\n${x.text}\n\`\`\``;
      })
      .join("\n\n");
    const turns = r.turns.length
      ? ` Its later turns in a call are put together by ${r.turns.map((f) => `\`${f.name}\``).join(" and ")}.`
      : "";
    return `## ${r.name}\n\n${r.what} Its module: \`src/agents/roles/\`, role \`${r.id}\`. Its prompt for a run is put together by \`${r.render.name}\`.${turns}\n\n${texts}`;
  }).join("\n\n");
  return `${FRONT}\n${NOTE}\n${INTRO}${rows}\n\n${SENT}\n\n${sections}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(agentsPageFile, await agentsPage());
  console.log(`${agentsPageFile}: written from src/agents/roles/`);
}
