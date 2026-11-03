import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  devGroup,
  effectiveGpuLists,
  expectedNodeGroups,
  fenceArgs,
  formatCpuList,
  type GpuLayout,
  identityFor,
  judgeGroup,
  LAYOUT_FILE,
  nodeGroups,
  parseCpuList,
  parseIndexList,
  parseMinor,
  planDedicated,
  procBusDir,
  readLayout,
  runCpus,
  shareCpus,
} from "../../../src/harness/broker/devices.ts";
import { launch } from "../../../src/harness/broker/process.ts";
import { IDS } from "../../../src/harness/broker/runner.ts";
import { deviceProbes } from "../../../src/harness/selftest/index.ts";

// Shaped like two cards in one container (no real host data).
const SMI = `0, GPU-aaaaaaaa-0000-0000-0000-000000000000, 00000000:3B:00.0
1, GPU-bbbbbbbb-0000-0000-0000-000000000000, 00000000:D8:00.0
`;
const INFO: Record<string, string> = {
  "0000:3b:00.0": "Model: Tesla P100-PCIE-16GB\nDevice Minor: 6\n",
  "0000:d8:00.0": "Model: Tesla P100-PCIE-16GB\nDevice Minor: 7\n",
};
const NODES = ["/dev/nvidia6", "/dev/nvidia7", "/dev/nvidiactl", "/dev/nvidia-uvm"];
const plan = (over: Partial<Parameters<typeof planDedicated>[0]> = {}) =>
  planDedicated({
    smiCsv: SMI,
    information: (bus) => {
      const i = INFO[bus];
      if (!i) throw new Error(`no ${bus}`);
      return i;
    },
    nodes: NODES,
    judgeIndices: [0],
    devIndices: [1],
    ...over,
  });

