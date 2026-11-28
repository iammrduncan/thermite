import type { z } from "zod";
import type * as P from "../policy/index.ts";

type Z = z.ZodType;
export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";
export type ActionScope = { readonly campaignId?: string; readonly runId?: string };
export type ActionDef<N extends string = string, I extends Z = Z, O extends Z = Z> = {
  readonly name: N;
  readonly summary: string;
  readonly capability: P.Capability;
  readonly idempotent?: boolean;
  readonly http: { readonly method: HttpMethod; readonly path: string };
  readonly mcp?: {
    readonly tool?: string;
    readonly readOnly?: boolean;
    readonly destructive?: boolean;
  };
  readonly cli?: { readonly path?: string; readonly alias?: string };
  readonly input: I;
  readonly output: O;
  extractScope?(input: z.output<I>): ActionScope;
};
export type DoorAuditEntry = P.PolicyAudit & { readonly action: string; readonly at: number };
export type DoorContext = {
  readonly action: string;
  readonly actor: P.ActorRef;
  readonly audit: P.PolicyAudit;
  readonly grant: P.PolicyGrant;
  readonly nowMs: number;
};
export type DoorAuth = {
  readonly principalId: string;
  readonly grant: P.PolicyGrant | null;
  readonly callerKind?: P.PrincipalKind | P.InternalPrincipalKind;
  readonly nowMs: number;
};
export type ActionHandler<I extends Z = Z, O extends Z = Z> = (
  input: z.output<I>,
  ctx: DoorContext,
) => z.output<O> | Promise<z.output<O>>;
export type PluginActionBinding<N extends string = string, I extends Z = Z, O extends Z = Z> = {
  readonly def: ActionDef<N, I, O>;
  handler(input: z.output<I>, ctx: DoorContext): z.output<O> | Promise<z.output<O>>;
};
export const defineAction = <const N extends string, I extends Z, O extends Z>(
  def: ActionDef<N, I, O>,
) => def;
export const definePluginAction = <const N extends string, I extends Z, O extends Z>(
  def: ActionDef<N, I, O>,
  handler: ActionHandler<I, O>,
): PluginActionBinding<N, I, O> => ({ def, handler });
