import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { CliRun } from "../../../src/agents/cli/index.ts";
import type { ModelConfig } from "../../../src/agents/model/index.ts";
import { codexAdvisorConfig } from "../../../src/supervisor/advisors/cli.ts";
import { codexTeacherCatalog } from "../../../src/supervisor/advisors/codex-catalog.ts";
import { advisorProgram } from "../../../src/supervisor/advisors/terminal/index.ts";

/**
 * A Codex teacher's model catalog (goal 232): its model's own entry from Codex's bundled catalog,
 * over the full Responses API with no tools of Codex's own, so Codex sends the provider's hosted
 * web search and not its standalone one, which a ChatGPT sign-in's route refuses, nor tool_search.
 */

const dir = mkdtempSync(join(tmpdir(), "thermite-codex-catalog-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const LITE = {
  slug: "gpt-6.1-sol",
  use_responses_lite: true,
  tool_mode: "code_mode_only",
  apply_patch_tool_type: "freeform",
  multi_agent_version: "v2",
  multi_agent_reasoning_effort: "xhigh",
  experimental_supported_tools: ["send_user_message_async", "clock"],
  supports_search_tool: true,
  web_search_tool_type: "text_and_image",
  context_window: 272000,
};

/** A stand-in for the Codex CLI that prints a bundled catalog for `debug models --bundled`. */
function fakeCodex(name: string, models: unknown[]): string {
  const bin = join(dir, name);
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
if (args !== "debug models --bundled") process.exit(2);
process.stdout.write(${JSON.stringify(JSON.stringify({ models }))});
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

/** Runs `f` with THERMITE_CODEX_BIN set to `bin`, then sets it back. */
function withCodex(bin: string, f: () => void): void {
  const before = process.env.THERMITE_CODEX_BIN;
  process.env.THERMITE_CODEX_BIN = bin;
  try {
    f();
  } finally {
    if (before === undefined) delete process.env.THERMITE_CODEX_BIN;
    else process.env.THERMITE_CODEX_BIN = before;
  }
}

/** A route with an API key (an OpenAI-compatible provider), or with `chatgpt` a ChatGPT sign-in's. */
const model = (slug: string, api?: "chatgpt"): ModelConfig => ({
  ...(api ? { api } : {}),
  harness: "codex",
  baseUrl: "https://api.openai.com/v1",
  model: slug,
  apiKey: "",
  contextWindow: 0,
  maxTokens: 0,
});

test("a model on Responses Lite gets its own entry over the full Responses API, with no tools of Codex's own; others get none", () => {
  withCodex(fakeCodex("codex", [LITE, { slug: "gpt-5.5", use_responses_lite: false }]), () => {
    const catalog = codexTeacherCatalog(model("gpt-6.1-sol"));
    assert.deepEqual(JSON.parse(catalog ?? "{}"), {
      models: [
        {
          slug: "gpt-6.1-sol",
          use_responses_lite: false,
          experimental_supported_tools: [],
          supports_search_tool: false,
          web_search_tool_type: "text_and_image",
          context_window: 272000,
        },
      ],
    });
    assert.equal(
      codexTeacherCatalog(model("gpt-5.5")),
      undefined,
      "its hosted search needs no change",
    );
    assert.equal(codexTeacherCatalog(model("a-model-codex-does-not-know")), undefined);
    // A ChatGPT sign-in's route takes the hosted search, not Codex's tool_search.
    assert.equal(
      codexTeacherCatalog(model("gpt-6.1-sol", "chatgpt")),
      codexTeacherCatalog(model("gpt-6.1-sol")),
    );
  });
});

test("a Codex that can't print its catalog leaves the teacher as Codex drives it", () => {
  withCodex(join(dir, "no-such-codex"), () => {
    assert.equal(codexTeacherCatalog(model("gpt-6.1-sol")), undefined);
  });
});

test("the teacher's configuration names the catalog among its top-level keys, with no standalone search", () => {
  const root = "http://127.0.0.1:1/v1/model-proxy";
  const m = model("gpt-6.1-sol");
  const config = codexAdvisorConfig(m, root, [], undefined, undefined, true, "/x/models.json");
  const first = config.indexOf("[");
  const at = config.indexOf('model_catalog_json = "/x/models.json"');
  assert.ok(at >= 0 && at < first, config.slice(0, 300));
  assert.match(config, /^web_search = "live"$/m);
  assert.match(config, /^standalone_web_search = false$/m);
  // Nor Codex's worktree tools, for which its terminal adds a tool_search the route refuses.
  assert.match(config, /^worktrees = false$/m);
  assert.doesNotMatch(config, /supports_standalone_web_search|direct_only_tool_namespaces/);
  // With no catalog, a teacher keeps Codex's standalone search, as Codex has no other for it.
  const without = codexAdvisorConfig(m, root, [], undefined, undefined, true);
  assert.doesNotMatch(without, /model_catalog_json/);
  assert.match(without, /^supports_standalone_web_search = true$/m);
  assert.doesNotMatch(without, /^standalone_web_search = false$/m);
});

test("a teacher in its own terminal has the catalog in its Codex home, and its configuration names it", () => {
  const area = "/var/lib/thermite-advisors/thermite-advisor-abc";
  const run: CliRun = {
    id: "advisor-teacher-2-r-1-1",
    role: "advisor-teacher-2-r-1-1",
    title: "Advisor teacher-2",
    model: model("gpt-6.1-sol"),
    apiUrl: "http://127.0.0.1:4300",
    area,
    home: join(area, "codex-home"),
    tmp: join(area, "codex-tmp"),
    auth: "call.made-up",
    mcp: undefined,
    keptAt: undefined,
    wallMs: undefined,
    env: undefined,
    tools: "",
  };
  const proxy = {
    root: "http://127.0.0.1:4200/v1/model-proxy",
    token: "proxy.made-up",
    close: async () => undefined,
  };
  const at = { cwd: area, session: "s-1", resume: false, port: 4400 };
  withCodex(fakeCodex("codex-terminal", [LITE]), () => {
    const seeds = advisorProgram("codex", { proxy, web: true }).terminal.start(run, at).seeds;
    const path = join(area, "codex-home", ".codex", "models.json");
    assert.equal(JSON.parse(seeds[1]?.content ?? "{}").models[0].use_responses_lite, false);
    assert.equal(seeds[1]?.path, path);
    assert.match(seeds[0]?.content ?? "", new RegExp(`^model_catalog_json = "${path}"$`, "m"));
    // Not a teacher: no catalog, and no web search.
    const auditor = advisorProgram("codex", { proxy }).terminal.start(run, at).seeds;
    assert.equal(auditor.length, 1);
    assert.doesNotMatch(auditor[0]?.content ?? "", /model_catalog_json/);
    // A teacher on a ChatGPT sign-in: the same catalog, and no standalone search.
    const plan = { ...run, model: model("gpt-6.1-sol", "chatgpt") };
    const signedIn = advisorProgram("codex", { proxy, web: true }).terminal.start(plan, at).seeds;
    assert.equal(signedIn.length, 2);
    assert.match(signedIn[0]?.content ?? "", /^model_catalog_json = /m);
    assert.doesNotMatch(signedIn[0]?.content ?? "", /supports_standalone_web_search/);
  });
});