describe("a dedicated development card", () => {
  test("the layout maps nvidia-smi's cards to their nodes through the driver's minors", () => {
    assert.equal(procBusDir("00000000:3B:00.0"), "0000:3b:00.0");
    assert.equal(parseMinor(INFO["0000:d8:00.0"] as string), 7);
    assert.equal(
      parseMinor("GPU 00000000:D8:00.0\n    Minor Number                          : 7\n"),
      7,
    );
    const l = plan();
    assert.equal(l.judge.node, "/dev/nvidia6");
    assert.equal(l.dev.node, "/dev/nvidia7");
    assert.equal(l.dev.uuid, "GPU-bbbbbbbb-0000-0000-0000-000000000000");
    assert.deepEqual(l.control, ["/dev/nvidiactl", "/dev/nvidia-uvm"]);
    assert.deepEqual(nodeGroups(l), [
      { node: "/dev/nvidia6", gid: IDS.gpuGroup },
      { node: "/dev/nvidia7", gid: IDS.gpuDevGroup },
      { node: "/dev/nvidiactl", gid: IDS.gpuCtlGroup },
      { node: "/dev/nvidia-uvm", gid: IDS.gpuCtlGroup },
    ]);
  });

  test("every node present has an expected group, including ones that appear later", () => {
    const l = plan();
    const later = [...NODES, "/dev/nvidia-uvm-tools", "/dev/nvidia9"];
    assert.deepEqual(expectedNodeGroups(later, l), [
      { node: "/dev/nvidia6", gid: IDS.gpuGroup },
      { node: "/dev/nvidia7", gid: IDS.gpuDevGroup },
      { node: "/dev/nvidiactl", gid: IDS.gpuCtlGroup },
      { node: "/dev/nvidia-uvm", gid: IDS.gpuCtlGroup },
      { node: "/dev/nvidia-uvm-tools", gid: IDS.gpuCtlGroup },
      // A card the layout does not know reaches no role.
      { node: "/dev/nvidia9", gid: 0 },
    ]);
    assert.ok(expectedNodeGroups(later).every((x) => x.gid === IDS.gpuGroup));
  });

  test("anything unexpected stops the layout", () => {
    assert.throws(() => plan({ devIndices: [0] }), /both index 0/);
    assert.throws(() => plan({ devIndices: [2] }), /no GPU with index 2/);
    assert.throws(() => plan({ devIndices: [] }), /at least one judge card and one development/);
    assert.throws(() => plan({ nodes: NODES.filter((n) => n !== "/dev/nvidia7") }), /missing/);
    assert.throws(() => plan({ nodes: [...NODES, "/dev/nvidia8"] }), /more cards/);
    assert.throws(() => plan({ information: () => "no minor here" }), /Device Minor/);
  });

  test("each side gets its own card, the shared nodes, and CUDA pointed at its card", () => {
    const l = plan();
    const ctl = [IDS.gpuCtlGroup];
    assert.deepEqual(identityFor("run", false, l), {
      uid: IDS.run.uid,
      gid: IDS.gpuGroup,
      groups: ctl,
      cuda: l.judge.uuid,
      card: l.judge.node,
    });
    for (const [role, gpu] of [
      ["lane-2", true],
      ["lane-2-dev", false],
    ] as const) {
      const id = identityFor(role, gpu, l);
      assert.equal(id.gid, IDS.gpuDevGroup, role);
      assert.deepEqual(id.groups, ctl, role);
      assert.equal(id.cuda, l.dev.uuid, role);
    }
    for (const role of ["builder", "lane-2", "agent-2"] as const) {
      const id = identityFor(role, false, l);
      assert.equal(id.groups, undefined, role);
      assert.notEqual(id.gid, IDS.gpuGroup, role);
    }
    // Shared mode is unchanged: the gpu group for run and dev runs, nothing else.
    assert.deepEqual(identityFor("run", false), { uid: IDS.run.uid, gid: IDS.gpuGroup });
    assert.deepEqual(identityFor("lane-2", true), { uid: 10102, gid: IDS.gpuGroup });
  });

  test("the GPU fence: a role opens its own card and the shared nodes, or every node of the one shared card, or none", () => {
    const l = plan();
    const judgeNode = l.judge.node.replace("/dev/", "");
    const devNode = l.dev.node.replace("/dev/", "");
    assert.deepEqual(fenceArgs(identityFor("run", false, l)), ["--card", judgeNode, "--control"]);
    assert.deepEqual(fenceArgs(identityFor("lane-2", true, l)), ["--card", devNode, "--control"]);
    for (const role of ["builder", "lane-2", "agent-2"] as const) {
      assert.deepEqual(fenceArgs(identityFor(role, false, l)), [], role);
      assert.deepEqual(fenceArgs(identityFor(role, false)), [], `${role}, shared card`);
    }
    // One shared card: the roles in the gpu group reach all of it, so they need no fence.
    assert.equal(fenceArgs(identityFor("run", false)), undefined);
    assert.equal(fenceArgs(identityFor("lane-2", true)), undefined);
    // The fence is the last step before the command, inside every other wrapper.
    assert.deepEqual(
      launch(
        {
          argv: ["make"],
          uid: 10020,
          gid: 10020,
          nproc: 512,
          cpus: "2-3",
          fence: ["/usr/local/bin/thermite-devfence", "--"],
        },
        "/usr/bin/setpriv",
        "/usr/bin/prlimit",
        "/usr/bin/taskset",
      ).argv,
      [
        "/usr/bin/prlimit",
        "--nproc=512",
        "--",
        "/usr/bin/taskset",
        "-c",
        "2-3",
        "/usr/local/bin/thermite-devfence",
        "--",
        "make",
      ],
    );
  });

  test("timed runs are pinned to the judge card's local CPUs that the container may use", () => {
    assert.deepEqual(parseCpuList("10-12,30"), [10, 11, 12, 30]);
    assert.equal(formatCpuList([31, 10, 11, 12, 30, 39]), "10-12,30-31,39");
    assert.equal(runCpus("10-19,30-39", "0-39"), "10-19,30-39");
    assert.equal(runCpus("10-19,30-39", "8-15"), "10-15");
    assert.equal(runCpus("10-19,30-39", "0-9,20-29"), "");
    assert.throws(() => parseCpuList("ten"), /not a CPU list/);
    assert.deepEqual(
      launch(
        { argv: ["bench"], uid: 10030, gid: 10500, cpus: "10-19" },
        undefined,
        undefined,
        "/usr/bin/taskset",
      ),
      { argv: ["/usr/bin/taskset", "-c", "10-19", "bench"], uid: 10030, gid: 10500 },
    );
    assert.throws(
      // An empty path stands for a tool the image lacks (undefined would find the host's own).
      () => launch({ argv: ["bench"], cpus: "1" }, undefined, undefined, ""),
      /taskset/,
    );
  });

  test("supplementary groups go through setpriv; without them nothing changes", () => {
    const base = { argv: ["nvidia-smi", "-L"], uid: 10030, gid: 10500, nproc: 256 };
    assert.deepEqual(launch(base, "/usr/bin/setpriv", "/usr/bin/prlimit"), {
      argv: ["/usr/bin/prlimit", "--nproc=256", "--", "nvidia-smi", "-L"],
      uid: 10030,
      gid: 10500,
    });
    assert.deepEqual(launch({ ...base, groups: [10502] }, "/usr/bin/setpriv", "/usr/bin/prlimit"), {
      argv: [
        "/usr/bin/setpriv",
        "--reuid=10030",
        "--regid=10500",
        "--groups=10502",
        "--",
        "/usr/bin/prlimit",
        "--nproc=256",
        "--",
        "nvidia-smi",
        "-L",
      ],
    });
    assert.throws(() => launch({ ...base, groups: [10502] }, ""), /setpriv/);
  });

  test("the controller reads the broker's layout, or why there is none", () => {
    const dir = mkdtempSync(join(tmpdir(), "thermite-layout-"));
    const sock = join(dir, "broker.sock");
    assert.match(String(readLayout(undefined).error), /needs the broker/);
    assert.match(String(readLayout(sock).error), /no device layout/);
    writeFileSync(
      join(dir, LAYOUT_FILE),
      JSON.stringify({ ok: false, mode: "dedicated", error: "x" }),
    );
    assert.match(String(readLayout(sock).error), /not set up: x/);
    writeFileSync(join(dir, LAYOUT_FILE), JSON.stringify({ ok: true, ...plan() }));
    assert.equal(readLayout(sock).layout?.dev.node, "/dev/nvidia7");
    // Shared mode: restricted nodes are fine; nodes left open stop the rig.
    writeFileSync(
      join(dir, LAYOUT_FILE),
      JSON.stringify({ ok: true, mode: "shared", nodes: ["/dev/nvidia0"] }),
    );
    assert.deepEqual(readLayout(sock), {});
    writeFileSync(
      join(dir, LAYOUT_FILE),
      JSON.stringify({
        ok: false,
        mode: "shared",
        error: "/dev/nvidia-uvm kept another owner or mode",
      }),
    );
    assert.match(String(readLayout(sock).error), /could not be restricted to the gpu group/);
  });

  test("the selftest probes each side's reach and refusal", () => {
    const l: GpuLayout = plan();
    const by = (side: "judge" | "dev" | "other", layout?: GpuLayout) =>
      Object.fromEntries(deviceProbes(NODES, side, layout).map((p) => [p.name, p.op]));
    assert.deepEqual(by("judge", l), {
      "device:nvidia6": "reachable",
      "device:nvidiactl": "reachable",
      "device:nvidia-uvm": "reachable",
      "device:nvidia7": "open",
      "visible-gpus": "gpus",
    });
    assert.deepEqual(by("dev", l), {
      "device:nvidia7": "reachable",
      "device:nvidiactl": "reachable",
      "device:nvidia-uvm": "reachable",
      "device:nvidia6": "open",
      "visible-gpus": "gpus",
    });
    for (const layout of [l, undefined]) {
      assert.ok(Object.values(by("other", layout)).every((op) => op === "open"));
      assert.equal(Object.keys(by("other", layout)).length, NODES.length);
    }
    assert.deepEqual(by("judge"), {});
    assert.deepEqual(by("dev"), {});
    const gpus = deviceProbes(NODES, "dev", l).find((p) => p.op === "gpus");
    assert.equal(gpus?.expect, l.dev.uuid);
  });
});

