import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AdvisorsConfig, AdvisorsFile } from "../../../src/supervisor/advisors/index.ts";

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
  test("takes keys from key files, and a kb over https or on this machine", () => {
    for (const url of [
      "https://kb.example.com/mcp",
      "http://localhost:8080/mcp",
      "http://127.0.0.1:8080/mcp",
      "http://[::1]:8080/mcp",
    ]) {
      const file = AdvisorsFile.parse({ teachers: [api], auditor: api, kb: kb(url) });
      assert.equal(file.kb?.mcp_url, url);
      assert.equal(file.kb?.tool, "search");
      assert.equal(
        file.teachers[0]?.runtime === "openai" && file.teachers[0].api_key_file,
        api.api_key_file,
      );
    }
  });

  test("refuses a kb address that is plain http to another machine, or carries a secret", () => {
    for (const url of [
      "http://kb.example.com/mcp",
      "http://kb.example.org:8080/mcp",
      "ftp://kb.example.com/mcp",
      "https://user:pass@kb.example.com/mcp",
      "https://kb.example.com/mcp?token=abc",
      "https://kb.example.com/mcp#part",
    ]) {
      const problems = refused({ kb: kb(url) });
      assert.equal(problems.length, 1, url);
      assert.match(
        problems[0] ?? "",
        /^kb\.mcp_url: Use https, or http to this machine only \(localhost, 127\.0\.0\.1, \[::1\]\)/,
        url,
      );
    }
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
