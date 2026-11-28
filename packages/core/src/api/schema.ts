import { z } from "zod";
import type * as P from "../policy/index.ts";
import { capabilityMatches, isGrantActive, isInternalPrincipal } from "../policy/index.ts";
import type { ActionDef } from "./types.ts";

export type JsonSchema = Record<string, unknown>;
export type McpToolAnnotations = {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
};
export type McpToolDescriptor = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly annotations: McpToolAnnotations;
};
export type CompileMcpOptions = P.CapabilityMatchOptions & {
  readonly callerKind?: P.PrincipalKind | P.InternalPrincipalKind;
};
export const actionToJsonSchema = (d: ActionDef) => z.toJSONSchema(d.input) as JsonSchema;
export const mcpToolName = (d: ActionDef) => d.mcp?.tool ?? d.name.replaceAll(".", "_");
export const cliCommandPath = (d: ActionDef) =>
  d.cli?.path ?? `thermite ${d.name.replaceAll(".", " ")}`;

export function compileMcpTools(
  actions: readonly ActionDef[],
  grant: P.PolicyGrant | null | undefined,
  nowMs: number,
  opts?: CompileMcpOptions,
): McpToolDescriptor[] {
  if (isInternalPrincipal(opts?.callerKind) || isInternalPrincipal(grant?.principalKind)) return [];
  const active = isGrantActive(grant, nowMs);
  if (!active.ok) return [];
  return actions
    .filter((d) => active.grant.capabilities.some((c) => capabilityMatches(c, d.capability, opts)))
    .map((d) => ({
      name: mcpToolName(d),
      description: d.summary,
      inputSchema: actionToJsonSchema(d),
      annotations: {
        ...(d.mcp?.readOnly !== undefined ? { readOnlyHint: d.mcp.readOnly } : {}),
        ...(d.mcp?.destructive !== undefined ? { destructiveHint: d.mcp.destructive } : {}),
        ...(d.idempotent !== undefined ? { idempotentHint: d.idempotent } : {}),
      },
    }));
}
