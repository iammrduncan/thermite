import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TSchema } from "@earendil-works/pi-ai";
import type { z } from "zod";
import {
  codexCompactions,
  codexOwn,
  findCodexRollout,
  opencodeEnded,
  opencodeOwn,
  readUnder,
} from "../../../agents/compaction/index.ts";
import type { ModelConfig } from "../../../agents/model/index.ts";
import {
  codexBin,
  codexExe,
  OPENCODE_BASE_ENV,
  OPENCODE_PLUGIN,
  OPENCODE_PLUGIN_LINK,
  opencodeBin,
  opencodeExe,
  opencodeKeepEnv,
} from "../../../agents/programs/index.ts";
import { messageText, type Prompt } from "../../../agents/prompt.ts";
import type { AdvisorFrame } from "../../../agents/roles/index.ts";
import { KB_SERVER } from "../../../agents/tools/index.ts";
import type { UsageRoute } from "../../../core/usage.ts";
import type { AdvisorKeeper, AdvisorResult, AdvisorTools } from "../call.ts";
import {
  codexAdvisorArgs,
  codexAdvisorConfig,
  opencodeAdvisorArgs,
  opencodeAdvisorConfig,
  readCodexAnswer,
  readOpencodeAnswer,
} from "../cli.ts";
import { type AdvisorRuntime, advisorRoute } from "../config.ts";
import { serveAdvisorModel } from "../proxy.ts";
import { serveAdvisorTools } from "../tools/index.ts";
import { callId, collectCompactions, runCli } from "./cli.ts";

/**
 * An advisor in OpenCode or the Codex CLI (goal 073): the past research and the kit's MCP servers
 * on localhost for this call, a key-adding proxy for the call (none for OpenCode's own models),
 * the CLI's configuration written in the call's own folder, and the prompt on stdin. Its answer is
 * the last message in its JSON events, checked as every advisor's is.
 */
export async function runCliHarness<S extends z.ZodType>(
  rt: Extract<AdvisorRuntime, { runtime: "opencode" | "codex" }>,
  input: {
    prompt(f: AdvisorFrame): Prompt;
    schema: S;
    answerSchema: TSchema;
    tools?: AdvisorTools | undefined;
    keeper?: AdvisorKeeper | undefined;
  },
): Promise<AdvisorResult<z.infer<S>>> {
  const fail = (error: string) => ({ output: undefined, error, tokensIn: 0, tokensOut: 0, usd: 0 });
  const native = rt.runtime === "opencode" && rt.api === "opencode";
  // Where the conversation is kept before each of the program's own compactions (goal 070):
  // OpenCode's through Thermite's plugin, Codex's from its rollout, which the call then keeps.
  const call = callId();
  const keeper = input.keeper;
  const at = keeper?.at?.(rt.name, call);
  if (!native && !rt.base_url) return fail(`advisor ${rt.name} has no base_url`);
  const key = native
    ? ""
    : (rt.api_key ?? (rt.api_key_file ? readFileSync(rt.api_key_file, "utf8").trim() : ""));
  if (!native && !key) return fail(`advisor ${rt.name} has no key`);
  const model: ModelConfig = {
    api: rt.api === "openai" ? undefined : rt.api,
    baseUrl: (rt.base_url ?? "").replace(/\/$/, ""),
    model: rt.model,
    // The key stays in the supervisor: the proxy adds it.
    apiKey: "",
    // The window and the point the CLI compacts with, in its own settings, as the workers' are
    // (goal 070): OpenCode's limit.context and compaction.buffer, Codex's model_context_window and
    // model_auto_compact_token_limit.
    contextWindow: rt.context_window,
    ...(rt.compact_at !== undefined ? { compactAt: rt.compact_at } : {}),
    maxTokens: 0,
    reasoning: rt.runtime === "codex" ? rt.reasoning : undefined,
  };
  const t = input.tools;
  let tools: Awaited<ReturnType<typeof serveAdvisorTools>> | undefined;
  let proxy: Awaited<ReturnType<typeof serveAdvisorModel>> | undefined;
  try {
    if (t?.kb || t?.mcp?.servers.length || t?.code || t?.research || t?.paper)
      tools = await serveAdvisorTools({
        kb: t.kb,
        mcp: t.mcp,
        code: t.code,
        research: t.research,
        paper: t.paper,
      });
    if (!native) proxy = await serveAdvisorModel({ api: model.api, baseUrl: model.baseUrl, key });
    const servers = tools?.servers ?? [];
    const opencode = rt.runtime === "opencode";
    const env = {
      // OpenCode reads no project configuration or instruction files (goal 166, decision 7).
      ...(opencode ? OPENCODE_BASE_ENV : {}),
      ...(proxy ? { THERMITE_PROXY_AUTH: proxy.token } : {}),
      ...(tools ? { THERMITE_MCP_AUTH: tools.token } : {}),
    };
    const root = proxy?.root ?? "";
    const exe = opencode ? (opencodeExe() ?? opencodeBin()) : (codexExe() ?? codexBin());
    const title = `Advisor ${rt.name}`;
    return await runCli(
      {
        argv: [
          exe,
          ...(opencode
            ? opencodeAdvisorArgs(model)
            : codexAdvisorArgs(model, { keep: keeper !== undefined })),
        ],
        timeout_s: rt.timeout_s,
        env,
        // Its configuration in its own folder, written by the supervisor; no credential in it.
        prepare: (home): Record<string, string> => {
          if (opencode) {
            const dir = join(home, ".config", "opencode");
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            writeFileSync(
              join(dir, "opencode.jsonc"),
              JSON.stringify(opencodeAdvisorConfig(model, root, servers)),
              { mode: 0o600 },
            );
            if (!at) return {};
            // Thermite's compaction plugin, linked into OpenCode's own settings (goal 070).
            mkdirSync(join(dir, "plugins"), { recursive: true, mode: 0o700 });
            symlinkSync(OPENCODE_PLUGIN, join(home, OPENCODE_PLUGIN_LINK));
            return opencodeKeepEnv(join(home, "compactions"), at);
          }
          const dir = join(home, ".codex");
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          writeFileSync(join(dir, "config.toml"), codexAdvisorConfig(model, root, servers, at), {
            mode: 0o600,
          });
          return { CODEX_HOME: dir };
        },
        // Each compaction the program made, kept with the round's records (goal 070).
        collect: keeper
          ? (home) => {
              if (opencode)
                return collectCompactions({
                  harness: "opencode",
                  advisor: rt.name,
                  call,
                  count: opencodeEnded(home, ["compactions"]).length,
                  own: opencodeOwn({ root: home, drops: ["compactions"], title }),
                  keeper,
                });
              const rollout = findCodexRollout(home, [".codex"]);
              const said = rollout ? readUnder(home, rollout) : undefined;
              return collectCompactions({
                harness: "codex",
                advisor: rt.name,
                call,
                count: said !== undefined ? codexCompactions(said) : 0,
                own: codexOwn({ root: home, home: [".codex"], title }),
                keeper,
              });
            }
          : undefined,
        read: opencode ? readOpencodeAnswer : readCodexAnswer,
        // Its model usage, as its JSON events report it.
        usage: { route: advisorRoute(rt) as UsageRoute },
      },
      messageText(
        input.prompt({
          program: rt.runtime,
          // The kit's servers: Thermite's own has its own part of the prompt (goal 175).
          mcpServers: servers.map((s) => s.name).filter((s) => s !== KB_SERVER),
          kbWrites: t?.kb?.writes,
          answerSchema: input.answerSchema,
        }),
      ),
      input.schema,
    );
  } finally {
    await proxy?.close();
    await tools?.close();
  }
}
