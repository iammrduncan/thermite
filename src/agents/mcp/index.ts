/**
 * The MCP servers a run's kit gives its agents (goal 068), as the agents reach them: the harness's
 * and the supervisor's gateway to the servers (gateway.ts), and the servers as each agent program
 * is given them: Pi's tools, and Claude Code's, OpenCode's and Codex's configuration (tools.ts).
 */

export { type McpCaller, McpGateway, type McpGatewayDeps, NOT_HANDED } from "./gateway.ts";
export {
  claudeMcpConfig,
  gatewayUrl,
  type McpAccess,
  type McpForAgent,
  mcpAgentTools,
  mcpLine,
  opencodeMcp,
  servedNames,
} from "./tools.ts";
