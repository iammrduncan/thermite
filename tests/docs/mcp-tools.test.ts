import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { KitRepos } from "../../src/control/kits/index.ts";
import { ADMIN, controlOnly, mcpClient } from "../helpers/control-stack.ts";

/**
 * The docs' MCP page against the server (goal 254, item 3). The page is written by hand, so this
 * holds it to the tools control registers: every tool the page has a section for is one the
 * server offers, and every input a section's table lists is one of that tool's arguments; every
 * tool the server offers has a section; and the page's table of who may call which tool says
 * what each kind of token is offered. It reads the server as an MCP client does, with each
 * token, so it holds whatever registers the tools.
 *
 * It does not hold a tool's description, what it returns, or an argument a section gives in
 * words and not in a table ("its input is a policy's design").
 */

const PAGE = join(
  import.meta.dirname,
  "..",
  "..",
  "docs",
  "_site",
  "src",
  "content",
  "docs",
  "reference",
  "mcp-tools.md",
);

const ROLES = ["owner", "operator", "agent", "reader"] as const;
type Role = (typeof ROLES)[number];
/** What the server offers each kind of token: each tool's arguments, by the tool's name. */
type Offered = Record<Role, Map<string, string[]>>;

/** A page's part under one `## ` heading, without the heading. */
function part(page: string, heading: string): string {
  const at = page.indexOf(`\n## ${heading}\n`);
  if (at < 0) return "";
  const from = at + heading.length + 5;
  const end = page.indexOf("\n## ", from);
  return page.slice(from, end < 0 ? undefined : end);
}

/** The cells of a table's row, or none for a line that is not one. */
const cells = (line: string): string[] =>
  line.startsWith("|")
    ? line
        .split(/(?<!\\)\|/)
        .slice(1, -1)
        .map((c) => c.trim())
    : [];

/** The names a cell gives in code marks. */
const named = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");

/** Each tool's section under "Tools", by the tool's name. */
function sections(page: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of part(page, "Tools")
    .split(/\n### /)
    .slice(1)) {
    const end = s.indexOf("\n");
    out.set(s.slice(0, end < 0 ? undefined : end).trim(), s);
  }
  return out;
}

/** The inputs a section lists: the first cell of each row of a table whose first column is Input. */
function inputs(section: string): string[] {
  const out: string[] = [];
  let listing = false;
  for (const line of section.split("\n")) {
    const first = cells(line)[0];
    if (first === undefined) listing = false;
    else if (first === "Input") listing = true;
    else if (listing && !/^:?-+:?$/.test(first)) out.push(...named(first));
  }
  return out;
}

/** "Who may call which tool": for each tool the table names, whether each kind of token may. */
function whoMay(page: string): Map<string, Record<Role, boolean>[]> {
  const out = new Map<string, Record<Role, boolean>[]>();
  for (const line of part(page, "Who may call which tool").split("\n")) {
    const row = cells(line);
    if (row.length !== 5 || !/^(?:Yes|No)\b/.test(row[1] ?? "")) continue;
    const may = Object.fromEntries(
      ROLES.map((role, i) => [role, (row[i + 1] ?? "").startsWith("Yes")]),
    ) as Record<Role, boolean>;
    for (const tool of named(row[0] ?? "")) out.set(tool, [...(out.get(tool) ?? []), may]);
  }
  return out;
}

/** Where the page and the server differ, in words; none when the page says what the server offers. */
function differences(page: string, offered: Offered): string[] {
  const out: string[] = [];
  // The owner's token is offered every tool: the rest of this reads its list as all of them.
  const all = offered.owner;
  for (const role of ROLES)
    for (const tool of offered[role].keys())
      if (!all.has(tool))
        out.push(`The server offers ${tool} to the ${role}'s token, and not to the owner's.`);
  const onPage = sections(page);
  for (const [tool, text] of onPage) {
    const args = all.get(tool);
    if (!args) {
      out.push(`The page has a section for ${tool}, and the server offers no tool of that name.`);
      continue;
    }
    for (const input of inputs(text)) {
      const name = input.split(/[.[ ]/)[0] ?? "";
      if (!args.includes(name))
        out.push(
          `The page lists the input ${input} of ${tool}, which has no argument ${name}: its arguments are ${args.join(", ") || "none"}.`,
        );
    }
  }
  for (const tool of all.keys())
    if (!onPage.has(tool))
      out.push(`The server offers ${tool}, and the page has no section for it.`);
  const table = whoMay(page);
  for (const [tool, rows] of table) {
    if (!all.has(tool)) {
      out.push(
        `"Who may call which tool" names ${tool}, and the server offers no tool of that name.`,
      );
      continue;
    }
    if (rows.length > 1)
      out.push(`"Who may call which tool" names ${tool} in ${rows.length} rows.`);
    for (const role of ROLES) {
      const says = rows[0]?.[role] ?? false;
      if (says !== offered[role].has(tool))
        out.push(
          `"Who may call which tool" says ${says ? "Yes" : "No"} for ${tool} and the ${role}'s token, and the server ${says ? "does not offer" : "offers"} it to that token.`,
        );
    }
  }
  for (const tool of all.keys())
    if (!table.has(tool)) out.push(`"Who may call which tool" does not name ${tool}.`);
  return out;
}

/** What control's MCP server offers each kind of token, with every tool it can have. */
async function serverOffers(): Promise<Offered> {
  const tokens = {
    owner: ADMIN,
    operator: "operator-token-abcdef",
    agent: "agent-token-abcdef",
    reader: "read-token-abcdef",
  };
  const { control, store } = await controlOnly({
    tokens: { operator: tokens.operator, agent: tokens.agent, read: tokens.reader },
    // The kit tools are offered only by a control that keeps kits.
    options: {
      kits: new KitRepos(join(mkdtempSync(join(tmpdir(), "thermite-mcp-page-")), "kits")),
    },
  });
  const out = {} as Offered;
  for (const role of ROLES) {
    const client = await mcpClient(control, tokens[role]);
    const { tools } = await client.listTools();
    out[role] = new Map(
      tools.map((t) => [
        t.name,
        Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}),
      ]),
    );
    await client.close();
  }
  await store.close();
  return out;
}

