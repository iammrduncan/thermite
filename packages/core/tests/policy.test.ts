import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  ERROR_HTTP_STATUS,
  isThermiteError,
  isThermiteErrorCode,
  ThermiteError,
  type ThermiteErrorCode,
} from "../src/errors.ts";
import {
  type Capability,
  capabilityMatches,
  createGrantFromProfile,
  evaluatePolicy,
  POLICY_PROFILES,
  type PolicyGrant,
} from "../src/policy/index.ts";

const NOW = Date.parse("2026-11-28T12:00:00Z");
const FUTURE = "2026-11-28T13:00:00Z";
const PAST = "2026-11-28T11:59:59Z";

function collectSourceFiles(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (p.endsWith(".ts")) {
      out.push(p);
      continue;
    }
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, entry.name);
      if (entry.isDirectory()) out.push(...collectSourceFiles([full]));
      else if (entry.name.endsWith(".ts")) out.push(full);
    }
  }
  return out;
}

describe("static browser-safety & hygiene", () => {
  it("owned src files contain zero node:* imports and zero legacy topology terms", () => {
    const root = new URL("../src/", import.meta.url).pathname;
    const legacyTerm = new RegExp(`\\b${"ri"}gs?\\b`, "i");
    const files = collectSourceFiles([
      join(root, "errors.ts"),
      join(root, "client.ts"),
      join(root, "policy"),
      join(root, "api"),
    ]);
    assert.ok(files.length >= 11);

    for (const file of files) {
      const src = readFileSync(file, "utf8");
      assert.equal(/from\s+["']node:/.test(src), false, `${file} must not import node:* modules`);
      assert.equal(legacyTerm.test(src), false, `${file} must not reference legacy topology terms`);
    }
  });
});

describe("ThermiteError", () => {
  it("maps every error code to the expected HTTP status and serializes cleanly", () => {
    const expected: Record<ThermiteErrorCode, number> = {
      UNAUTHORIZED: 401,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      VALIDATION_ERROR: 400,
      CONFLICT: 409,
      RATE_LIMITED: 429,
      INTERNAL: 500,
    };

    for (const [code, status] of Object.entries(expected) as [ThermiteErrorCode, number][]) {
      assert.equal(ERROR_HTTP_STATUS[code], status);
      assert.equal(isThermiteErrorCode(code), true);

      const err = new ThermiteError(code, `msg-${code}`);
      assert.ok(err instanceof Error);
      assert.equal(isThermiteError(err), true);
      assert.equal(err.name, "ThermiteError");
      assert.equal(err.code, code);
      assert.equal(err.status, status);
      assert.deepEqual(err.toJSON(), { code, message: `msg-${code}`, status });
    }

    const withDetails = new ThermiteError("VALIDATION_ERROR", "bad field", { field: "yaml" });
    assert.deepEqual(withDetails.toJSON(), {
      code: "VALIDATION_ERROR",
      message: "bad field",
      status: 400,
      details: { field: "yaml" },
    });

    assert.equal(isThermiteError(new Error("plain")), false);
    assert.equal(isThermiteErrorCode("UNKNOWN"), false);
  });
});

describe("capabilityMatches", () => {
  it("handles exact, wildcard, namespace wildcard, and plugin:* safely", () => {
    assert.equal(capabilityMatches("*", "tokens:manage"), true);
    assert.equal(capabilityMatches("*", "live:toggle"), true);
    assert.equal(capabilityMatches("*", "*"), true);
    assert.equal(capabilityMatches("runs:*", "*"), false);
    assert.equal(capabilityMatches("plugin:*", "*"), false);

    assert.equal(capabilityMatches("runs:read", "runs:read"), true);
    assert.equal(capabilityMatches("runs:read", "runs:write"), false);

    assert.equal(capabilityMatches("runs:*", "runs:read"), true);
    assert.equal(capabilityMatches("runs:*", "runs:write"), true);
    assert.equal(capabilityMatches("runs:*", "runs:close"), true);
    assert.equal(capabilityMatches("runs:*", "attempts:rejudge"), false);
    assert.equal(capabilityMatches("runs:*", "runs_extra:read"), false);

    // plugin:* allows non-core plugin namespaces, never core namespaces
    assert.equal(capabilityMatches("plugin:*", "live:toggle"), true);
    assert.equal(capabilityMatches("plugin:*", "distill:export"), true);
    assert.equal(capabilityMatches("plugin:*", "git-sync:sync_now"), true);
    assert.equal(capabilityMatches("plugin:*", "plugins:manage"), false);
    assert.equal(capabilityMatches("plugin:*", "tokens:manage"), false);
    assert.equal(capabilityMatches("plugin:*", "runs:read"), false);
    assert.equal(capabilityMatches("plugin:*", "settings:write"), false);
    assert.equal(capabilityMatches("plugin:*", "plugin:anything"), false);

    // installedPluginPrefixes narrows plugin:*
    assert.equal(
      capabilityMatches("plugin:*", "live:toggle", { installedPluginPrefixes: ["live"] }),
      true,
    );
    assert.equal(
      capabilityMatches("plugin:*", "distill:export", { installedPluginPrefixes: ["live"] }),
      false,
    );
  });
});

describe("built-in policy profiles & evaluatePolicy", () => {
  const viewer = createGrantFromProfile({
    id: "g-viewer",
    label: "Viewer",
    profile: "viewer",
    grantedBy: "owner-1",
  });
  const operator = createGrantFromProfile({
    id: "g-op",
    label: "Operator",
    profile: "operator",
    grantedBy: "owner-1",
    extraCapabilities: ["distill:export"],
  });
  const delegate = createGrantFromProfile({
    id: "g-delegate",
    label: "External Orchestrator",
    profile: "autonomous_delegate",
    grantedBy: "owner-1",
  });
  const owner = createGrantFromProfile({
    id: "g-owner",
    label: "Owner",
    profile: "owner",
    grantedBy: "owner-1",
  });

  function check(grant: PolicyGrant | null, capability: Capability) {
    return evaluatePolicy(grant, { capability, principalId: "p-1" }, NOW);
  }

  it("enforces viewer read-only permissions", () => {
    assert.deepEqual(POLICY_PROFILES.viewer, ["runs:read", "compute:read", "settings:read"]);
    for (const cap of ["runs:read", "compute:read", "settings:read"] as const) {
      assert.equal(check(viewer, cap).ok, true, `viewer should allow ${cap}`);
    }
    for (const cap of [
      "runs:write",
      "runs:close",
      "attempts:rejudge",
      "attempts:invalidate",
      "promotions:approve",
      "needs:resolve",
      "compute:manage",
      "settings:write",
      "terminal:input",
      "plugins:manage",
      "tokens:manage",
      "live:toggle",
    ] as const) {
      const res = check(viewer, cap);
      assert.equal(res.ok, false, `viewer must deny ${cap}`);
      if (!res.ok) assert.equal(res.code, "FORBIDDEN");
    }
  });

  it("enforces operator permissions plus explicit plugin grants", () => {
    for (const cap of [
      "runs:read",
      "runs:write",
      "attempts:rejudge",
      "compute:read",
      "compute:manage",
      "settings:read",
      "distill:export",
    ] as const) {
      assert.equal(check(operator, cap).ok, true, `operator should allow ${cap}`);
    }
    for (const cap of [
      "runs:close",
      "attempts:invalidate",
      "promotions:approve",
      "needs:resolve",
      "settings:write",
      "terminal:input",
      "plugins:manage",
      "tokens:manage",
      "live:toggle",
    ] as const) {
      const res = check(operator, cap);
      assert.equal(res.ok, false, `operator must deny ${cap}`);
      if (!res.ok) assert.equal(res.code, "FORBIDDEN");
    }
  });

  it("grants autonomous_delegate 100% campaign/ops/plugin autonomy, excluding only plugins:manage and tokens:manage", () => {
    for (const cap of [
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
      "live:toggle",
      "distill:export",
      "git-sync:sync_now",
    ] as const) {
      const res = check(delegate, cap);
      assert.equal(res.ok, true, `autonomous_delegate should allow ${cap}`);
      if (res.ok) {
        assert.deepEqual(res.audit, {
          principalId: "p-1",
          principalKind: "delegated_agent",
          grantId: "g-delegate",
          capability: cap,
        });
        assert.deepEqual(res.actor, {
          principalId: "p-1",
          principalKind: "delegated_agent",
          grantId: "g-delegate",
        });
      }
    }

    for (const cap of ["plugins:manage", "tokens:manage"] as const) {
      const res = check(delegate, cap);
      assert.equal(res.ok, false, `autonomous_delegate must deny ${cap} by default`);
      if (!res.ok) assert.equal(res.code, "FORBIDDEN");
    }
  });

  it("grants owner full control and allows custom PolicyGrant to delegate plugins:manage and tokens:manage", () => {
    for (const cap of ["plugins:manage", "tokens:manage", "runs:close", "live:toggle"] as const) {
      assert.equal(check(owner, cap).ok, true);
    }

    // Zero hardcoded OWNER_ONLY_KINDS: custom delegated_agent grant can opt in
    const customAdminDelegate = createGrantFromProfile({
      id: "g-custom",
      label: "Custom Admin Delegate",
      profile: "autonomous_delegate",
      principalKind: "delegated_agent",
      grantedBy: "owner-1",
      extraCapabilities: ["plugins:manage", "tokens:manage"],
    });
    assert.equal(check(customAdminDelegate, "plugins:manage").ok, true);
    assert.equal(check(customAdminDelegate, "tokens:manage").ok, true);
  });

  it("structurally blocks run_worker and run_advisor regardless of grant or forged grant principalKind", () => {
    for (const callerKind of ["run_worker", "run_advisor"] as const) {
      const withOwner = evaluatePolicy(
        owner,
        { capability: "runs:read", principalId: "agent-1", callerKind },
        NOW,
      );
      assert.equal(withOwner.ok, false);
      if (!withOwner.ok) assert.equal(withOwner.code, "FORBIDDEN");

      const withNull = evaluatePolicy(
        null,
        { capability: "promotions:approve", principalId: "agent-1", callerKind },
        NOW,
      );
      assert.equal(withNull.ok, false);
      if (!withNull.ok) assert.equal(withNull.code, "FORBIDDEN");

      const forgedGrant = { ...owner, principalKind: callerKind } as unknown as PolicyGrant;
      const withForged = evaluatePolicy(
        forgedGrant,
        { capability: "runs:read", principalId: "agent-1" },
        NOW,
      );
      assert.equal(withForged.ok, false);
      if (!withForged.ok) assert.equal(withForged.code, "FORBIDDEN");
    }
  });

  it("enforces missing, revoked, and expired grants as UNAUTHORIZED", () => {
    const missing = evaluatePolicy(null, { capability: "runs:read", principalId: "p-1" }, NOW);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, "UNAUTHORIZED");

    const revoked = createGrantFromProfile({
      id: "g-rev",
      label: "Revoked",
      profile: "owner",
      grantedBy: "owner-1",
      revoked: true,
    });
    const revRes = check(revoked, "runs:read");
    assert.equal(revRes.ok, false);
    if (!revRes.ok) assert.equal(revRes.code, "UNAUTHORIZED");

    const expired = createGrantFromProfile({
      id: "g-exp",
      label: "Expired",
      profile: "owner",
      grantedBy: "owner-1",
      expiresAt: PAST,
    });
    const expRes = check(expired, "runs:read");
    assert.equal(expRes.ok, false);
    if (!expRes.ok) assert.equal(expRes.code, "UNAUTHORIZED");

    const exactBoundary = createGrantFromProfile({
      id: "g-now",
      label: "At boundary",
      profile: "owner",
      grantedBy: "owner-1",
      expiresAt: new Date(NOW).toISOString(),
    });
    const boundaryRes = check(exactBoundary, "runs:read");
    assert.equal(boundaryRes.ok, false);
    if (!boundaryRes.ok) assert.equal(boundaryRes.code, "UNAUTHORIZED");

    const active = createGrantFromProfile({
      id: "g-future",
      label: "Active",
      profile: "owner",
      grantedBy: "owner-1",
      expiresAt: FUTURE,
    });
    assert.equal(check(active, "runs:read").ok, true);

    const invalidDate = createGrantFromProfile({
      id: "g-bad-date",
      label: "Bad date",
      profile: "owner",
      grantedBy: "owner-1",
      expiresAt: "not-a-timestamp",
    });
    const badDateRes = check(invalidDate, "runs:read");
    assert.equal(badDateRes.ok, false);
    if (!badDateRes.ok) assert.equal(badDateRes.code, "UNAUTHORIZED");
  });

  it("enforces campaignId and runId scope restrictions", () => {
    const campaignScoped = createGrantFromProfile({
      id: "g-camp",
      label: "Campaign 1",
      profile: "autonomous_delegate",
      grantedBy: "owner-1",
      scope: { campaignIds: ["camp-1"] },
    });
    assert.equal(
      evaluatePolicy(
        campaignScoped,
        { capability: "runs:write", campaignId: "camp-1", principalId: "p-1" },
        NOW,
      ).ok,
      true,
    );
    const wrongCamp = evaluatePolicy(
      campaignScoped,
      { capability: "runs:write", campaignId: "camp-2", principalId: "p-1" },
      NOW,
    );
    assert.equal(wrongCamp.ok, false);
    if (!wrongCamp.ok) assert.equal(wrongCamp.code, "FORBIDDEN");

    const missingCamp = evaluatePolicy(
      campaignScoped,
      { capability: "runs:write", principalId: "p-1" },
      NOW,
    );
    assert.equal(missingCamp.ok, false);
    if (!missingCamp.ok) assert.equal(missingCamp.code, "FORBIDDEN");

    const runScoped = createGrantFromProfile({
      id: "g-run",
      label: "Run 1",
      profile: "autonomous_delegate",
      grantedBy: "owner-1",
      scope: { runIds: ["run-1"] },
    });
    assert.equal(
      evaluatePolicy(
        runScoped,
        { capability: "runs:close", runId: "run-1", principalId: "p-1" },
        NOW,
      ).ok,
      true,
    );
    const wrongRun = evaluatePolicy(
      runScoped,
      { capability: "runs:close", runId: "run-2", principalId: "p-1" },
      NOW,
    );
    assert.equal(wrongRun.ok, false);
    if (!wrongRun.ok) assert.equal(wrongRun.code, "FORBIDDEN");

    const bothScoped = createGrantFromProfile({
      id: "g-both",
      label: "Both",
      profile: "autonomous_delegate",
      grantedBy: "owner-1",
      scope: { campaignIds: ["camp-1"], runIds: ["run-1"] },
    });
    assert.equal(
      evaluatePolicy(
        bothScoped,
        { capability: "runs:read", campaignId: "camp-1", runId: "run-1", principalId: "p-1" },
        NOW,
      ).ok,
      true,
    );
    assert.equal(
      evaluatePolicy(
        bothScoped,
        { capability: "runs:read", runId: "run-1", principalId: "p-1" },
        NOW,
      ).ok,
      true,
    );
    assert.equal(
      evaluatePolicy(
        bothScoped,
        { capability: "runs:read", campaignId: "camp-2", runId: "run-1", principalId: "p-1" },
        NOW,
      ).ok,
      false,
    );
  });
});
