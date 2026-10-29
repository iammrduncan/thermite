import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { CampaignDraft } from "../../src/control/campaigns/builder.ts";
import { assignRefusal } from "../../src/control/issue/index.ts";
import { CommandPayloads, MESSAGE_TARGET } from "../../src/core/commands.ts";
import {
  LANE_PROCESSES,
  laneLimits,
  MAX_LANES,
  MAX_LANES_REASON,
  parseContract,
} from "../../src/core/contract.ts";
import { CHECK_ROLE, PLANNER_ROLE } from "../../src/harness/agents/cli/common.ts";
import { IDS, RoleSchema, RunRequest, roleIds } from "../../src/harness/broker/runner.ts";
import { ALL_ROLES, nprocFor } from "../../src/harness/broker/server.ts";
import { lanesFromEnv } from "../../src/harness/rig-settings.ts";
import { probedRoles } from "../../src/harness/selftest/index.ts";

/** A small valid research contract with the given lane count. */
const research = (count: number) => ({
  schema_version: 1,
  campaign: "lanes-check",
  version: 1,
  title: "Lanes",
  mode: "research",
  project: { repo: "notes" },
  topic: "t",
  questions: ["q"],
  min_duration: "30m",
  lanes: { count, trials_per_epoch: 1 },
});

describe("the most lanes a rig runs", () => {
  test("the harness image has a user for each lane, and no more", () => {
    const file = readFileSync(new URL("../../containers/harness/Containerfile", import.meta.url));
    const loop =
      /for n in \$\(seq 1 (\d+)\); do\s*\\\s*groupadd -g \$\(\(10100 \+ n\)\) lane-\$n/.exec(
        String(file),
      );
    assert.ok(loop, "the Containerfile's loop that makes the lane users");
    assert.equal(Number(loop[1]), MAX_LANES);
    assert.equal(IDS.maxLanes, MAX_LANES);
  });

  test("at the most lanes, no two roles share a user, and the image makes each with its ids", () => {
    // Every run ends by killing its user's processes: a shared user lets one role's cleanup
    // kill another's work (lane 16's worker and the planner once shared agent-16).
    assert.equal(MAX_LANES, 16);
    const roles = [...ALL_ROLES];
    for (const r of [PLANNER_ROLE, CHECK_ROLE]) assert.ok(roles.includes(r), r);
    for (let n = 1; n <= MAX_LANES; n++)
      for (const r of [`lane-${n}`, `lane-${n}-dev`, `agent-${n}`]) assert.ok(roles.includes(r), r);
    const owners = new Map<number, string>([
      [IDS.thermite.uid, "thermite"],
      [IDS.supervisor.uid, "supervisor"],
    ]);
    for (const role of roles) {
      const { uid } = roleIds(role);
      assert.equal(owners.get(uid), undefined, `${role} shares uid ${uid} with ${owners.get(uid)}`);
      owners.set(uid, role);
    }
    assert.equal(new Set(roles).size, roles.length);
    // The planner calls and model checks run as neither a lane's user nor each other's.
    const laneUsers = Array.from({ length: MAX_LANES }, (_, i) => [
      `lane-${i + 1}`,
      `lane-${i + 1}-dev`,
      `agent-${i + 1}`,
    ]).flat();
    assert.notEqual(roleIds(PLANNER_ROLE).uid, roleIds(CHECK_ROLE).uid);
    for (const r of [PLANNER_ROLE, CHECK_ROLE])
      for (const lane of laneUsers)
        assert.notEqual(roleIds(r).uid, roleIds(lane).uid, `${r} and ${lane}`);
    // The planner's and the model check's users are in the image, with the broker's ids.
    const file = String(
      readFileSync(new URL("../../containers/harness/Containerfile", import.meta.url)),
    );
    for (const role of [PLANNER_ROLE, CHECK_ROLE]) {
      const { uid, gid } = roleIds(role);
      assert.match(file, new RegExp(`groupadd -g ${gid} ${role} &&`), role);
      assert.match(file, new RegExp(`useradd -u ${uid} -g ${role} .* ${role} \\\\`), role);
    }
    // The isolation selftest probes them.
    for (const role of [PLANNER_ROLE, CHECK_ROLE]) assert.ok(probedRoles().includes(role), role);
  });

  test("each judge card builds as a builder of its own, in the image and probed by the selftest (goal 135)", () => {
    const file = readFileSync(
      new URL("../../containers/harness/Containerfile", import.meta.url),
      "utf8",
    );
    assert.match(file, /groupadd -g \$\(\(10020 \+ i\)\) builder-\$i/);
    for (let i = 1; i <= 7; i++) {
      const role = `builder-${i}`;
      assert.ok(RoleSchema.safeParse(role).success, role);
      assert.deepEqual(roleIds(role), { uid: IDS.builder.uid + i, gid: IDS.builder.gid + i });
      assert.ok(ALL_ROLES.includes(role), role);
      assert.equal(nprocFor({ role }), 512, role);
    }
    assert.ok(!RoleSchema.safeParse("builder-8").success);
    assert.deepEqual(
      probedRoles(2).filter((r) => r.startsWith("builder") || r.startsWith("run")),
      ["builder", "builder-1", "run", "run-1"],
    );
  });

  test("each judge card checks as a checker and drives a kit's driver as a driver of its own, in the image and probed by the selftest", () => {
    const file = readFileSync(
      new URL("../../containers/harness/Containerfile", import.meta.url),
      "utf8",
    );
    assert.match(file, /groupadd -g 10049 checkers/);
    assert.equal(IDS.checkersGroup, 10049);
    assert.match(file, /useradd -u \$\(\(10050 \+ i\)\) -g checker\$s .* checker\$s/);
    assert.match(file, /useradd -u \$\(\(10060 \+ i\)\) -g driver\$s .* driver\$s/);
    for (let i = 0; i <= 7; i++) {
      const s = i ? `-${i}` : "";
      for (const [role, base] of [
        [`checker${s}`, IDS.checker.uid],
        [`driver${s}`, IDS.driver.uid],
      ] as const) {
        assert.ok(RoleSchema.safeParse(role).success, role);
        assert.deepEqual(roleIds(role), { uid: base + i, gid: base + i });
        assert.ok(ALL_ROLES.includes(role), role);
      }
    }
    assert.ok(!RoleSchema.safeParse("checker-8").success);
    assert.deepEqual(
      probedRoles(2).filter((r) => /^(checker|driver)/.test(r)),
      ["checker", "checker-1", "driver", "driver-1"],
    );
  });

  test("the broker's roles and the owner's message recipients stop at the same lane", () => {
    for (const role of [`lane-${MAX_LANES}`, `lane-${MAX_LANES}-dev`, `agent-${MAX_LANES}`])
      assert.ok(RoleSchema.safeParse(role).success, role);
    for (const role of [
      "lane-0",
      `lane-${MAX_LANES + 1}`,
      `lane-${MAX_LANES + 1}-dev`,
      `agent-${MAX_LANES + 1}`,
    ])
      assert.ok(!RoleSchema.safeParse(role).success, role);
    assert.match(`lane-${MAX_LANES}`, MESSAGE_TARGET);
    assert.doesNotMatch(`lane-${MAX_LANES + 1}`, MESSAGE_TARGET);
  });

  test("a contract, Edit rig and the campaign builder refuse more, with the reason", () => {
    assert.ok(parseContract(research(MAX_LANES)).ok);
    const more = parseContract(research(MAX_LANES + 1));
    assert.ok(!more.ok);
    assert.deepEqual(more.errors, [`lanes.count: ${MAX_LANES_REASON}`]);
    const settings = CommandPayloads.rig_settings;
    assert.ok(settings.safeParse({ lanes: MAX_LANES }).success);
    const edit = settings.safeParse({ lanes: MAX_LANES + 1 });
    assert.equal(edit.error?.issues[0]?.message, MAX_LANES_REASON);
    assert.ok(CampaignDraft.shape.lanes.safeParse(MAX_LANES).success);
    const draft = CampaignDraft.shape.lanes.safeParse(MAX_LANES + 1);
    assert.equal(draft.error?.issues[0]?.message, MAX_LANES_REASON);
  });

  test("control refuses to sign an assignment with more lanes than a rig runs", () => {
    assert.equal(assignRefusal({ contract: research(MAX_LANES) }), "");
    assert.equal(assignRefusal({ contract: { campaign: "x" } }), "");
    assert.equal(assignRefusal(null), "");
    assert.equal(
      assignRefusal({ contract: research(64) }),
      `This contract asks for 64 lanes. A rig runs ${MAX_LANES} at most: it has users for lanes 1 to ${MAX_LANES} only. Set lanes.count to ${MAX_LANES} or fewer.`,
    );
  });

  test("THERMITE_MAX_TRIALS: 0 to the most lanes, else the harness does not start", () => {
    assert.equal(lanesFromEnv(undefined), 1);
    assert.equal(lanesFromEnv(""), 1);
    // 0: a rig that starts no trials (the steering acceptance's rigs run only their advisors).
    assert.equal(lanesFromEnv("0"), 0);
    assert.equal(lanesFromEnv("2"), 2);
    assert.equal(lanesFromEnv(String(MAX_LANES)), MAX_LANES);
    for (const bad of ["-1", String(MAX_LANES + 1), "2.5", "two"])
      assert.throws(
        () => lanesFromEnv(bad),
        new RegExp(
          `THERMITE_MAX_TRIALS takes a whole number from 0 to ${MAX_LANES} \\(0: no trials\\), not `,
        ),
        bad,
      );
  });
});

