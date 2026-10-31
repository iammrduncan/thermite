import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  formatRunpodRigs,
  launchBody,
  lifecycleSaid,
  limitsBody,
  openResetOf,
} from "../../src/cli/runpod.ts";
import type { RunpodRigView } from "../../src/control/runpod/rig-view.ts";

describe("thermite runpod", () => {
  test("launch: the options become the API's body, and nothing is set that was not given", () => {
    assert.deepEqual(launchBody({ gpu: "RTX A4000" }), { gpu: "RTX A4000" });
    assert.deepEqual(
      launchBody({
        gpu: "RTX A4000",
        gpus: "2",
        "cloud-type": "community",
        datacenter: "EU-RO-1",
        image: "ghcr.io/example/thermite-rig:1",
        disk: "60",
        volume: "300",
        rig: "rig-1",
        "enroll-within": "30",
        setting: ["THERMITE_JUDGE_GPUS=1", "THERMITE_TARGET_CLASS=a4000"],
        "spend-limit": "12.5",
        "idle-stop": "45",
      }),
      {
        gpu: "RTX A4000",
        gpu_count: 2,
        cloud_type: "COMMUNITY",
        datacenter: "EU-RO-1",
        image: "ghcr.io/example/thermite-rig:1",
        container_disk_gb: 60,
        volume_gb: 300,
        rig: "rig-1",
        enroll_within_minutes: 30,
        settings: { THERMITE_JUDGE_GPUS: "1", THERMITE_TARGET_CLASS: "a4000" },
        spend_limit_usd: 12.5,
        idle_stop_minutes: 45,
      },
    );
    assert.deepEqual(launchBody({ gpu: "RTX A4000", "idle-stop": "off" }), {
      gpu: "RTX A4000",
      idle_stop_minutes: null,
    });
    assert.throws(() => launchBody({}), /--gpu names the GPU type/);
    assert.throws(() => launchBody({ gpu: "x", gpus: "two" }), /--gpus takes a whole number/);
    assert.throws(() => launchBody({ gpu: "x", gpus: "1.5" }), /--gpus takes a whole number/);
    assert.throws(() => launchBody({ gpu: "x", "cloud-type": "spot" }), /SECURE or COMMUNITY/);
    assert.throws(() => launchBody({ gpu: "x", setting: ["NOEQUALS"] }), /NAME=VALUE/);
    assert.throws(
      () => launchBody({ gpu: "x", "spend-limit": "" }),
      /--spend-limit takes a number/,
    );
  });

  test("limits: a number sets one, off clears it, and one is needed", () => {
    assert.deepEqual(limitsBody({ "spend-limit": "20" }), { spend_limit_usd: 20 });
    assert.deepEqual(limitsBody({ "spend-limit": "off", "idle-stop": "30" }), {
      spend_limit_usd: null,
      idle_stop_minutes: 30,
    });
    assert.throws(() => limitsBody({}), /give --spend-limit, --idle-stop or both/);
    assert.throws(() => limitsBody({ "idle-stop": "soon" }), /--idle-stop takes a number/);
  });

  test("list: one line for each rig, with its price, spend and limits", () => {
    const rig = {
      rig: "rp-1a2b3c4d",
      pod: "pod1",
      active: true,
      status: "RUNNING",
      gpu_count: 1,
      gpu_name: "RTX A4000",
      cloud_type: "SECURE",
      price_per_hr: 0.25,
      spend_usd: 1.5,
      spend_limit_usd: 10,
      idle_stop_minutes: null,
      enrolled_at: "2026-10-20T10:00:00Z",
      stopped_by: null,
      error: null,
    } as unknown as RunpodRigView;
    assert.equal(
      formatRunpodRigs([rig]),
      "rp-1a2b3c4d · pod pod1 · RUNNING · 1 × RTX A4000 (Secure) · $0.25/h · spent $1.50 · spend limit $10.00 · no idle stop · enrolled\n",
    );
    assert.match(
      formatRunpodRigs([{ ...rig, stopped_by: "spend_limit", status: "EXITED" }]),
      /\n {2}stopped by control: spend limit\n$/,
    );
    assert.equal(formatRunpodRigs([]), "no rig on a GPU cloud\n");
    // Stopped by the owner, and a change under way.
    assert.match(
      formatRunpodRigs([{ ...rig, stopped_by: "owner", status: "EXITED" }]),
      /\n {2}stopped by the owner\n$/,
    );
    assert.match(
      formatRunpodRigs([
        { ...rig, op_words: "terminating: waiting for every result to leave the pod" },
      ]),
      /\n {2}under way: terminating: waiting for every result to leave the pod\n$/,
    );
  });

  test("stop, start, restart and terminate say what comes next; a reset is found by its rig", () => {
    assert.match(
      lifecycleSaid("stop"),
      /^Stopping: its runs are paused and its results go out first/,
    );
    assert.match(lifecycleSaid("start"), /RunPod bills the pod from now/);
    assert.match(lifecycleSaid("terminate"), /removed only once every result has left it/);
    const resets = [
      { id: 3, rig: "rp-1", state: "done" },
      { id: 4, rig: "rp-2", state: "awaiting_owner" },
      { id: 5, rig: "rp-1", state: "awaiting_owner" },
    ];
    assert.equal(openResetOf(resets, "rp-1").id, 5);
    assert.throws(
      () => openResetOf(resets.slice(0, 1), "rp-1"),
      /no full reset of rp-1 is under way/,
    );
  });
});
