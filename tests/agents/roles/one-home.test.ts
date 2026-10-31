import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as roles from "../../../src/agents/roles/index.ts";

/**
 * Every prompt Thermite sends comes from a role's definition (goal 166): a call's first message
 * and each later turn in it (a nudge, a warning, a continuation). A send site takes a Prompt, and
 * only `prompt` in src/agents/prompt.ts makes one: its type cannot be written by hand. This test
 * reads every production file and fails when a prompt could be built outside a definition: a file
 * outside src/agents/roles/ that imports the prompt's makers, casts a value to a Prompt, takes a
 * role's text from the roles rather than its render functions, holds a role's text of its own, or
 * sends a Pi agent text that is no Prompt's. The golden tests (tests/agents/prompts/) then hold
 * what each render gives, as the model receives it.
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
const ROLES_DIR = join(root, "src/agents/roles");
const PROMPT = join(root, "src/agents/prompt.ts");

/** What the rest of the code may take from src/agents/prompt.ts: its types and its readers. */
const PROMPT_READERS = new Set([
  "Prompt",
  "Section",
  "Source",
  "messageText",
  "promptRecord",
  "sectionsText",
  "systemText",
  "userMessage",
]);

/**
 * What the rest of the code may take from the roles: their render functions, their table, the
 * limits that code checks the answers against (the prompt states the same constants), the rule
 * that fits a first message to a model's window, and the words a trial's clock adds to a tool's
 * result near the trial's end (the worker's warning says them too).
 */
const FROM_ROLES =
  /^(render[A-Z]\w*|ROLES|roleOf|PLAN_LIMITS|RESEARCH_PLAN_LIMITS|PROMOTE_PER_ROUND|windowFit|timeLeftWords)$/;

/** A role's fixed texts long enough that a copy elsewhere is no accident. */
const OWN_TEXTS = roles.ROLES.flatMap((r) =>
  r.texts
    .filter((t) => t.text.length >= 25 && !t.text.includes("<"))
    .map((t) => [r.id, t] as const),
);

/**
 * A Pi agent's sends whose text is no Prompt's: `agent.prompt`, `agent.steer` or
 * `agent.followUp` given anything but messageText(…), userMessage(…) or a name the file sets
 * from userMessage(…).
 */
function sends(name: string, src: string): string[] {
  const fromPrompt = [...src.matchAll(/const (\w+) = userMessage\(/g)].map((m) => m[1]);
  const found: string[] = [];
  for (const m of src.matchAll(/\bagent\.(prompt|steer|followUp)\(\s*/g)) {
    const arg = src.slice((m.index ?? 0) + m[0].length);
    const ok =
      /^(messageText|userMessage)\(/.test(arg) || fromPrompt.some((v) => arg.startsWith(`${v})`));
    if (!ok) found.push(`${name}: sends agent.${m[1]} text that is no role's prompt`);
  }
  return found;
}

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );

/** Each import of a file: the module it names, resolved, and the names it takes as values. */
function imports(file: string, src: string): { from: string; names: string[] }[] {
  const out: { from: string; names: string[] }[] = [];
  for (const m of src.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g)) {
    if (m[1] || !m[3]?.startsWith(".")) continue;
    const names = (m[2] ?? "")
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n && !n.startsWith("type "))
      .map((n) => n.split(/\s+as\s+/)[0] as string);
    out.push({ from: resolve(dirname(file), m[3]), names });
  }
  return out;
}

/** How a production file could build a prompt outside a definition, in words; none: []. */
function problems(file: string, src: string): string[] {
  const name = relative(root, file);
  const found: string[] = [];
  if (/\bas\s+(unknown\s+as\s+)?Prompt\b/.test(src))
    found.push(`${name}: casts a value to a Prompt`);
  for (const [role, t] of OWN_TEXTS)
    if (src.includes(t.text)) found.push(`${name}: holds the ${role}'s ${t.id} text`);
  found.push(...sends(name, src));
  for (const i of imports(file, src)) {
    if (i.from === PROMPT)
      for (const n of i.names.filter((n) => !PROMPT_READERS.has(n)))
        found.push(`${name}: takes ${n} from the prompt's makers`);
    if (i.from.startsWith(`${ROLES_DIR}/`))
      for (const n of i.names.filter((n) => !FROM_ROLES.test(n)))
        found.push(`${name}: takes ${n} from the roles, not a render function`);
  }
  return found;
}

test("every role's prompt is put together by one render function, named in the table, and its later turns by the ones named there", () => {
  for (const r of roles.ROLES) {
    for (const f of [r.render, ...r.turns]) {
      assert.equal(typeof f, "function", r.id);
      assert.equal(
        (roles as Record<string, unknown>)[f.name],
        f,
        `${r.id}: ${f.name} is not exported by the roles`,
      );
    }
  }
});

test("no prompt is built outside a role's definition", () => {
  const outside = files(join(root, "src")).filter(
    (f) => !f.startsWith(`${ROLES_DIR}/`) && f !== PROMPT,
  );
  assert.ok(outside.length > 100);
  assert.deepEqual(
    outside.flatMap((f) => problems(f, readFileSync(f, "utf8"))),
    [],
  );
});

test("the check finds a prompt built outside a definition", () => {
  // A send site in the harness that made its own text, as the check reads it.
  const file = join(root, "src/harness/agents/worker/index.ts");
  const src = [
    'import { messageText, prompt, type Prompt, section } from "../../../agents/prompt.ts";',
    'import { renderWorker, WORKER_PI_SYSTEM } from "../../../agents/roles/index.ts";',
    "const p = { role: 'worker' } as unknown as Prompt;",
  ].join("\n");
  assert.deepEqual(problems(file, src), [
    "src/harness/agents/worker/index.ts: casts a value to a Prompt",
    "src/harness/agents/worker/index.ts: takes prompt from the prompt's makers",
    "src/harness/agents/worker/index.ts: takes section from the prompt's makers",
    "src/harness/agents/worker/index.ts: takes WORKER_PI_SYSTEM from the roles, not a render function",
  ]);
});

test("the check finds a later turn sent outside a definition", () => {
  // A trial that tells its worker to go on in its own words, and one that sends its role's.
  const file = join(root, "src/harness/agents/worker/index.ts");
  const nudge = roles.ROLES.find((r) => r.id === "worker")?.texts.find((t) => t.id === "nudge-pi");
  assert.ok(nudge);
  const src = [
    `const NUDGE = ${JSON.stringify(nudge.text)};`,
    "await agent.prompt(NUDGE);",
    'agent.steer({ role: "user", content: "Hurry.", timestamp: Date.now() });',
    "agent.followUp(left + ' turns are left.');",
    'await agent.prompt(messageText(renderWorkerTurn({ program: "pi", turn: 3, kind: "nudge" })));',
    "const message = userMessage(p);",
    "agent.steer(message);",
  ].join("\n");
  assert.deepEqual(problems(file, src), [
    "src/harness/agents/worker/index.ts: holds the worker's nudge-pi text",
    "src/harness/agents/worker/index.ts: sends agent.prompt text that is no role's prompt",
    "src/harness/agents/worker/index.ts: sends agent.steer text that is no role's prompt",
    "src/harness/agents/worker/index.ts: sends agent.followUp text that is no role's prompt",
  ]);
});