// Shaped like four cards in one container (no real host data).
const SMI4 = `0, GPU-aaaaaaaa-0000-0000-0000-000000000000, 00000000:01:00.0
1, GPU-bbbbbbbb-0000-0000-0000-000000000000, 00000000:02:00.0
2, GPU-cccccccc-0000-0000-0000-000000000000, 00000000:03:00.0
3, GPU-dddddddd-0000-0000-0000-000000000000, 00000000:04:00.0
`;
const NODES4 = [
  "/dev/nvidia0",
  "/dev/nvidia1",
  "/dev/nvidia2",
  "/dev/nvidia3",
  "/dev/nvidiactl",
  "/dev/nvidia-uvm",
];
const plan4 = (judgeIndices: number[], devIndices: number[]) =>
  planDedicated({
    smiCsv: SMI4,
    information: (bus) => `Device Minor: ${Number(bus.split(":")[1]) - 1}\n`,
    nodes: NODES4,
    judgeIndices,
    devIndices,
  });

describe("a rig with several judge cards and several development cards", () => {
  test("every card gets its own group; the first of each kind keeps the two-card groups", () => {
    const l = plan4([0, 1], [2, 3]);
    assert.deepEqual(
      l.judges.map((c) => c.node),
      ["/dev/nvidia0", "/dev/nvidia1"],
    );
    assert.equal(l.judge.node, "/dev/nvidia0");
    assert.equal(l.dev.node, "/dev/nvidia2");
    assert.deepEqual(nodeGroups(l), [
      { node: "/dev/nvidia0", gid: IDS.gpuGroup },
      { node: "/dev/nvidia1", gid: IDS.gpuJudgeBase + 1 },
      { node: "/dev/nvidia2", gid: IDS.gpuDevGroup },
      { node: "/dev/nvidia3", gid: IDS.gpuDevBase + 1 },
      { node: "/dev/nvidiactl", gid: IDS.gpuCtlGroup },
      { node: "/dev/nvidia-uvm", gid: IDS.gpuCtlGroup },
    ]);
    assert.equal(judgeGroup(0), IDS.gpuGroup);
    assert.equal(devGroup(0), IDS.gpuDevGroup);
    // Three judge cards and one development card is a valid split too.
    assert.equal(plan4([0, 1, 3], [2]).judges.length, 3);
    assert.throws(() => plan4([0, 1], [1, 2, 3]), /both index 1/);
    assert.throws(() => plan4([0], [1]), /more cards than the layout covers/);
  });

  test("each judge card is timed by its own user; each dev run reaches only its card", () => {
    const l = plan4([0, 1], [2, 3]);
    assert.deepEqual(identityFor("run-1", false, l), {
      uid: IDS.run.uid + 1,
      gid: IDS.gpuJudgeBase + 1,
      groups: [IDS.gpuCtlGroup],
      cuda: "GPU-bbbbbbbb-0000-0000-0000-000000000000",
      card: "/dev/nvidia1",
    });
    assert.equal(identityFor("run", false, l).cuda, "GPU-aaaaaaaa-0000-0000-0000-000000000000");
    assert.deepEqual(identityFor("lane-3", true, l, 1), {
      uid: 10103,
      gid: IDS.gpuDevBase + 1,
      groups: [IDS.gpuCtlGroup],
      cuda: "GPU-dddddddd-0000-0000-0000-000000000000",
      card: "/dev/nvidia3",
    });
    assert.equal(identityFor("lane-3", true, l).gid, IDS.gpuDevGroup);
    assert.throws(() => identityFor("run-2", false, l), /no judge card 3/);
    assert.throws(() => identityFor("lane-3", true, l, 2), /no development card 3/);
    assert.throws(() => identityFor("run-1", false), /shares one card/);
  });

  test("the selftest probes each card's identity against every other card", () => {
    const l = plan4([0, 1], [2, 3]);
    const by = (side: "judge" | "dev", card: number) =>
      Object.fromEntries(deviceProbes(NODES4, side, l, card).map((p) => [p.name, p.op]));
    assert.deepEqual(by("judge", 1), {
      "device:nvidia1": "reachable",
      "device:nvidiactl": "reachable",
      "device:nvidia-uvm": "reachable",
      "device:nvidia0": "open",
      "device:nvidia2": "open",
      "device:nvidia3": "open",
      "visible-gpus": "gpus",
    });
    assert.equal(by("dev", 1)["device:nvidia3"], "reachable");
    assert.equal(by("dev", 1)["device:nvidia2"], "open");
    assert.throws(() => deviceProbes(NODES4, "judge", l, 2), /no judge card 3/);
  });

  test("index lists, and disjoint CPU sets for the judge cards", () => {
    assert.deepEqual(parseIndexList("0", "X"), [0]);
    assert.deepEqual(parseIndexList(" 2, 3 ", "X"), [2, 3]);
    assert.throws(() => parseIndexList("0,0", "X"), /names a GPU twice/);
    assert.throws(() => parseIndexList("a", "X"), /a GPU index or a list/);
    assert.throws(() => parseIndexList("0,1,2,3,4,5,6,7,8", "X"), /at most 8/);
    // Two cards on one socket split its CPUs; a card on another socket keeps its own.
    assert.deepEqual(
      shareCpus([
        [0, 1, 2, 3],
        [0, 1, 2, 3],
        [8, 9],
      ]),
      [
        [0, 1],
        [2, 3],
        [8, 9],
      ],
    );
    // Overlapping sets: the later card keeps only CPUs not taken.
    assert.deepEqual(
      shareCpus([
        [0, 1, 2],
        [2, 3],
      ]),
      [[0, 1, 2], [3]],
    );
  });
});

