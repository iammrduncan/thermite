/**
 * The advisors' read-only tools: a run's code and evidence (code.ts), its own research
 * (research.ts) and the final writer's checks (paper.ts), each a tool of a call in Pi; and, for an
 * advisor in Claude Code, OpenCode or the Codex CLI, the server that gives them, with the
 * knowledge base's tools, over MCP on localhost for one call (mcp.ts).
 */

export {
  type AdvisorCode,
  CODE_TOOL_NAMES,
  CODE_TOOLS,
  runCodeTool,
  toolText,
} from "./code.ts";
export { type AdvisorKb, type AdvisorServers, serveAdvisorTools } from "./mcp.ts";
export { type AdvisorPaper, PAPER_TOOL_NAMES, PAPER_TOOLS, runPaperTool } from "./paper.ts";
export {
  type AdvisorResearch,
  RESEARCH_TOOL_NAMES,
  RESEARCH_TOOLS,
  runResearchTool,
} from "./research.ts";
