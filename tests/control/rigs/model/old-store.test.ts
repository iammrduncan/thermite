import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { ControlStore } from "../../../../src/control/store/index.ts";

/** A store from before goal 074: its advisors' roles under their new names, opened once. */

describe("a store from before goal 074", () => {
  test("its combiner and panel take their new names, and its teachers' model stays two teachers", () => {
    const path = join(mkdtempSync(join(tmpdir(), "thermite-roles-")), "control.db");
    const old = new DatabaseSync(path);
    old.exec(`create table rig_role_model (
        rig text not null,
        role text not null check (role in ('planner', 'teachers', 'combiner', 'auditor', 'panel')),
        provider text not null, model text not null, effort text, assigned_at text not null,
        primary key (rig, role));
      insert into rig_role_model values ('rig-a', 'teachers', 'lab', 'wide-model', 'high', '2026-10-20');
      insert into rig_role_model values ('rig-a', 'combiner', 'lab', 'strong-model', null, '2026-10-20');
      insert into rig_role_model values ('rig-a', 'panel', 'lab', 'wide-model', null, '2026-10-20');
      insert into rig_role_model values ('rig-a', 'auditor', 'lab', 'strong-model', null, '2026-10-20');
      insert into rig_role_model values ('rig-b', 'combiner', 'lab', 'strong-model', null, '2026-10-20');`);
    old.close();
    const store = new ControlStore(path);
    const roles = store.agentModels.byRole("rig-a");
    assert.deepEqual(Object.keys(roles).sort(), [
      "auditor",
      "merged_by",
      "review_panel",
      "second_teacher",
      "teachers",
    ]);
    assert.deepEqual(
      [roles.teachers?.model, roles.second_teacher?.model, roles.second_teacher?.effort],
      ["wide-model", "wide-model", "high"],
    );
    assert.equal(roles.merged_by?.model, "strong-model");
    assert.equal(roles.review_panel?.model, "wide-model");
    assert.deepEqual(Object.keys(store.agentModels.byRole("rig-b")), ["merged_by"]);
    // The new roles are taken, the old ones refused, and the columns of goals 070 and 073 kept.
    store.modelProviders.put({
      name: "lab",
      type: "openai",
      base_url: "https://models.example.com/v1",
      key: { sealed: "sealed-for-tests", hint: "…ests" },
    });
    store.agentModels.assignRole("rig-b", "second_teacher", {
      provider: "lab",
      model: "wide-model",
      harness: "codex",
      contextCap: 8192,
      compactAt: 70,
    });
    assert.deepEqual(store.agentModels.byRole("rig-b").second_teacher, {
      provider: "lab",
      model: "wide-model",
      effort: null,
      harness: "codex",
      contextCap: 8192,
      compactAt: 70,
    });
    assert.throws(() =>
      store.db
        .prepare(
          "insert into rig_role_model (rig, role, provider, model, assigned_at) values ('rig-c', 'combiner', 'lab', 'm', 'now')",
        )
        .run(),
    );
    // Opened again: nothing changes twice.
    store.db.close();
    const again = new ControlStore(path);
    assert.deepEqual(again.agentModels.byRole("rig-a"), roles);
  });
});
