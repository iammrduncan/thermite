#!/usr/bin/env node
// Checks the documentation site (docs/_site) for what its build cannot see:
//   - each page's front matter, and that it sits in the section of its Diátaxis type;
//   - relative links between pages, and their #anchors;
//   - every `thermite` command and option a page shows exists in the command line;
//   - every setting a page names exists in the code, and every setting the code reads is in the
//     settings reference;
//   - every contract, kit.json and advisors.json example parses with the real schema;
//   - no page names an agent by an old name (goal 074): "teacher pair", "combiner", "panelist",
//     "the supervisor's advisors", or "panel" alone for the review panel, outside code;
//   - the Credits page is CREDITS.md, as `npm run docs:credits` writes it;
//   - the Agent roles page is src/agents/roles/, as `npm run docs:agents` writes it;
//   - after `npm run docs:build`: llms.txt lists every page, llms-full.txt holds every page, and
//     every page has its Markdown copy.
// Usage: node --experimental-strip-types scripts/docs/check.mjs [--allow-stubs] [--no-build]
// (`npm run docs:check`). It exits 1 and lists each problem when anything fails.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { agentsPage, agentsPageFile } from "./agents-page.mjs";
import { creditsFile, creditsPage, creditsPageFile } from "./credits-page.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const docsRoot = join(root, "docs/_site/src/content/docs");
const siteOut = join(root, ".dev/site");
const allowStubs = process.argv.includes("--allow-stubs");
const checkBuild = !process.argv.includes("--no-build");

const problems = [];
const problem = (file, message) => problems.push(`${relative(root, file)}: ${message}`);

/** Every file under `dir` whose name matches `pattern`. */
function walk(dir, pattern, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, pattern, out);
    else if (pattern.test(entry.name)) out.push(path);
  }
  return out;
}

// --- Pages and front matter -------------------------------------------------------------------

const typeOfSection = {
  tutorials: "tutorial",
  "how-to": "how-to",
  reference: "reference",
  explanation: "explanation",
  project: "project",
};

function frontMatter(text) {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!block) return null;
  const field = (name) => {
    const line = new RegExp(`^${name}:[ \\t]*(.*)$`, "m").exec(block[1])?.[1]?.trim();
    if (line === undefined) return undefined;
    if (line.startsWith('"')) return JSON.parse(line);
    if (line.startsWith("'")) return line.slice(1, -1).replaceAll("''", "'");
    return line;
  };
  // A splash page's hero title (an indented `title:` under `hero:`) is its heading in llms-full.txt.
  const hero = /^hero:\n(?:[ \t]+.*\n)*?[ \t]+title:[ \t]*(.*)$/m.exec(block[1])?.[1]?.trim();
  return {
    title: field("title"),
    heroTitle: hero?.startsWith('"') ? JSON.parse(hero) : hero,
    description: field("description"),
    type: field("type"),
    body: text.slice(block[0].length),
  };
}

// A placeholder such as <campaign> outside code is read as an HTML tag, and the site hides it.
const htmlTags =
  /^<\/?(a|b|br|code|details|div|em|i|img|kbd|li|ol|p|span|strong|sub|summary|sup|table|td|th|tr|ul|Aside|Card|CardGrid|HowItWorks|LinkButton|LinkCard|Steps|TabItem|Tabs)\b/;
