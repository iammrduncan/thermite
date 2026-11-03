import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { ControlStore } from "../../../../src/control/store/index.ts";

/**
 * A store from before goal 074, with the advisors' roles under their old names: from before
 * v0.1.0, so control refuses it in words and keeps it as it is (goal 125, the owner's answer of
 * 2026-10-31: only a store v0.1.0 wrote is upgraded).
 */

describe("a store from before goal 074", () => {
  test("is refused in words, and kept as it is", () => {
    const path = join(mkdtempSync(join(tmpdir(), "thermite-roles-")), "control.db");
    const old = new DatabaseSync(path);
    old.exec(`create table rig_role_model (
        rig text not null,
        role text not null check (role in ('planner', 'teachers', 'combiner', 'auditor', 'panel')),
        provider text not null, model text not null, effort text, assigned_at text not null,
        primary key (rig, role));
      insert into rig_role_model values ('rig-a', 'combiner', 'lab', 'strong-model', null, '2026-10-20');`);
    old.close();
    const contents = () => {
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        return {
          tables: db
            .prepare("select name from sqlite_master where type = 'table' order by name")
            .all(),
          rows: db.prepare("select * from rig_role_model").all(),
        };
      } finally {
        db.close();
      }
    };
    const before = contents();
    assert.throws(() => new ControlStore(path), /from before v0\.1\.0/);
    // Its tables and rows as they were: SQLite may rewrite its own header on open, never the data.
    assert.deepEqual(contents(), before);
  });
});
