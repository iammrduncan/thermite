import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROLES } from "../../../src/agents/roles/index.ts";
import { partText } from "../../../src/core/prompts.ts";
import { createHarnessApi } from "../../../src/harness/api/index.ts";
import type { Ledger } from "../../../src/harness/ledger/index.ts";
import { AdvisorsConfig } from "../../../src/supervisor/advisors/index.ts";
import { adviseOnce, emptyAdviseState } from "../../../src/supervisor/advisors/pass/index.ts";
import { type Script, startFakeModel } from "../../helpers/fake-model.ts";

/**
 * Every role's whole prompt today, for a sample run (goal 166): what the role's model is sent,
 * captured where it is sent, so the roles' code can move and change without changing a prompt by
 * accident. Each golden file holds a role's system text, its first message and its tools' names
 * (in another program: its command and its standard input), with what differs between runs (ids,
 * commits, times, paths, ports) written as placeholders. Rewrite them with
 * `UPDATE_GOLDEN=1 node scripts/test.mjs tests/agents/prompts/*.test.ts`, and read the diff.
 */

export const GOLDEN = fileURLToPath(new URL("../golden/prompts/", import.meta.url));
export const UPDATE = process.env.UPDATE_GOLDEN === "1";

export const laneTool = [
  process.execPath,
  "--experimental-strip-types",
  "--disable-warning=ExperimentalWarning",
  fileURLToPath(new URL("../../../src/harness/agents/lanetool.ts", import.meta.url)),
];

/** What one request sent: the system text, the first message, the tools' names. */
export interface Sent {
  system: string;
  first: string;
  tools: string[];
}

export const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p) => (p as { text?: string }).text ?? "").join("")
      : JSON.stringify(content);

/** The role whose fixed text a system text starts with (src/agents/roles). */
export function roleOf(system: string): string {
  const role = ROLES.find((r) =>
    r.texts.some((t) => t.text.length >= 80 && system.startsWith(t.text.slice(0, 80))),
  );
  return role?.id ?? `unknown: ${system.slice(0, 60)}`;
}

/** The first request of each role, by the role's id; `answer` replies to every request. */
export function recorder(answer: Script) {
  const sent = new Map<string, Sent>();
  const script: Script = (req) => {
    const system = text(req.messages.find((m) => m.role === "system")?.content);
    const role = roleOf(system);
    if (!sent.has(role))
      sent.set(role, {
        system,
        first: text(req.messages.find((m) => m.role === "user")?.content),
        tools: req.tools.map((t) => t.function.name),
      });
    return answer(req);
  };
  return { sent, script };
}

/** A run's own values as placeholders, so a golden is the same on every run and machine. */
export function normal(s: string, paths: string[]): string {
  let out = s;
  for (const p of paths.filter(Boolean).sort((a, b) => b.length - a.length))
    out = out.split(p).join("<path>");
  return (
    out
      .replace(/\b[0-9a-f]{40}\b/g, "<commit>")
      .replace(/\b[0-9a-f]{64}\b/g, "<sha256>")
      .replace(/\b([a-z]{1,2})-[0-9a-f]{8,16}\b/g, "<$1-id>")
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?Z/g, "<time>")
      .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>")
      .replace(/\b\d+\.\d\d h elapsed/g, "<hours> h elapsed")
      // What the judge measured varies with the machine's load: its gains, deltas and intervals.
      .replace(/-?\b\d+\.\d{4,}(e-?\d+)?/g, "<measured>")
      .replace(/gain -?\d+(\.\d+)?% above/g, "gain <measured>% above")
  );
}

/** Holds `sent` to its golden file, or writes the file under UPDATE_GOLDEN=1. */
export function golden(name: string, sent: Sent | undefined, paths: string[]): void {
  assert.ok(sent, `${name}: no request was sent`);
  sections(name, paths, [
    ["system", sent.system],
    ["first message", sent.first],
    ["tools", sent.tools.join(", ") || "(none)"],
  ]);
}

/** Holds labelled sections to the golden file `name`; the home folder is a path like the rest. */
export function sections(name: string, paths: string[], parts: [string, string][]): void {
  const body = `${parts.map(([label, t]) => `# ${label}\n${normal(t, [...paths, homedir()])}`).join("\n")}\n`;
  const file = join(GOLDEN, `${name}.txt`);
  if (UPDATE) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, body);
    return;
  }
  assert.equal(body, readFileSync(file, "utf8"), `${name}: the prompt changed; see the diff`);
}

