import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  AdvisorsConfig,
  AdvisorsFile,
  readAdvisorsFile,
} from "../../../src/supervisor/advisors/index.ts";
import { advisorPiTools } from "../../../src/supervisor/advisors/pi/index.ts";

const api = {
  name: "teacher-a",
  runtime: "openai",
  base_url: "https://llm.example.com/v1",
  model: "model-a",
  api_key_file: "/etc/thermite/advisors/llm-key",
};
const kb = (mcp_url: string) => ({ mcp_url, token_file: "/etc/thermite/advisors/kb-token" });

/** Each refusal of a file, as `path: words`. */
function refused(file: unknown): string[] {
  const r = AdvisorsFile.safeParse(file);
  assert.equal(r.success, false, "the file was taken");
  return r.error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`) ?? [];
}

describe("the advisors file", () => {
  test("takes keys from key files", () => {
    const file = AdvisorsFile.parse({ teachers: [api], auditor: api });
    assert.equal(
      file.teachers[0]?.runtime === "openai" && file.teachers[0].api_key_file,
      api.api_key_file,
    );
  });

  test("a file that still has the retired kb is read without it, with a warning that says what replaces it", (t) => {
    const path = join(mkdtempSync(join(tmpdir(), "thermite-advisors-")), "advisors.json");
    writeFileSync(path, JSON.stringify({ teachers: [api], kb: kb("https://kb.example.com/mcp") }));
    const lines: Record<string, unknown>[] = [];
    t.mock.method(process.stdout, "write", (chunk: string) => {
      lines.push(JSON.parse(chunk) as Record<string, unknown>);
      return true;
    });
    const file = readAdvisorsFile(path);
    t.mock.restoreAll();
    assert.equal("kb" in file, false);
    assert.equal(file.teachers[0]?.name, "teacher-a", "the rest of the file is read");
    assert.deepEqual(
      lines.map((l) => [l.level, l.component, l.file]),
      [["warn", "supervisor", path]],
    );
    assert.match(
      String(lines[0]?.msg),
      /^The advisors file's kb is retired, and with it the advisors' search_outside_kb tool: the supervisor reads the file without it\. Give the advisors an outside search as an MCP server that the campaign's kit names/,
    );
    // Its advisors have no outside search: Thermite's knowledge base and the kit's MCP servers.
    const { tools } = advisorPiTools({ fetchUrl: async () => "" });
    assert.deepEqual(
      tools.map((x) => x.name),
      ["fetch_url"],
    );
    // A file without it reads with no warning; a field the file never had is still refused.
    const quiet: unknown[] = [];
    t.mock.method(process.stdout, "write", (chunk: string) => quiet.push(chunk) > 0);
    writeFileSync(path, JSON.stringify({ teachers: [api] }));
    readAdvisorsFile(path);
    t.mock.restoreAll();
    assert.deepEqual(quiet, []);
    assert.deepEqual(refused({ teachers: [api], search: {} }), [': Unrecognized key: "search"']);
  });

  test("refuses a key written into it, in every role, and says where keys come from", () => {
    const inline = { ...api, api_key: "not-a-real-key" };
    const problems = refused({
      teachers: [api, inline],
      merged_by: inline,
      auditor: { ...inline, runtime: "codex" },
      review_panel: [api, { ...inline, runtime: "opencode" }],
    });
    assert.deepEqual(
      problems.map((p) => p.split(":")[0]),
      ["teachers.1.api_key", "review_panel.1.api_key", "merged_by.api_key", "auditor.api_key"],
    );
    for (const p of problems)
      assert.match(
        p,
        /Write no key into the advisors file: name a file that holds it with api_key_file, or give the role a model on Edit rig/,
      );
  });

  test("refuses a token, and a Claude Code runtime, which only control can give", () => {
    const claude = { name: "auditor", runtime: "claude-code", model: "opus" };
    for (const auditor of [{ ...claude, token: "not-a-real-token" }, claude]) {
      const problems = refused({ auditor });
      assert.ok(
        problems.some((p) =>
          p.startsWith(
            "auditor.token: Write no token into the advisors file: a Claude subscription's token comes only from control.",
          ),
        ),
        problems.join("; "),
      );
    }
  });

  test("the words never repeat the key or the token", () => {
    const problems = refused({
      teachers: [{ ...api, api_key: "not-a-real-key" }],
      auditor: { name: "a", runtime: "claude-code", model: "m", token: "not-a-real-token" },
    }).join(" ");
    assert.doesNotMatch(problems, /not-a-real/);
  });

  test("control's models still carry their key and token in memory", () => {
    const running = AdvisorsConfig.parse({
      teachers: [{ ...api, api_key_file: undefined, api_key: "from-control" }],
      auditor: { name: "a", runtime: "claude-code", model: "m", token: "from-control" },
    });
    assert.equal(
      running.teachers[0]?.runtime === "openai" && running.teachers[0].api_key,
      "from-control",
    );
    assert.equal(
      running.auditor?.runtime === "claude-code" && running.auditor.token,
      "from-control",
    );
  });
});
