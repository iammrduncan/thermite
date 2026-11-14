import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BUDGETS, overBudget } from "../../scripts/acceptance/lib/browser-budget.mjs";

/**
 * The budget of a screen's first view (goal 243), which the browser check holds every screen of
 * the app to. The counting itself runs in a browser: the check proves it there, on a made-up
 * screen that is over its budget (scripts/acceptance/lib/browser-app.mjs).
 */
describe("a screen's budget", () => {
  const within = {
    height: 640,
    words: 120,
    blocks: 2,
    tables: 0,
    controls: 4,
    buttons: 1,
    links: 2,
  };

  test("passes a screen that is within its kind's budget", () => {
    assert.deepEqual(overBudget("form", within), []);
    const form = BUDGETS.form;
    assert.ok(form);
    assert.deepEqual(overBudget("form", form), [], "at the budget is within it");
  });

  test("fails a screen that is over it, and says by how much", () => {
    assert.deepEqual(overBudget("form", { ...within, words: 260, controls: 9 }), [
      "260 words, and a form screen may have 200",
      "9 form controls, and a form screen may have 7",
    ]);
    assert.deepEqual(overBudget("dialog", { ...within, controls: 2, buttons: 3 }), [
      "640 pixels high, and a dialog screen may have 400",
      "120 words, and a dialog screen may have 60",
      "2 blocks, and a dialog screen may have 1",
      "3 buttons, and a dialog screen may have 2",
      "2 links, and a dialog screen may have 1",
    ]);
  });

  test("holds the height at a desk's width only", () => {
    const tall = { ...within, height: 2400 };
    assert.deepEqual(overBudget("form", tall), [
      "2400 pixels high, and a form screen may have 900",
    ]);
    assert.deepEqual(overBudget("form", tall, { height: false }), []);
  });

  test("refuses a kind that is not one of the rules'", () => {
    const said = overBudget("dashboard", within);
    assert.equal(said.length, 1);
    assert.match(
      said[0] ?? "",
      /"dashboard" is no kind of screen: one of home, list, detail, form/,
    );
  });

  test("has the seven kinds of the rules", () => {
    assert.deepEqual(Object.keys(BUDGETS), [
      "home",
      "list",
      "detail",
      "form",
      "dialog",
      "explore",
      "tool",
    ]);
  });
});
