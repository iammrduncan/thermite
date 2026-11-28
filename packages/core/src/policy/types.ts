export const CORE_CAPABILITIES = [
  "runs:read",
  "runs:write",
  "runs:close",
  "attempts:rejudge",
  "attempts:invalidate",
  "promotions:approve",
  "needs:resolve",
  "compute:read",
  "compute:manage",
  "settings:read",
  "settings:write",
  "terminal:input",
  "plugins:manage",
  "tokens:manage",
  "*",
] as const;
export type CoreCapability = (typeof CORE_CAPABILITIES)[number];
export type Capability = CoreCapability | `${string}:${string}`;
export const CORE_CAPABILITY_PREFIXES: ReadonlySet<string> = new Set(
  "runs attempts promotions needs compute settings terminal plugins tokens plugin".split(" "),
);
export const PRINCIPAL_KINDS = [
  "owner_session",
  "delegated_agent",
  "operator_token",
  "ci_token",
] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];
export const INTERNAL_PRINCIPAL_KINDS = ["run_worker", "run_advisor"] as const;
export type InternalPrincipalKind = (typeof INTERNAL_PRINCIPAL_KINDS)[number];
export const POLICY_PROFILE_NAMES = ["viewer", "operator", "autonomous_delegate", "owner"] as const;
export type PolicyProfileName = (typeof POLICY_PROFILE_NAMES)[number];
export type ActorRef = {
  readonly principalId: string;
  readonly principalKind: PrincipalKind | "system";
  readonly grantId?: string;
};
export type PolicyScope = {
  readonly campaignIds?: readonly string[];
  readonly runIds?: readonly string[];
};
export type CapabilityMatchOptions = { readonly installedPluginPrefixes?: readonly string[] };
export type PolicyGrant = {
  readonly id: string;
  readonly label: string;
  readonly principalKind: PrincipalKind;
  readonly capabilities: readonly Capability[];
  readonly scope?: PolicyScope;
  readonly grantedBy: string;
  readonly expiresAt?: string;
  readonly revoked?: boolean;
};
export type PolicyRequest = {
  readonly capability: Capability;
  readonly campaignId?: string;
  readonly runId?: string;
  readonly principalId: string;
  readonly callerKind?: PrincipalKind | InternalPrincipalKind;
};
export type PolicyAudit = {
  readonly principalId: string;
  readonly principalKind: PrincipalKind;
  readonly grantId: string;
  readonly capability: Capability;
};
export type PolicyDecision =
  | { readonly ok: true; readonly audit: PolicyAudit; readonly actor: ActorRef }
  | { readonly ok: false; readonly code: "UNAUTHORIZED" | "FORBIDDEN"; readonly reason: string };
