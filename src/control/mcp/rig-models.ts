import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { COMPACT_AT_DEFAULT, COMPACT_AT_MAX, COMPACT_AT_MIN } from "../../core/compaction.ts";
import {
  type RigModelBody,
  rigModelAnswer,
  rigModelFields,
  rigModelRequest,
  rigModels,
  rigModelsAnswer,
  setRigModel,
} from "../rigs/index.ts";
import type { ControlStore } from "../store/index.ts";
import type { Audited } from "./rig-reads.ts";

/**
 * MCP's tools for each of a rig's agents' models (goal 029), the twins of Edit rig's section
 * "2 · The agents": rig_models for every token but the agent's, set_rig_model for the owner's
 * and an operator's (`canCommand`), which `actor` names.
 */
export function registerRigModels(
  server: McpServer,
  audited: Audited,
  store: ControlStore,
  actor: string,
  canCommand: boolean,
): void {
  server.registerTool(
    "rig_models",
    {
      title: "Each agent's model on a rig",
      description: `Each agent's model on a rig: the work (workers, planner) and the advisors (teachers, auditor, review_panel, synthesizer, final_writer). A model is {provider, model, effort, harness, context_cap, compact_at} (harness: where it runs, pi, opencode, claude-code or codex; context_cap null: the provider's window; compact_at null: the default, ${COMPACT_AT_DEFAULT}% of the window). workers, planner, auditor, review_panel, synthesizer and final_writer are each a model, or null for the default: the workers use the rig's own settings, the planner the workers' model, the synthesizer and the final writer (a research run's answer cards and paper) the first teacher's model, another advisor the one in the rig's advisors file (off when the file names none). teachers is {models, merged_by}: models holds one teacher's model or two teachers' (empty: the teachers in the advisors file), and merged_by the model that merges the advice of two teachers (null: the one in the advisors file). agents is what control gives the rig; set it with set_rig_model. advisors_file is what the rig's advisors file sets up, as its supervisor reports it: {teachers, merged_by, auditor, review_panel}, each advisor {harness, model, provider, api, context_window, compact_at} (harness: pi, claude-code, opencode, codex, or cli for a command-line agent, whose model is null; provider: the provider's name the file gives, or null; api: the provider's kind, such as openai, anthropic, chatgpt, opencode or claude; context_window null: none; compact_at null: the default). An empty list or null: the file names none, so that advisor is off until control gives it a model. advisors_file is null when the supervisor has not reported it: none yet, or an older supervisor. It never holds a key, a token or an address.`,
      inputSchema: { rig: z.string().min(1) },
    },
    audited("rig_models", (a: { rig: string }) => {
      const agents = rigModels(store, a.rig);
      if ("error" in agents) throw new Error(agents.error);
      return rigModelsAnswer(store, a.rig, agents);
    }),
  );
  if (canCommand) {
    server.registerTool(
      "set_rig_model",
      {
        title: "Give a rig's agents a model",
        description: `As a row of Edit rig's section The agents does: the model one of a rig's agents uses, from a model provider in Providers (see the providers tool for their models). agent: workers (default), planner, teachers, auditor, review_panel, synthesizer (a research run's answer cards) or final_writer (its paper); the other agents keep their models. The teachers take one or two models: provider and model give the first teacher's; second_model, {provider, model, harness?, effort?, context_window?, compact_at?}, gives a second teacher (null: one teacher only); merged_by, the same shape, gives the model that merges the advice of two teachers into one set (null: the one in the rig's advisors file). Two teachers without a merged by model: the first review that comes back is the set. A call may give second_model or merged_by alone; a second teacher needs a first. clear: true, with no provider or model, sends the agent back to its default: the workers to the rig's own settings, the planner to the workers' model, the synthesizer and the final writer to the first teacher's model, another advisor to the one in the rig's advisors file (off when the file names none; rig_models shows the file's); for the teachers, their second and merged by models too. The workers and the planner take a new model within a minute, and the rig checks the workers' model; an advisor uses its new model from its next round. harness, for any agent: where it runs, pi, opencode (OpenCode v2), claude-code or codex (the Codex CLI); left out, what the model needs (Claude Code for a Claude subscription, OpenCode for OpenCode's free models, else Pi). A Claude subscription runs only in claude-code and claude-code only with one; codex only with a ChatGPT subscription or an OpenAI-compatible provider; OpenCode's free models only in opencode: another harness is refused in words. A planner with no model of its own follows the workers' (in Codex when the workers run in Codex). Advisors run in the supervisor: in pi with read-only tools; in claude-code, opencode or codex with none of the program's own tools, only the search of the run's past research and the kit's MCP tools. Every agent takes context_window and compact_at, kept with its model; a planner with no model of its own uses the workers'. context_window caps the agent's context window in tokens (from 4096), for example to compare two models at the same window; a cap above the provider's window is refused. Pi keeps to it; OpenCode, Codex and Claude Code get it in their own settings, as far as each takes one; an advisor's one-call package is cut to fit it. compact_at is the share of the window, in percent (${COMPACT_AT_MIN} to ${COMPACT_AT_MAX}; default ${COMPACT_AT_DEFAULT}), at which the agent's conversation is compacted: the conversation is kept as a document, summarized, and the agent goes on. It never ends a trial. Each call sets the agent's cap and compact_at anew: a call without them removes a cap and returns to the default point. A campaign may set its own (set_campaign_context): the lower window wins. Returns context_window, the window the agent's model route carries (for the teachers, the first teacher's; null: the provider lists none, the model was cleared, or the call gave only second_model or merged_by), compact_at (null: the default), and agents, each agent's model after the change, as rig_models reads them.`,
        inputSchema: { rig: z.string().min(1), ...rigModelFields },
      },
      audited("set_rig_model", async (a: RigModelBody & { rig: string }) => {
        const { rig, ...body } = a;
        const req = rigModelRequest(body);
        const r = await setRigModel(store, rig, req, actor);
        if ("error" in r) throw new Error(r.error);
        return rigModelAnswer(rig, req, r);
      }),
    );
  }
}