/** A teacher reads its brief, then answers; the merged by model answers at once. */
export const teachersScript: Script = ({ messages }) => {
  const system = text(messages.find((m) => m.role === "system")?.content);
  if (roleOf(system).endsWith("merged-by"))
    return {
      toolCalls: [
        {
          name: "answer",
          args: {
            directives: [{ kind: "try", family: "loops", rationale: "both", citations: ["a"] }],
            experiments: [],
          },
        },
      ],
    };
  if (!messages.some((m) => m.role === "tool")) return { toolCalls: [{ name: "brief", args: {} }] };
  return {
    toolCalls: [
      {
        name: "answer",
        args: {
          summary: "the loop does wasted work",
          recommendations: [{ kind: "try", family: "loops", rationale: "r", citations: ["a"] }],
        },
      },
    ],
  };
};

/** The hill climb's planner's plan: one lane, on a new direction. */
export const PLAN = {
  toolCalls: [
    {
      name: "submit_plan",
      args: {
        new_families: [{ id: "loops", description: "simplify the inner loop" }],
        assignments: [
          { lane: "lane-1", family: "loops", focus: "remove wasted work", parent: "champion" },
        ],
      },
    },
  ],
};

/**
 * One round of the supervisor's advisors against `env`'s harness, as on a rig, with each advisor
 * a Pi runtime on a fake model that `script` plays. Returns the folder of the runtimes' key file.
 */
export async function adviseRound(
  env: { service: Parameters<typeof createHarnessApi>[0] },
  script: Script,
  roles: (runtime: (name: string) => Record<string, unknown>) => Record<string, unknown>,
): Promise<string> {
  const fake = await startFakeModel(script);
  const keys = mkdtempSync(join(tmpdir(), "thermite-prompts-"));
  writeFileSync(join(keys, "key"), "test-key\n");
  const runtime = (name: string) => ({
    name,
    runtime: "openai",
    base_url: fake.url,
    model: name,
    api_key_file: join(keys, "key"),
  });
  const tokens = { supervisor: "sup-token" };
  const api = createHarnessApi(env.service, tokens);
  await adviseOnce(
    {
      harnessUrl: "http://harness",
      harnessToken: tokens.supervisor,
      home: mkdtempSync(join(tmpdir(), "thermite-prompts-sup-")),
      advisors: AdvisorsConfig.parse(roles(runtime)),
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        return await api.request(`${url.pathname}${url.search}`, init as RequestInit);
      },
      // Thermite's knowledge base, as the advisors reach it (goal 175): asked of no control here,
      // since only what the advisors are sent is captured.
      kb: {
        rig: "rig-a",
        bus: {
          request: async () => {
            throw new Error("no control here");
          },
        },
      },
    },
    emptyAdviseState(),
  );
  await fake.close();
  return keys;
}

/** Every prompt a ledger keeps, whole, of one role. */
function keptOf(ledger: Ledger, role: string) {
  return ledger.runs
    .list()
    .flatMap((r) => ledger.prompts.list(r.id))
    .filter((p) => p.role === role)
    .map((p) => ledger.prompts.get(p.id))
    .filter((p) => p !== undefined);
}

/**
 * Holds that what a role's model was sent is, byte for byte, a prompt its role's definition
 * rendered and the harness kept (goal 166): text built outside a definition would differ from the
 * record, which is made only from what the role's render function gave.
 */
export function kept(ledger: Ledger, role: string, sent: Sent | undefined): void {
  assert.ok(sent, `${role}: no request was sent`);
  const records = keptOf(ledger, role);
  assert.ok(records.length, `${role}: no prompt was kept`);
  assert.ok(
    records.some(
      (r) =>
        partText(r.sections, "system") === sent.system &&
        partText(r.sections, "message") === sent.first,
    ),
    `${role}: what was sent is not the prompt kept`,
  );
}

/** The same for a program, which gets its whole prompt on its standard input. */
export function keptInput(ledger: Ledger, role: string, input: string): void {
  const records = keptOf(ledger, role);
  assert.ok(
    records.some(
      (r) => !partText(r.sections, "system") && partText(r.sections, "message") === input,
    ),
    `${role}: what the program was given is not the prompt kept`,
  );
}
