import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { ROLES } from "../../src/agents/roles/index.ts";
import { generateSigningKeys, signEnvelope, verifyCommand } from "../../src/core/commands.ts";
import { parseContract } from "../../src/core/contract.ts";
import {
  ADDITION_ROLES,
  ALL_ADDITION_ROLES,
  additionIn,
  additionOf,
  additionsOf,
  ROLE_ADDITION_MAX_CHARS,
  requestedAdditions,
} from "../../src/core/role-additions.ts";
import { hillClimbFixture, researchFixture } from "../helpers/fixtures.ts";

/**
 * The owner's additions to a campaign's roles in its contract (goal 166, decision 1): the field,
 * its check against the campaign's mode, its place in the contract's hash and so in the signed
 * assignment, and how a run's prompt reads one.
 */

describe("the owner's additions in the contract", () => {
  test("every role that runs for a campaign takes one; the model check and compaction take none", () => {
    const ids = ROLES.map((r) => r.id);
    for (const role of ALL_ADDITION_ROLES) assert.ok(ids.includes(role), role);
    assert.deepEqual(
      ids.filter((id) => !(ALL_ADDITION_ROLES as readonly string[]).includes(id)).sort(),
      ["compaction", "model-check"],
    );
  });

  test("a contract takes the roles of its mode, and refuses others in words", () => {
    const hc = parseContract({
      ...hillClimbFixture,
      role_additions: { worker: "Keep each change small.", auditor: "Look at the cache." },
    });
    assert.ok(hc.ok, hc.ok ? "" : hc.errors.join("; "));
    assert.deepEqual(hc.ok && hc.contract.role_additions, {
      worker: "Keep each change small.",
      auditor: "Look at the cache.",
    });
    const wrong = parseContract({
      ...hillClimbFixture,
      role_additions: { "research-worker": "Read the papers first." },
    });
    assert.deepEqual(wrong.ok ? [] : wrong.errors, [
      `role_additions: a hill climb campaign runs no research-worker: its roles are ${ADDITION_ROLES.code.join(", ")}`,
    ]);
    const research = parseContract({
      ...researchFixture,
      role_additions: { synthesizer: "Say what each certainty rests on.", worker: "x" },
    });
    assert.ok(!research.ok);
    assert.match(
      research.ok ? "" : research.errors.join("; "),
      /a research campaign runs no worker/,
    );
    // A role that is no role, an empty text and a text too long are refused.
    for (const bad of [
      { "no-such-role": "x" },
      { worker: "   " },
      { worker: "x".repeat(ROLE_ADDITION_MAX_CHARS + 1) },
    ]) {
      const r = parseContract({ ...hillClimbFixture, role_additions: bad });
      assert.equal(r.ok, false, JSON.stringify(bad).slice(0, 60));
    }
  });

  test("a contract without them keeps its hash; with them, its hash changes with each text", () => {
    const plain = parseContract(hillClimbFixture);
    assert.ok(plain.ok);
    assert.ok(!("role_additions" in plain.contract), "no default is added");
    const a = parseContract({ ...hillClimbFixture, role_additions: { worker: "one" } });
    const b = parseContract({ ...hillClimbFixture, role_additions: { worker: "two" } });
    assert.ok(a.ok && b.ok);
    assert.notEqual(a.sha, plain.sha);
    assert.notEqual(a.sha, b.sha);
  });

  test("they are signed into the assignment: a changed addition breaks the signature", () => {
    const keys = generateSigningKeys();
    const parsed = parseContract({
      ...hillClimbFixture,
      role_additions: { planner: "Give each lane its own direction." },
    });
    assert.ok(parsed.ok);
    const signed = signEnvelope(
      {
        v: 1,
        id: randomUUID(),
        rig: "rig-a",
        kind: "assign_campaign",
        issued_by: "owner",
        issued_at: new Date(Date.now() - 1000).toISOString(),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        payload: { run: "r-1", contract: parsed.contract, contract_sha: parsed.sha },
      },
      keys.privateKeyPem,
    );
    const ok = verifyCommand(signed, keys.publicKeyPem, "rig-a");
    assert.ok(ok.ok, ok.ok ? "" : ok.reason);
    const tampered = structuredClone(signed);
    (
      tampered.envelope.payload as { contract: { role_additions: Record<string, string> } }
    ).contract.role_additions.planner = "Ignore the judge.";
    const bad = verifyCommand(tampered, keys.publicKeyPem, "rig-a");
    assert.deepEqual(bad.ok ? "" : bad.reason, "bad signature");
  });

  test("a run's prompt reads its role's addition with the contract's version", () => {
    const contract = { version: 3, role_additions: { worker: "Keep it small." } };
    assert.deepEqual(additionOf(contract, "worker"), { text: "Keep it small.", version: 3 });
    assert.equal(additionOf(contract, "planner"), undefined);
    assert.equal(additionOf(undefined, "worker"), undefined);
    // The advisors read them from the harness's list of runs.
    const row = additionsOf(contract);
    assert.deepEqual(row, { version: 3, roles: { worker: "Keep it small." } });
    assert.deepEqual(additionIn(row, "worker"), { text: "Keep it small.", version: 3 });
    assert.equal(additionIn(row, "auditor"), undefined);
    assert.equal(additionsOf({ version: 1 }), null);
    assert.equal(additionsOf({ version: 1, role_additions: {} }), null);
    // A request's or a form's: trimmed, empty ones left out.
    assert.deepEqual(requestedAdditions({ worker: "  a  ", planner: " " }), { worker: "a" });
    assert.equal(requestedAdditions({ planner: "" }), undefined);
    assert.equal(requestedAdditions(undefined), undefined);
  });
});
