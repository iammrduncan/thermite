import { newToken } from "../../../src/common/secrets.ts";
import { issueCommand } from "../../../src/control/issue/index.ts";
import type { ControlStore } from "../../../src/control/store/index.ts";
import { generateSigningKeys } from "../../../src/core/commands.ts";
import { applied } from "../control-store.ts";
import { decisionRigs } from "./decisions.ts";
import { goalRig } from "./goal.ts";
import { hillClimbRigs } from "./hill-climb.ts";
import { liveSessions } from "./live.ts";
import { reportRigs } from "./reports.ts";
import { pilotRig, researchRig } from "./research.ts";
import { startDemo } from "./shared.ts";

/**
 * The dashboard's demo data, all made up: the one seed that the dashboard demo serves, which the
 * documentation's screenshots are taken from (scripts/dev/dashboard-demo/main.ts), and that the
 * dashboard's tests read.
 *
 * - A hill climb, decode-speed, on gpu-1 and gpu-2: promotions, an audit hold, a pending approval,
 *   a champion propagated and cross-verified, an earlier run from before a full reset, two trials
 *   at work with their experiment queue and journal (hill-climb.ts, reports.ts, live.ts).
 * - A goal campaign part way, regex-dfa, on gpu-3 (goal.ts).
 * - A research campaign and its reviews on cpu-1, and a stale rig, gpu-4 (research.ts, reviews.ts).
 * - The owner's decisions on rig-a, rig-b and rig-c: a goal campaign's attempt held for an audit,
 *   a run moved to another rig, a hill climb's win waiting for approval and one the auditor
 *   blocked (decisions.ts).
 * - Commands issued and their outcomes, a daily report, and a model provider whose list prices
 *   one model and not the other.
 *
 * Every made-up time is some hours before `now`, and the random sequences start again at each
 * seed, so a seed makes the same data at its own time. Commands are signed with `signingKey`
 * (a new key unless given). What control derives from the rigs' events (model usage, the
 * knowledge base, commands' outcomes) is applied before it returns.
 */
export async function seedDemo(
  store: ControlStore,
  now = Date.now(),
  signingKey = generateSigningKeys().privateKeyPem,
): Promise<void> {
  startDemo(now);
  for (const rig of ["gpu-1", "gpu-2", "gpu-3", "cpu-1", "gpu-4", "rig-a", "rig-b", "rig-c"])
    if (!store.enrollments.rig(rig)) store.enrollments.enroll(rig, newToken().sha256, "demo");

  // The rigs are made in this order, which the seeded random sequences depend on.
  const { g1, g2 } = hillClimbRigs();
  const g3 = goalRig();
  const c1 = researchRig();
  const g4 = pilotRig();
  await reportRigs(store, { g1, g2, g3, c1, g4 });
  liveSessions(store);
  await decisionRigs(store, now);

  for (const [rig, kind, payload] of [
    ["gpu-1", "pause_run", { run: "decode-a", reason: "owner check" }],
    ["gpu-1", "resume_run", { run: "decode-a" }],
    ["gpu-2", "export_now", {}],
    [
      "gpu-3",
      "redirect",
      {
        run: "regex-dfa-1",
        directives: [
          {
            kind: "try",
            family: "simd-prefilter",
            rationale: "the prefilter probe skips most of the input",
            citations: [],
          },
        ],
        replace: true,
      },
    ],
  ] as const) {
    issueCommand(store, signingKey, { rig, kind, payload, issuedBy: "owner:ui" });
  }
  store.rigReports.add(
    "gpu-1",
    "daily",
    "Daily report for gpu-1\n\nCampaign decode-speed (decode-a): champion seq 6, +24.1% over its baseline.\n48 attempts today: 6 wins confirmed, 1 held by audit.\nAgents: 16 epochs, 48 trials, planner valid 94%.",
  );

  // A model provider whose list prices one model and not the other (goal 075's price field).
  store.modelProviders.put({
    name: "demo-models",
    type: "openai",
    base_url: "https://models.example.com/v1",
    key: { sealed: "demo", hint: "…demo" },
  });
  store.modelProviders.setModels("demo-models", [
    {
      id: "glm-5.1",
      context_window: 131_072,
      price: { input: 0.6, cached_input: 0.11, output: 2.2 },
    },
    { id: "kimi-k3", context_window: 262_144 },
  ]);

  // What control derives from the rigs' events, applied before the first page is served.
  await applied(store);
}