function placeholders(body) {
  const prose = body.replace(/```[\s\S]*?```/g, "").replace(/``[^`]*``|`[^`\n]*`/g, "");
  return [...prose.matchAll(/<\/?[A-Za-z][\w-]*(?:\s[^>\n]*)?>/g)]
    .map((m) => m[0])
    .filter((tag) => !htmlTags.test(tag));
}

const pages = walk(docsRoot, /\.mdx?$/)
  .map((file) => {
    const slug = relative(docsRoot, file)
      .split(sep)
      .join("/")
      .replace(/\.mdx?$/, "");
    return { file, slug, text: readFileSync(file, "utf8") };
  })
  .filter((page) => page.slug !== "404");

for (const page of pages) {
  const fm = frontMatter(page.text);
  if (!fm) {
    problem(page.file, "no front matter");
    continue;
  }
  Object.assign(page, fm);
  if (!page.title) problem(page.file, "no title");
  if (!page.description || page.description.length < 20)
    problem(page.file, "no one-line description (at least 20 characters, on one line)");
  const section = page.slug.split("/")[0] ?? "";
  const expected = typeOfSection[section] ?? "hub";
  if (page.type !== expected)
    problem(page.file, `type is "${page.type}", but pages in this section are "${expected}"`);
  if (/^#\s/m.test(page.body.replace(/```[\s\S]*?```/g, "")))
    problem(page.file, "a level-1 heading in the body; the title comes from the front matter");
  if (/:::note\[Being written\]/.test(page.body) && !allowStubs) problem(page.file, "still a stub");
  for (const tag of new Set(placeholders(page.body)))
    problem(
      page.file,
      `${tag} outside code is read as an HTML tag and hidden; put it in backticks`,
    );
}

// --- The agents' names ------------------------------------------------------------------------

// Goal 074: one name for each agent. The work: Workers, Planner. The advisors: Teachers (one or
// two, with a merged by model for two), Auditor, Review panel. The old names stay out of the
// pages' prose; in code (`combiner`, `panel`) a page may say what v0.1.0 took.
const OLD_NAMES = [
  [/\bteacher pairs?\b/gi, 'the teachers ("teacher pair" is an old name)'],
  [/\bcombiners?\b/gi, `the teachers' merged by model ("combiner" is an old name)`],
  [/\bpanelists?\b/gi, 'a reviewer of the review panel ("panelist" is an old name)'],
  [/\bsupervisor's advisors\b/gi, `the advisors ("the supervisor's advisors" is an old name)`],
];
// "Panel" alone is also the Start a run and Copy panels: it is the review panel's old name only in
// a sentence about the advisors that names no panel of the dashboard.
const ADVISOR_WORDS =
  /\b(review|reviews|reviewers?|auditor|teachers?|advisors?|pass|passes|passed|verdicts?)\b/i;
const DRAWER_WORDS = /Start a run|\bCopy\b|\bcopy\b|start_run|drawer|\bopens?\b|\bopened\b/;
function oldNames(body) {
  const prose = body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/``[^`]*``|`[^`\n]*`/g, "``")
    .replace(/\]\([^)\s]*\)/g, "]()");
  const found = [];
  const near = (i) => prose.slice(Math.max(0, i - 40), i + 60).replace(/\s+/g, " ");
  for (const [pattern, use] of OLD_NAMES)
    for (const m of prose.matchAll(pattern))
      found.push(`"${m[0]}" outside code: write ${use} (in: …${near(m.index)}…)`);
  for (const sentence of prose.split(/(?<=[.!?:;|])\s+|\n/)) {
    const lone = /(?<!\breview )\bpanel(?:s|'s)?\b/i.exec(sentence);
    if (lone && ADVISOR_WORDS.test(sentence) && !DRAWER_WORDS.test(sentence))
      found.push(
        `"${lone[0]}" names the review panel by an old name: write "the review panel" (in: ${sentence.trim().slice(0, 100)})`,
      );
  }
  return found;
}
for (const page of pages) {
  if (!page.body) continue;
  for (const found of oldNames(`${page.title ?? ""}\n${page.description ?? ""}\n${page.body}`))
    problem(page.file, found);
}

// --- Links and anchors ------------------------------------------------------------------------

/** GitHub's and Starlight's heading ids (github-slugger). */
function slugger() {
  const seen = new Map();
  return (heading) => {
    const base = heading
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
      .replace(/ /g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}

function headingText(markdown) {
  return (
    markdown
      .replace(/`([^`]*)`/g, "$1")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Emphasis marks go; underscores inside words stay, as in Starlight's and GitHub's ids.
      .replace(/\*+/g, "")
      .replace(/(^|\s)_+|_+(\s|$)/g, "$1$2")
      .trim()
  );
}

const anchorsCache = new Map();
function anchorsOf(file) {
  if (!anchorsCache.has(file)) {
    const body = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
    const slug = slugger();
    const ids = new Set();
    for (const match of body.matchAll(/^#{2,6}\s+(.+?)\s*#*\s*$/gm))
      ids.add(slug(headingText(match[1] ?? "")));
    anchorsCache.set(file, ids);
  }
  return anchorsCache.get(file);
}

const linkPattern = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
for (const page of pages) {
  const prose = (page.body ?? "").replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  for (const match of prose.matchAll(linkPattern)) {
    const url = match[1] ?? "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("/")) continue;
    const [path, hash] = url.split("#");
    const target = path ? resolve(dirname(page.file), path) : page.file;
    if (!target.startsWith(join(root, "docs/_site/src"))) {
      problem(page.file, `link ${url} leaves the site; link to the file on GitHub instead`);
      continue;
    }
    if (!existsSync(target)) {
      problem(page.file, `link ${url}: no such file`);
      continue;
    }
    if (hash && /\.mdx?$/.test(target) && !anchorsOf(target).has(hash))
      problem(page.file, `link ${url}: no heading with the id "${hash}"`);
  }
}

// --- Code blocks ------------------------------------------------------------------------------

function codeBlocks(text) {
  const blocks = [];
  for (const match of text.matchAll(/^([ \t]*)```([^\n]*)\n([\s\S]*?)\n\1```/gm)) {
    const meta = match[2] ?? "";
    blocks.push({
      lang: meta.split(/\s/)[0] ?? "",
      title: /title="([^"]*)"/.exec(meta)?.[1] ?? "",
      code: (match[3] ?? "").replace(new RegExp(`^${match[1]}`, "gm"), ""),
    });
  }
  return blocks;
}

function inlineCode(text) {
  const prose = text.replace(/```[\s\S]*?```/g, "");
  return [...prose.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? "");
}

// The command line: its usage text names every command, subcommand and option.
const cliSource = readFileSync(join(root, "src/cli/thermite/usage.ts"), "utf8");
const usage = /const USAGE = `([\s\S]*?)`;/.exec(cliSource)?.[1] ?? "";
const commands = new Map(); // "rig add" or "submit" -> Set of options
let current = null;
for (const line of usage.split("\n")) {
  const head = /^ {2}([a-z][a-z-]*)(?: ([a-z][a-z-]*))?(?=\s|$)/.exec(line);
  if (head) {
    const sub = head[2] && !/^--/.test(head[2]) ? head[2] : "";
    current = sub && /^ {2}[a-z-]+ [a-z-]+(\s|$)/.test(line) ? `${head[1]} ${sub}` : head[1];
    if (!commands.has(current)) commands.set(current, new Set());
  }
  if (current)
    for (const option of line.matchAll(/--[a-z][a-z-]*/g)) commands.get(current)?.add(option[0]);
}
for (const always of ["help", "--help"]) commands.set(always, new Set());

function checkCommandLine(page, text) {
  const joined = text.replace(/\\\n\s*/g, " ");
  for (const match of joined.matchAll(
    /(?:^|[\s($`;&|])(?:npx\s+)?thermite(?![\w-])([^\n;&|`]*)/g,
  )) {
    const words = (match[1] ?? "").trim().split(/\s+/).filter(Boolean);
    const [first, second] = words;
    // "thermite" can also be a name in a URL, a path or a git ref, not the command.
    if (!first || first.startsWith("<") || first === "..." || /[/:.=(]/.test(first)) continue;
    const key = second && commands.has(`${first} ${second}`) ? `${first} ${second}` : first;
    if (!commands.has(key)) {
      const subs = [...commands.keys()].filter((name) => name.startsWith(`${first} `));
      problem(
        page.file,
        subs.length
          ? `thermite ${first} ${second ?? ""}: no such subcommand (${subs.join(", ")})`
          : `thermite ${first}: no such command`,
      );
      continue;
    }
    for (const word of words) {
      const option = /^(--[a-z][a-z-]*)/.exec(word)?.[1];
      if (option && option !== "--help" && !commands.get(key)?.has(option))
        problem(page.file, `thermite ${key}: no option ${option}`);
    }
  }
}

// Settings: names the code reads, and name patterns it builds (THERMITE_CONTROL_${role}_...).
const codeFiles = walk(join(root, "src"), /\.ts$/);
const otherFiles = [
  ...walk(join(root, "containers"), /.*/),
  ...walk(join(root, "scripts"), /\.(mjs|ts|sh)$/),
  ...["compose.yaml", "compose.lifecycle.yaml"].map((f) => join(root, f)),
].filter((f) => existsSync(f) && !f.endsWith("docs-check.mjs"));
// QWEN_ was the model settings' prefix in Thermite's first deployment. The code reads none of
// those names now, so a page that still names one fails as a setting the code does not read.
const settingName = /\b(?:THERMITE|QWEN)_[A-Z0-9_]*[A-Z0-9]\b/g;
const codeSettings = new Set();
const settingPatterns = [];
for (const file of codeFiles) {
  const text = readFileSync(file, "utf8");
  for (const name of text.match(settingName) ?? []) codeSettings.add(name);
  for (const dynamic of text.matchAll(/\b((?:THERMITE|QWEN)_[A-Z0-9_]*)\$\{[^}]+\}([A-Z0-9_]*)/g))
    settingPatterns.push(new RegExp(`^${dynamic[1]}[A-Z0-9]+${dynamic[2]}$`));
}
const knownSettings = new Set(codeSettings);
for (const file of otherFiles)
  for (const name of readFileSync(file, "utf8").match(settingName) ?? []) knownSettings.add(name);
const exists = (name) => knownSettings.has(name) || settingPatterns.some((p) => p.test(name));

// Names Thermite sets for its own child processes or tests, not settings anyone sets. Each has
// its reason; the settings reference leaves them out.
const internalSettings = new Map([
  ["THERMITE_SUPERVISOR_TOKEN", "the broker passes the token's value to the harness's controller"],
  ["THERMITE_PROPOSER_TOKEN", "the broker passes the token's value to the harness's controller"],
  ["THERMITE_MODEL_API_KEY", "the broker passes the key's value to the harness's controller"],
  ["THERMITE_BROKER_SOCKET", "the broker tells the controller where its socket is"],
  [
    "THERMITE_ADVISOR_SOCKET",
    "the supervisor's entry, or the broker in one container, tells the supervisor where its advisors' runner is",
  ],
  [
    "THERMITE_ADVISOR_RUNS_DIR",
    "the supervisor's entry, or the broker in one container, tells the supervisor where to make each advisor's folder",
  ],
  ["THERMITE_HARNESS_URL", "the controller tells workers where the harness API is"],
  ["THERMITE_TRIAL_AUTH", "the controller gives a trial its token"],
  ["THERMITE_PROXY_AUTH", "the controller gives a trial its model proxy token"],
  ["THERMITE_MCP_AUTH", "the controller gives Codex its token for the harness's MCP gateway"],
  ["THERMITE_EDITABLE_PATHS", "the controller tells thermite-trial what a trial may edit"],
  ["THERMITE_WORKSPACE", "the controller tells thermite-trial where the trial's workspace is"],
  ["THERMITE_OPENCODE_EVENTS", "the controller's event log path for an OpenCode trial"],
  ["THERMITE_CLAUDE_EVENTS", "the controller's event log path for a Claude Code trial"],
  ["THERMITE_CLAUDE_PROMPT", "the controller tells the shell where a Claude Code run's prompt is"],
  ["THERMITE_CODEX_EVENTS", "the controller's event log path for a Codex trial"],
  [
    "THERMITE_SIGNALS",
    "the controller tells a trial's hooks and Thermite's OpenCode plugin where its signals go",
  ],
  [
    "THERMITE_COMPACTION_DROPS",
    "the controller or the supervisor tells Thermite's OpenCode plugin where to keep a conversation",
  ],
  [
    "THERMITE_COMPACTION_LINE",
    "the controller or the supervisor gives Thermite's OpenCode plugin the line naming the kept file",
  ],
  ["THERMITE_LANE_CACHE", "the controller gives each lane's commands its build cache"],
  ["THERMITE_BASELINE_DIR", "the judge gives a hill climb's kit check its baseline folder"],
  ["THERMITE_PROBE_TOKEN", "control gives a RunPod test pod its report path"],
  ["THERMITE_PROBE_JS", "control gives a RunPod test pod its probe script"],
]);

function checkSettings(page, texts) {
  for (const text of texts)
    for (const name of text.match(settingName) ?? [])
      if (!exists(name)) problem(page.file, `${name}: no such setting in the code`);
}

// Example files are parsed with the real schemas. A title with "(part)" marks a fragment.
const schemas = {
  contract: (await import("../../src/core/contract.ts")).ContractSchema,
  kit: (await import("../../src/core/kit.ts")).KitSchema,
  advisors: (await import("../../src/supervisor/advisors/index.ts")).AdvisorsFile,
};
function exampleKind(title) {
  if (/\(part\)/i.test(title)) return null;
  if (/advisors[\w.-]*\.json$/i.test(title)) return "advisors";
  if (/(^|\/)kit\.json$/i.test(title)) return "kit";
  if (/contract[\w.-]*\.json$/i.test(title)) return "contract";
  return null;
}

for (const page of pages) {
  const body = page.body ?? "";
  const blocks = codeBlocks(body);
  const inline = inlineCode(body);
  for (const block of blocks) {
    if (["sh", "bash", "shell", "console", "zsh", "text", ""].includes(block.lang))
      checkCommandLine(page, block.code);
    const kind = exampleKind(block.title);
    if (kind) {
      let value;
      try {
        value = JSON.parse(block.code);
      } catch (error) {
        problem(page.file, `${block.title}: not valid JSON (${error.message})`);
        continue;
      }
      const parsed = schemas[kind].safeParse(value);
      if (!parsed.success)
        problem(
          page.file,
          `${block.title}: the ${kind} schema refuses it: ${parsed.error.issues
            .map((i) => `${i.path.join(".") || "(top)"} ${i.message}`)
            .join("; ")}`,
        );
    }
  }
  for (const code of inline) if (/^(npx\s+)?thermite\s/.test(code)) checkCommandLine(page, code);
  checkSettings(page, [body]);
}

const settingsPage = pages.find((p) => p.slug === "reference/settings");
if (settingsPage) {
  const documented = new Set(settingsPage.text.match(settingName) ?? []);
  for (const name of codeSettings)
    if (!documented.has(name) && !internalSettings.has(name))
      problem(settingsPage.file, `${name} is read by the code but not documented here`);
} else problems.push("docs/_site/src/content/docs/reference/settings.md: missing");

// Each part's number settings are kept in one table (goal 125, T4). The settings page's Type and
// Default cells must say what the table says: the range, whole numbers, the unit, the default.
const numberTables = [
  (await import("../../src/control/settings.ts")).CONTROL_NUMBERS,
  (await import("../../src/harness/settings.ts")).HARNESS_NUMBERS,
  (await import("../../src/agents/settings.ts")).AGENTS_NUMBERS,
  (await import("../../src/harness/broker/settings.ts")).BROKER_NUMBERS,
  (await import("../../src/supervisor/settings.ts")).SUPERVISOR_NUMBERS,
  (await import("../../src/cli/settings.ts")).CLI_NUMBERS,
];
function checkNumberRow(spec, cells) {
  const where = `${spec.name} (${cells.length >= 5 ? "Type, Default" : "Default"})`;
  const shown = cells.length >= 5 ? cells[2] : cells[1];
  const shownNumber = /^`(-?[\d.]+)`/.exec(shown)?.[1];
  if (spec.fallback !== undefined && shownNumber !== String(spec.fallback))
    problem(settingsPage.file, `${where}: the code's default is ${spec.fallback}, not "${shown}"`);
  if (spec.fallback === undefined && shownNumber !== undefined)
    problem(settingsPage.file, `${where}: the code has no default, the page says ${shownNumber}`);
  if (cells.length < 5) return;
  const type = cells[1].replace(/(\d),(\d)/g, "$1$2");
  const { min = 0, max, aboveMin, integer, unit } = spec.rule;
  const range =
    max !== undefined ? `${min} to ${max}` : aboveMin ? `above ${min}` : `${min} or more`;
  if (!type.includes(range)) problem(settingsPage.file, `${where}: the range is ${range}`);
  if (Boolean(integer) !== /integer|whole/.test(type))
    problem(settingsPage.file, `${where}: ${integer ? "whole numbers only" : "fractions work"}`);
  if (unit && !type.includes(unit)) problem(settingsPage.file, `${where}: the unit is ${unit}`);
}
if (settingsPage)
  for (const table of numberTables)
    for (const spec of Object.values(table)) {
      const rows = settingsPage.text
        .split("\n")
        .filter((line) => line.startsWith(`| \`${spec.name}\` |`))
        .map((line) => line.split(" | ").map((cell) => cell.replace(/^\| |\s*\|$/g, "").trim()));
      if (!rows.length) problem(settingsPage.file, `${spec.name}: no row in a table`);
      for (const cells of rows) checkNumberRow(spec, cells);
    }

// --- The Credits page ------------------------------------------------------------------------

// CREDITS.md is the one copy: the site's page is it below its heading (scripts/docs/credits-page.mjs).
if (!existsSync(creditsFile)) problems.push("CREDITS.md: missing");
else {
  let want;
  try {
    want = creditsPage();
  } catch (err) {
    problem(creditsFile, err instanceof Error ? err.message : String(err));
  }
  const have = existsSync(creditsPageFile) ? readFileSync(creditsPageFile, "utf8") : null;
  if (want !== undefined && have !== want)
    problem(
      creditsPageFile,
      have === null
        ? "missing: run `npm run docs:credits` to write it from CREDITS.md"
        : "does not match CREDITS.md: run `npm run docs:credits`, and change CREDITS.md, not the page",
    );
}

// --- The Agent roles page --------------------------------------------------------------------

// src/agents/roles/ is the one copy: the site's page is written from its table of roles.
{
  let want;
  try {
    want = await agentsPage();
  } catch (err) {
    problem(agentsPageFile, err instanceof Error ? err.message : String(err));
  }
  const have = existsSync(agentsPageFile) ? readFileSync(agentsPageFile, "utf8") : null;
  if (want !== undefined && have !== want)
    problem(
      agentsPageFile,
      have === null
        ? "missing: run `npm run docs:agents` to write it from src/agents/roles/"
        : "does not match src/agents/roles/: run `npm run docs:agents`, and change the role's module, not the page",
    );
}

// --- The built site ---------------------------------------------------------------------------

if (checkBuild) {
  if (!existsSync(join(siteOut, "llms.txt"))) {
    problems.push(".dev/site: not built; run `npm run docs:build` first, or pass --no-build");
  } else {
    const llms = readFileSync(join(siteOut, "llms.txt"), "utf8");
    const full = readFileSync(join(siteOut, "llms-full.txt"), "utf8");
    for (const page of pages) {
      if (!existsSync(join(siteOut, `${page.slug}.md`)))
        problems.push(`.dev/site/${page.slug}.md: no Markdown copy`);
      if (!llms.includes(`/${page.slug}.md)`))
        problems.push(`.dev/site/llms.txt: does not list ${page.slug}`);
      const heading = page.heroTitle ?? page.title;
      if (heading && !full.includes(`# ${heading}\n`))
        problems.push(`.dev/site/llms-full.txt: does not hold "${heading}"`);
    }
  }
}

if (problems.length) {
  process.stderr.write(`docs-check: ${problems.length} problem(s)\n${problems.join("\n")}\n`);
  process.exit(1);
}
const stubs = pages.filter((p) => /:::note\[Being written\]/.test(p.body ?? "")).length;
process.stdout.write(
  `docs-check: ok (${pages.length} pages${stubs ? `, ${stubs} still stubs` : ""})\n`,
);
