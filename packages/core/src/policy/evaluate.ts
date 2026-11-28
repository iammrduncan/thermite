import type * as T from "./types.ts";
import { CORE_CAPABILITY_PREFIXES, INTERNAL_PRINCIPAL_KINDS } from "./types.ts";

type DenyCode = "UNAUTHORIZED" | "FORBIDDEN";
type AccessOpts = T.CapabilityMatchOptions & {
  readonly callerKind?: T.PrincipalKind | T.InternalPrincipalKind;
};
const deny = (code: DenyCode, reason: string) => ({ ok: false as const, code, reason });

export const isInternalPrincipal = (kind: unknown): kind is T.InternalPrincipalKind =>
  typeof kind === "string" && (INTERNAL_PRINCIPAL_KINDS as readonly string[]).includes(kind);

export function capabilityMatches(
  granted: T.Capability,
  required: T.Capability,
  opts?: T.CapabilityMatchOptions,
): boolean {
  if (!granted || !required) return false;
  if (granted === "*") return true;
  if (required === "*") return false;
  if (granted === required) return true;
  const [gp, gv, gx] = granted.split(":");
  const [rp, rv, rx] = required.split(":");
  if (!gp || !rp || !rv || gx !== undefined || rx !== undefined || gv !== "*" || rv === "*")
    return false;
  if (gp !== "plugin") return gp === rp;
  const allowed = opts?.installedPluginPrefixes;
  return !CORE_CAPABILITY_PREFIXES.has(rp) && (!allowed || allowed.includes(rp));
}

export function isGrantActive(grant: T.PolicyGrant | null | undefined, nowMs: number) {
  if (!grant) return { ok: false as const, reason: "Missing policy grant." };
  if (grant.revoked) return { ok: false as const, reason: `Grant "${grant.id}" revoked.` };
  if (grant.expiresAt !== undefined) {
    const exp = Date.parse(grant.expiresAt);
    if (!Number.isFinite(exp) || exp <= nowMs)
      return { ok: false as const, reason: `Grant "${grant.id}" expired.` };
  }
  return { ok: true as const, grant };
}

export function checkPolicyAccess(
  grant: T.PolicyGrant | null | undefined,
  cap: T.Capability,
  nowMs: number,
  opts?: AccessOpts,
) {
  if (isInternalPrincipal(opts?.callerKind) || isInternalPrincipal(grant?.principalKind))
    return deny("FORBIDDEN", "Run-internal principals are excluded from the Door.");
  const active = isGrantActive(grant, nowMs);
  if (!active.ok) return deny("UNAUTHORIZED", active.reason);
  if (!active.grant.capabilities.some((c) => capabilityMatches(c, cap, opts)))
    return deny("FORBIDDEN", `Grant "${active.grant.id}" lacks "${cap}".`);
  return active;
}

export function evaluatePolicy(
  grant: T.PolicyGrant | null | undefined,
  req: T.PolicyRequest,
  nowMs: number,
  opts?: T.CapabilityMatchOptions,
): T.PolicyDecision {
  const aOpts = req.callerKind ? { ...opts, callerKind: req.callerKind } : opts;
  const access = checkPolicyAccess(grant, req.capability, nowMs, aOpts);
  if (!access.ok) return access;
  const { campaignIds: cs, runIds: rs } = access.grant.scope ?? {};
  const hasRun = rs !== undefined && req.runId !== undefined && rs.includes(req.runId);
  if (cs && req.campaignId !== undefined && !cs.includes(req.campaignId))
    return deny("FORBIDDEN", "Campaign out of scope.");
  if (rs && (req.runId === undefined || !hasRun)) return deny("FORBIDDEN", "Run out of scope.");
  if (cs && req.campaignId === undefined && !hasRun)
    return deny("FORBIDDEN", "Campaign scope required.");
  const g = access.grant;
  const actor = { principalId: req.principalId, principalKind: g.principalKind, grantId: g.id };
  return { ok: true, actor, audit: { ...actor, capability: req.capability } };
}
