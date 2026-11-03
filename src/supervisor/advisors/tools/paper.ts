import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorText } from "../../../common/errors.ts";
import { PAPER_MAX } from "../../../core/api/harness/research.ts";
import { toolText } from "./code.ts";

/**
 * The final writer's own tools (goal 112), beside the read-only tools for the run's research:
 * `check_paper` runs the harness's code checks on a draft (the same checks that decide whether
 * the paper is accepted), and `ste_check` runs the rig's STE checker on a text, when the
 * supervisor has one. Neither records anything. In Pi they are tools of the call
 * (pi/tools.ts); in Claude Code, OpenCode and the Codex CLI the supervisor serves them on
 * localhost for the call (mcp.ts), as it serves the research tools.
 */

/** The final writer's checks, as the supervisor runs them for it. */
export interface AdvisorPaper {
  /** The harness's checks of a draft: ok, and each problem with its line. */
  check(markdown: string): Promise<unknown>;
  /** The rig's STE checker on a text, or that the rig has none. */
  ste(text: string): Promise<unknown>;
}

/** The tools' names, as Pi and the MCP server give them. */
export const PAPER_TOOL_NAMES = ["check_paper", "ste_check"] as const;
type Name = (typeof PAPER_TOOL_NAMES)[number];

export const PAPER_TOOLS: Record<Name, string> = {
  check_paper:
    "Check a draft of the research paper with the harness's own checks: the same checks that decide if the paper is accepted. They check the title, that the paper has no References part or appendix (code appends them), that each question with a verified claim is answered (the paper cites its evidence), that each cited claim is a verified claim of the run, that each number in a paragraph is in the claims it cites or in the figures, and that a verdict given to a hypothesis is the review panel's (and none to a hypothesis the run proposed). They do not check the parts. Give the whole paper in `markdown`. Returns ok, and each problem with its line. Nothing is recorded.",
  ste_check:
    "Check a text with the rig's Simplified Technical English checker, in descriptive mode. Returns its counts and its findings, each with its line, rule and message: fix each error before you answer. Give the whole paper, or a part, in `text`. When the rig has no STE checker, it says so.",
};

/** Runs one of the tools with a model's arguments. */
export function runPaperTool(
  paper: AdvisorPaper,
  name: Name,
  p: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "check_paper":
      return paper.check(String(p.markdown ?? ""));
    case "ste_check":
      return paper.ste(String(p.text ?? ""));
  }
}

/** The tools' inputs as an MCP server gives them. */
const SHAPES = {
  check_paper: {
    markdown: z.string().min(1).max(PAPER_MAX).describe("The whole paper, in Markdown"),
  },
  ste_check: {
    text: z.string().min(1).max(PAPER_MAX).describe("The text to check"),
  },
};

/** The tools as an MCP server's, for a final writer in Claude Code, OpenCode or Codex. */
export function registerPaperTools(server: McpServer, paper: AdvisorPaper): void {
  for (const name of PAPER_TOOL_NAMES)
    server.registerTool(
      name,
      {
        description: PAPER_TOOLS[name],
        inputSchema: SHAPES[name],
        annotations: { readOnlyHint: true },
      },
      async (a: Record<string, unknown>) => {
        try {
          const out = await runPaperTool(paper, name, a);
          return {
            content: [{ type: "text" as const, text: toolText(out) }],
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: `failed: ${errorText(err)}`,
              },
            ],
            isError: true,
          };
        }
      },
    );
}
