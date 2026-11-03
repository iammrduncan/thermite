import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  SUPERVISOR_ISOLATION,
  type SupervisorIsolation,
} from "../../../src/core/api/harness/supervisor.ts";
import { createHarnessApi } from "../../../src/harness/api/index.ts";
import {
  type IsolationReport,
  isolationSummary,
  readSupervisorIsolation,
  SUPERVISOR_ISOLATION_FILE,
} from "../../../src/harness/selftest/index.ts";
import { makeHarnessEnv } from "../../helpers/harness-env.ts";

const tokens = { supervisor: "sup-token", proposer: "prop-token" };

/** What a supervisor whose advisor users are kept apart says, and one whose user read its inbox. */
const apart: SupervisorIsolation = {
  at: "2026-10-30T03:00:00.000Z",
  separated: true,
  probes: { "state-list": "EACCES", "harness-token": "EACCES", "supervisor-signal": "EPERM" },
};
const open: SupervisorIsolation = {
  ...apart,
  probes: { ...apart.probes, "inbox-list": "ALLOWED" },
};

describe("the supervisor's part of the isolation check", () => {
  test("the harness keeps the newest the supervisor gives it, from its token alone", async () => {
    const env = makeHarnessEnv();
    const api = createHarnessApi(env.service, tokens);
    const put = (body: unknown, token = tokens.supervisor) =>
      api.request(SUPERVISOR_ISOLATION.path, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const stateDir = env.service.paths.stateDir;
    assert.equal(readSupervisorIsolation(stateDir), undefined, "nothing said yet");
    assert.equal((await put(apart)).status, 200);
    assert.deepEqual(readSupervisorIsolation(stateDir), apart);
    assert.equal((await put(open)).status, 200);
    assert.deepEqual(readSupervisorIsolation(stateDir), open);
    // Another token, and a body the contract refuses, change nothing.
    assert.notEqual((await put(apart, tokens.proposer)).status, 200);
    assert.equal((await put({ ...apart, extra: 1 })).status, 400);
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p-${i}`, "EACCES"]));
    assert.equal((await put({ ...apart, probes: many })).status, 400);
    assert.deepEqual(readSupervisorIsolation(stateDir), open);
    // A file it can't take is as none.
    writeFileSync(join(stateDir, SUPERVISOR_ISOLATION_FILE), "{not json");
    assert.equal(readSupervisorIsolation(stateDir), undefined);
  });

  test("a probe of the supervisor's that got through fails the check, and the summary names it", () => {
    const report: IsolationReport = {
      ok: false,
      devices: "shared",
      roles: { builder: { ledger: "EACCES" } },
      supervisor: { at: open.at, probes: open.probes },
      skipped: [],
    };
    assert.equal(
      isolationSummary(report),
      "isolation does NOT hold (devices: shared): supervisor inbox-list: ALLOWED",
    );
  });
});
