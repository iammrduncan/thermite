import assert from "node:assert/strict";
import type { RunpodRigView } from "../../../../src/control/runpod/rig-view.ts";
import { RunpodRigs } from "../../../../src/control/runpod/rigs.ts";
import { ControlTunnels } from "../../../../src/control/runpod/tunnel.ts";
import { SecretBox } from "../../../../src/control/secrets.ts";
import type { ControlStore } from "../../../../src/control/store/index.ts";
import { generateSigningKeys } from "../../../../src/core/commands.ts";
import { TEST_BUS_CA } from "../../../helpers/bus-ca.ts";
import { controlOnly } from "../../../helpers/control-stack.ts";
import { controlStore, ingestReport } from "../../../helpers/control-store.ts";
import { FAKE_RUNPOD_KEY, fakeRunpod } from "../../../helpers/fake-runpod.ts";
import { supervisorReports } from "../../../helpers/rig-results.ts";

/**
 * What the tests of RunPod rigs' lifecycle (runpod/lifecycle.ts) share: control with one RunPod
 * account on the fake RunPod API, a clock the test moves, and a rig on it that reports a run.
 */

const IMAGE = "ghcr.io/example/thermite-rig:test-cuda";
export const HOUR = 3_600_000;
export const TOKENS = {
  admin: "owner-token-abcdef",
  operator: "operator-token-abcdef",
  agent: "agent-token-abcdef",
  read: "read-token-abcdef",
  rigs: {},
};

/** Control with one RunPod account (the fake RunPod), its API, and a clock the test moves. */
export function setup(o: Parameters<typeof fakeRunpod>[0] = {}) {
  const store = controlStore();
  const secrets = SecretBox.ephemeral();
  store.gpuClouds.add({
    name: "runpod",
    kind: "runpod",
    key_sealed: secrets.seal(FAKE_RUNPOD_KEY),
    key_hint: "…cdef",
    by: "owner:ui",
  });
  const cloud = fakeRunpod(o);
  const control = generateSigningKeys();
  let clock = Date.now();
  const now = () => clock;
  const tunnels = new ControlTunnels(store, secrets, control.privateKeyPem, {
    now,
    busCa: TEST_BUS_CA,
  });
  const rigs = new RunpodRigs(store, secrets, tunnels, {
    fetch: cloud.fetch,
    image: IMAGE,
    now,
    privateKeyPem: control.privateKeyPem,
  });
  const { control: api } = controlOnly({
    store,
    keys: control,
    tokens: TOKENS,
    options: { secrets, tunnels, runpodRigs: rigs },
  });
  const call = (path: string, body?: unknown, token = TOKENS.admin) =>
    api.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const advance = async (ms = 30_000) => {
    clock += ms;
    await rigs.advance();
  };
  const view = (rig: string) => rigs.view(rig) as RunpodRigView;
  const steps = (rig: string) => store.rigHistory.list(rig).map((e) => [e.step, e.ok]);
  return { store, cloud, control, rigs, api, call, advance, view, steps };
}

/**
 * The rig's harness reports a run that runs (or one that ended), as its signed reports would, and
 * control's views have it.
 */
async function reportRun(store: ControlStore, rig: string, run: string, n: number, ended = false) {
  await ingestReport(store, {
    rig,
    ledger_id: "l1",
    cursor: n - 1,
    next: n,
    summary: {},
    events: [
      {
        id: n,
        at: new Date(Date.now() + n).toISOString(),
        actor: "t",
        kind: ended ? "run_status" : "run_created",
        subject: run,
        body: ended
          ? { status: "completed" }
          : { campaign: "camp", mode: "hill_climb", seed: { repo: "p" } },
      },
    ],
  });
}

/** A launched rig that enrolled and whose harness reports one running run. */
export async function working(s: ReturnType<typeof setup>, o: { spend_limit_usd?: number } = {}) {
  const v = await s.rigs.launch("runpod", { gpu: "RTX A4000", ...o }, "owner:api");
  await s.advance();
  assert.ok(s.store.tunnels.pin(v.rig, "sign", "box"));
  await reportRun(s.store, v.rig, "run-1", 1);
  supervisorReports(s.store, v.rig);
  return v.rig;
}

export const json = async <T>(r: Response) => (await r.json()) as T;

/** A tool's answer: its text, JSON (an error is {"error": …}). */
export const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? "";
