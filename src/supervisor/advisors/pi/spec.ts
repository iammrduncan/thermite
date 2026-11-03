import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Prompt } from "../../../agents/prompt.ts";
import type { McpToolInfo } from "../../../core/mcp.ts";

/**
 * What an advisor's process in its Pi view reads from its call's folder (goal 169): the supervisor
 * writes it there before the run, 0600, and the advisors' runner hands it to the run's advisor
 * user with the folder. Its credential binds every route to the call; its tools are the headless
 * advisor's, as definitions the process gives its agent, each run by the supervisor.
 */
export interface PiAdvisorSpec {
  /** Its call's routes on localhost, and its credential, bound to the call (`call.<hex>`). */
  url: string;
  auth: string;
  /** The advisor's name, as the advisors file gives it. */
  name: string;
  /** The view's first line: what it is a view of. */
  heading: string;
  /** Its first prompt, as its role rendered it. */
  sent: Prompt;
  /** Its own tools but `answer`, as Pi takes them: each runs in the supervisor. */
  tools: { name: string; label: string; description: string; parameters: unknown }[];
  /** Where the MCP servers' tools go among them. */
  mcpAt: number;
  /** The MCP servers the run's kit gives the advisors, by name, and their tools. */
  mcp?: { servers: string[]; tools: McpToolInfo[] } | undefined;
  /** Its `answer` tool's parameters: the role's answer schema. */
  answerSchema: unknown;
  maxTurns?: number | undefined;
  timeoutS?: number | undefined;
}

/** The file in the call's folder that holds its spec. */
export const PI_ADVISOR_SPEC_FILE = "call.json";

/** The process's entry program (main.ts beside this file, or its build). */
export const PI_ADVISOR_MAIN = fileURLToPath(
  new URL(`./main${extname(fileURLToPath(import.meta.url))}`, import.meta.url),
);