describe("the docs' MCP page", () => {
  test("says what the server offers: each tool, each input in a table, and who may call it", async () => {
    const offered = await serverOffers();
    assert.ok(offered.owner.size > 50, "the server's tools were listed");
    assert.ok(offered.reader.size < offered.owner.size, "a reader is offered fewer tools");
    const page = readFileSync(PAGE, "utf8");
    assert.ok(sections(page).size > 50, "the page's sections were found");
    assert.ok(whoMay(page).size > 50, "the page's table of who may call which tool was found");
    assert.deepEqual(
      differences(page, offered),
      [],
      "Change docs/_site/src/content/docs/reference/mcp-tools.md to what the server offers, in the commit that changes the tool.",
    );
  });

  test("a difference is found: a tool, an input and a token the server does not have", () => {
    const tool = (args: string[]) => args;
    const offered: Offered = {
      owner: new Map([
        ["list_things", tool(["limit"])],
        ["set_thing", tool(["id", "value"])],
      ]),
      operator: new Map([["list_things", tool(["limit"])]]),
      agent: new Map(),
      reader: new Map([["list_things", tool(["limit"])]]),
    };
    const page = (o: { tools?: string; table?: string } = {}) =>
      [
        "# MCP tools",
        "",
        "## Who may call which tool",
        "",
        "| Tool | Owner | Operator | Agent | Reader |",
        "| --- | --- | --- | --- | --- |",
        o.table ?? "| `list_things` | Yes | Yes | No | Yes |\n| `set_thing` | Yes | No | No | No |",
        "",
        "## Tools",
        "",
        "### list_things",
        "",
        "| Input | Type | Default | Meaning |",
        "| --- | --- | --- | --- |",
        "| `limit` | whole number | 50 | How many |",
        "",
        "Returns a list:",
        "",
        "| Field | Meaning |",
        "| --- | --- |",
        "| `name` | A field of the answer, not an input |",
        "",
        o.tools ??
          "### set_thing\n\n| Input | Type | Default | Meaning |\n| --- | --- | --- | --- |\n| `id` | string | | The thing |\n| `value.inner` | string | | A field of the value |",
        "",
        "## The audit log",
        "",
        "### not_a_tool",
        "",
      ].join("\n");
    assert.deepEqual(differences(page(), offered), []);

    const gone = differences(
      page({ tools: "### set_thing\n\n### drop_thing\n\nNo inputs." }),
      offered,
    );
    assert.deepEqual(gone, [
      "The page has a section for drop_thing, and the server offers no tool of that name.",
    ]);
    const input = differences(
      page({
        tools:
          "### set_thing\n\n| Input | Type | Default | Meaning |\n| --- | --- | --- | --- |\n| `id` | string | | The thing |\n| `colour` | string | | Not an argument |",
      }),
      offered,
    );
    assert.deepEqual(input, [
      "The page lists the input colour of set_thing, which has no argument colour: its arguments are id, value.",
    ]);
    const unlisted = differences(page({ tools: "Nothing here." }), offered);
    assert.deepEqual(unlisted, [
      "The server offers set_thing, and the page has no section for it.",
    ]);
    const token = differences(
      page({
        table:
          "| `list_things` | Yes | Yes | No | Yes |\n| `set_thing` | Yes | Yes, in part | No | No |",
      }),
      offered,
    );
    assert.deepEqual(token, [
      `"Who may call which tool" says Yes for set_thing and the operator's token, and the server does not offer it to that token.`,
    ]);
    const unnamed = differences(
      page({ table: "| `list_things` | Yes | Yes | No | Yes |" }),
      offered,
    );
    assert.deepEqual(unnamed, [`"Who may call which tool" does not name set_thing.`]);
  });
});