describe("a lane's process limit", () => {
  const withLimits = (limits: Record<string, number>) => ({
    ...research(2),
    lanes: { count: 2, trials_per_epoch: 1, limits },
  });

  test("the contract sets it, from 64 to 65,536; unset, it is 256", () => {
    const set = parseContract(withLimits({ processes: 4096 }));
    assert.ok(set.ok);
    assert.equal(laneLimits(set.contract).processes, 4096);
    const unset = parseContract(research(2));
    assert.ok(unset.ok);
    assert.equal(laneLimits(unset.contract).processes, LANE_PROCESSES);
    assert.equal(LANE_PROCESSES, 256);
    for (const bad of [63, 65_537, 300.5]) {
      const r = parseContract(withLimits({ processes: bad }));
      assert.ok(!r.ok, String(bad));
      assert.match(r.errors.join("; "), /^lanes\.limits\.processes: /);
    }
  });

  test("the broker uses the limit the controller asks for, else the role's own", () => {
    assert.equal(nprocFor({ role: "lane-3", nproc: 4096 }), 4096);
    assert.equal(nprocFor({ role: "agent-3", nproc: 4096 }), 4096);
    assert.equal(nprocFor({ role: "lane-3" }), 256);
    assert.equal(nprocFor({ role: "run" }), 256);
    assert.equal(nprocFor({ role: "builder" }), 512);
    const req = { role: "lane-1", argv: ["true"], cwd: "/scratch/x" };
    assert.ok(RunRequest.safeParse({ ...req, nproc: 65_536 }).success);
    for (const nproc of [0, 15, 65_537, 2.5])
      assert.ok(!RunRequest.safeParse({ ...req, nproc }).success, String(nproc));
  });
});
