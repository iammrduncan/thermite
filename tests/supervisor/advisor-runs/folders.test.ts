import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { prepareSupervisorFolders } from "../../../src/supervisor/advisor-runs/index.ts";

/**
 * What root closes and makes before the supervisor starts, here with the test's own user in each
 * role (root's, the supervisor's): the modes are the image's; the owners need root.
 */

const me = {
  root: process.getuid?.() ?? 0,
  uid: process.getuid?.() ?? 0,
  gid: process.getgid?.() ?? 0,
};
const mode = (p: string) => statSync(p).mode & 0o7777;

function tree() {
  const base = mkdtempSync(join(tmpdir(), "thermite-supervisor-folders-"));
  after(() => rmSync(base, { recursive: true, force: true }));
  const p = (...parts: string[]) => join(base, ...parts);
  mkdirSync(p("secrets"), { mode: 0o755 });
  mkdirSync(p("state"), { mode: 0o755 });
  mkdirSync(p("runs", "left-by-a-crash"), { recursive: true });
  return {
    p,
    folders: {
      closed: [p("secrets"), p("not-mounted")],
      inboxParent: p("supervisor"),
      inbox: p("supervisor", "inbox"),
      own: [p("state"), p("results")],
      runs: p("runs"),
      socketDir: p("run", "thermite-advisors"),
    },
  };
}

describe("the supervisor's folders, closed to the advisor users at start", () => {
  test("root's folders and the inbox's are closed to others; the supervisor's are its own; the runs' root is new", () => {
    const { p, folders } = tree();
    const done = prepareSupervisorFolders(folders, me);
    assert.equal(mode(p("secrets")), 0o750);
    assert.equal(existsSync(p("not-mounted")), false, "a folder nothing is mounted in is left out");
    assert.equal(mode(p("supervisor")), 0o750);
    assert.equal(mode(p("state")), 0o700);
    assert.equal(existsSync(p("results")), false);
    // The advisor users pass through the runs' root to their own folders, listing nothing; what
    // an earlier start left there is gone.
    assert.equal(mode(p("runs")), 0o711);
    assert.equal(existsSync(p("runs", "left-by-a-crash")), false);
    assert.equal(mode(p("run", "thermite-advisors")), 0o750);
    assert.ok(done.some((d) => d.includes("0700")));
  });

  test("an inbox the supervisor may write keeps its modes; one outside the closed folder is said", () => {
    const { p, folders } = tree();
    // Compose's folder from the host, open to every user inside the closed parent.
    mkdirSync(p("supervisor", "inbox"), { recursive: true });
    chmodSync(p("supervisor", "inbox"), 0o777);
    writeFileSync(p("supervisor", "inbox", "kit.bundle"), "x");
    prepareSupervisorFolders(folders, me);
    assert.equal(mode(p("supervisor", "inbox")), 0o777);
    assert.equal(mode(p("supervisor")), 0o750);
    const elsewhere = prepareSupervisorFolders({ ...folders, inbox: p("inbox") }, me);
    assert.ok(elsewhere.some((d) => d.startsWith(`${p("inbox")}: NOT in`)));
  });
});
