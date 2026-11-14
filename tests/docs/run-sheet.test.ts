import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

/**
 * v0.3.0's run sheet says where each step stands, in the column State of its table "The whole
 * way". The goal files hold the detail; this holds the two together, so the sheet never says
 * a step is done that its goal does not, or the other way round.
 */
const PLAN = join(import.meta.dirname, "..", "..", "docs", "plan");
const STATES = ["Not started", "Building", "Built, waits for your look", "Done"];

type Step = { step: number; goal: string; state: string; date: string | null };

function steps(): Step[] {
  const lines = readFileSync(join(PLAN, "v030_release_plan.md"), "utf8").split("\n");
  const head = lines.findIndex((line) => line.startsWith("| Step | What is built | Goal |"));
  assert.ok(head >= 0, "the run sheet has its table of steps");
  const columns = (lines[head] ?? "").split("|").map((cell) => cell.trim());
  const goalAt = columns.indexOf("Goal");
  const stateAt = columns.indexOf("State");
  assert.ok(stateAt > 0, "the table of steps has a column State");
  const out: Step[] = [];
  for (const line of lines.slice(head + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line.split("|").map((cell) => cell.trim());
    if (!/^\d+$/.test(cells[1] ?? "")) continue; // a section's title row
    const said = cells[stateAt] ?? "";
    const dated = /^(.*), (\d{4}-\d{2}-\d{2})$/.exec(said);
    out.push({
      step: Number(cells[1]),
      goal: cells[goalAt] ?? "",
      state: dated?.[1] ?? said,
      date: dated?.[2] ?? null,
    });
  }
  return out;
}

/** A goal's status and whether its file is among the completed ones, by its number. */
function goal(id: string): { status: string; completed: boolean } {
  for (const [folder, completed] of [
    ["goals", false],
    [join("goals", "_completed"), true],
  ] as const) {
    const dir = join(PLAN, folder);
    if (!existsSync(dir)) continue;
    const file = readdirSync(dir).find(
      (name) => name.startsWith(`${id}-`) && name.endsWith(".goal"),
    );
    if (!file) continue;
    const status = /^status: (\S+)$/m.exec(readFileSync(join(dir, file), "utf8"));
    assert.ok(status, `goal ${id} has a status`);
    return { status: status[1] ?? "", completed };
  }
  throw new Error(`the run sheet names goal ${id}, and no goal file has that number`);
}

describe("v0.3.0's run sheet", () => {
  const all = steps();

  test("gives every step one of the four states, and a date once it has started", () => {
    assert.deepEqual(
      all.map((s) => s.step),
      Array.from({ length: all.length }, (_, i) => i + 1),
      "the steps are numbered in order",
    );
    assert.ok(all.length >= 35, "the table holds every step");
    for (const s of all) {
      assert.ok(
        STATES.includes(s.state),
        `step ${s.step} says "${s.state}": one of ${STATES.join("; ")}`,
      );
      if (s.state === "Not started")
        assert.equal(s.date, null, `step ${s.step} has not started, so it has no date`);
      else
        assert.ok(
          s.date,
          `step ${s.step} is "${s.state}": give the date it became so, as ", YYYY-MM-DD"`,
        );
    }
  });

  test("agrees with the goal of each step that is a whole goal", () => {
    // A step that is a part of a goal ("parts of 254 and 256", "275, in parts") is not held here:
    // its goal stays open after the step is done.
    for (const s of all.filter((s) => /^\d+$/.test(s.goal))) {
      const g = goal(s.goal);
      const verified = g.status === "VERIFIED" && g.completed;
      assert.equal(
        s.state === "Done",
        verified,
        `step ${s.step} says "${s.state}", and goal ${s.goal} is ${g.status}${g.completed ? " in _completed" : ""}: ` +
          "a step is Done exactly when its goal is VERIFIED and moved, in the same commit",
      );
      if (s.state === "Building" || s.state === "Built, waits for your look") {
        assert.equal(
          g.status,
          "IN_PROGRESS",
          `step ${s.step} says "${s.state}", so goal ${s.goal} is IN_PROGRESS`,
        );
      }
    }
  });
});
