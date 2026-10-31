import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { ROLES, roleOf } from "../../../src/agents/roles/index.ts";

const rolesDir = new URL("../../../src/agents/roles/", import.meta.url);

test("each role has a unique id, a name, what it does and at least one text", () => {
  const ids = ROLES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const r of ROLES) {
    assert.ok(r.name && r.what && r.model && r.programs.length, r.id);
    assert.ok(r.texts.length > 0, r.id);
    const textIds = r.texts.map((x) => x.id);
    assert.equal(new Set(textIds).size, textIds.length, r.id);
    for (const x of r.texts) assert.ok(x.text.trim().length > 0, `${r.id}/${x.id}`);
    assert.equal(roleOf(r.id), r);
  }
  assert.equal(roleOf("no-such-role"), undefined);
});

// A role's module may hold parts that its whole texts are built from: its task, shared by its
// two systems, and the guides every advisor shares. Every other text it exports is in the table.
const PARTS = /(^|_)TASK$|^ADVISOR_NOTES$|_GUIDE$/;

test("every text a role module exports is in the table, so none is left out of the docs", async () => {
  const listed = new Set(ROLES.flatMap((r) => r.texts.map((x) => x.text)));
  for (const file of readdirSync(rolesDir).filter((f) => f.endsWith(".ts") && f !== "index.ts")) {
    const mod: Record<string, unknown> = await import(new URL(file, rolesDir).href);
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== "string" || PARTS.test(name)) continue;
      assert.ok(listed.has(value), `${file}: ${name} is not in ROLES`);
    }
  }
});