describe("a rig configured with its GPU set", () => {
  test("explicit lists win; a set is split by the rig's setting, else the default", () => {
    assert.deepEqual(
      effectiveGpuLists({ THERMITE_GPU_INDEX: "0,1", THERMITE_DEV_GPU_INDEX: "2" }, 3),
      {
        judge: "0,1",
        dev: "2",
        set: 0,
      },
    );
    assert.deepEqual(effectiveGpuLists({}), { judge: "0", set: 0 });
    assert.deepEqual(effectiveGpuLists({ THERMITE_GPUS: "3" }), { judge: "3", set: 1 });
    const set = { THERMITE_GPUS: "4,5,6,7" };
    assert.deepEqual(effectiveGpuLists(set), { judge: "4,5", dev: "6,7", set: 4 });
    assert.deepEqual(effectiveGpuLists({ ...set, THERMITE_JUDGE_GPUS: "1" }), {
      judge: "4",
      dev: "5,6,7",
      set: 4,
    });
    // The rig's setting comes before the deployment's starting split.
    assert.deepEqual(effectiveGpuLists({ ...set, THERMITE_JUDGE_GPUS: "1" }, 3), {
      judge: "4,5,6",
      dev: "7",
      set: 4,
    });
    // A split that doesn't fit falls back to the default.
    assert.equal(effectiveGpuLists(set, 4).judge, "4,5");
    assert.equal(effectiveGpuLists(set, 0).judge, "4,5");
    // A set takes up to 16 cards: 8 of each kind at most.
    const ten = { THERMITE_GPUS: "0,1,2,3,4,5,6,7,8,9", THERMITE_JUDGE_GPUS: "2" };
    assert.deepEqual(effectiveGpuLists(ten), {
      judge: "0,1",
      dev: "2,3,4,5,6,7,8,9",
      set: 10,
    });
    // One judge card would leave the agents 9: the default split instead.
    assert.equal(effectiveGpuLists({ ...ten, THERMITE_JUDGE_GPUS: "1" }).judge, "0,1,2,3,4");
    const sixteen = Array.from({ length: 16 }, (_, i) => i).join(",");
    assert.equal(effectiveGpuLists({ THERMITE_GPUS: sixteen }).set, 16);
    assert.throws(
      () => effectiveGpuLists({ THERMITE_GPUS: `${sixteen},16` }),
      /THERMITE_GPUS names 17 GPUs; a rig takes at most 16$/,
    );
  });
});
