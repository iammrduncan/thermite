import { readFileSync } from "node:fs";
import { cleanMcpError, headerSecrets, mcpConnect } from "../../../common/mcp-client.ts";
import type { AdvisorTools } from "../call.ts";
import type { AdvisorsConfig } from "../config.ts";

/**
 * One knowledge base's search over MCP, read only; the token is a bearer header, never in the
 * URL. The connection and the call each have mcpConnect's time limits (MCP_TIMEOUT_MS): past one,
 * the search fails, the advisor is told so, and its call goes on.
 */
function mcpSearch(url: string, token: () => string, tool: string) {
  const connect = mcpConnect(undefined, "thermite-supervisor");
  return async (query: string) => {
    const headers = { authorization: `Bearer ${token()}` };
    try {
      const session = await connect(url, headers);
      try {
        return (await session.callTool(tool, { query })).content;
      } finally {
        await session.close();
      }
    } catch (err) {
      throw new Error(cleanMcpError(err, headerSecrets(headers)));
    }
  };
}

/** The knowledge-base search of the advisors file's own `kb`, read only; none without one. */
export function kbSearchFor(cfg: Pick<AdvisorsConfig, "kb">): AdvisorTools["kbSearch"] {
  const kb = cfg.kb;
  return kb
    ? mcpSearch(kb.mcp_url, () => readFileSync(kb.token_file, "utf8").trim(), kb.tool)
    : undefined;
}
