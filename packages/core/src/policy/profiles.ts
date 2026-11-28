import type { Capability, PolicyGrant, PolicyProfileName, PrincipalKind } from "./types.ts";

const VIEWER: readonly Capability[] = ["runs:read", "compute:read", "settings:read"];

export const POLICY_PROFILES: Readonly<Record<PolicyProfileName, readonly Capability[]>> = {
  viewer: VIEWER,
  operator: [...VIEWER, "runs:write", "attempts:rejudge", "compute:manage"],
  autonomous_delegate: [
    "runs:*",
    "attempts:*",
    "promotions:approve",
    "needs:resolve",
    "compute:*",
    "settings:*",
    "terminal:input",
    "plugin:*",
  ],
  owner: ["*"],
};

export type CreateGrantFromProfileInput = Omit<PolicyGrant, "principalKind" | "capabilities"> & {
  readonly profile: PolicyProfileName;
  readonly principalKind?: PrincipalKind;
  readonly extraCapabilities?: readonly Capability[];
};

const KIND: Record<PolicyProfileName, PrincipalKind> = {
  viewer: "operator_token",
  operator: "operator_token",
  autonomous_delegate: "delegated_agent",
  owner: "owner_session",
};

export function createGrantFromProfile(input: CreateGrantFromProfileInput): PolicyGrant {
  const { profile, principalKind, extraCapabilities: extra, ...rest } = input;
  const base = POLICY_PROFILES[profile];
  const capabilities = extra?.length ? [...new Set<Capability>([...base, ...extra])] : [...base];
  return { ...rest, principalKind: principalKind ?? KIND[profile], capabilities };
}
