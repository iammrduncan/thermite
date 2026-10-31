#!/usr/bin/env node
// The paid acceptance of rigs on RunPod: one real pod, launched and ended through a real control,
// run by hand by the owner. It SPENDS MONEY, so it runs only with --i-accept-the-cost and a spend
// limit the owner gives. It talks to control's REST API only, with the owner's token; control
// holds the RunPod key (Settings › Providers). Nothing here reads or sends a RunPod key.
//
//   node scripts/acceptance/runpod-paid.mjs --control https://control.example.com \
//     --token-file ~/.thermite/owner-token --gpu "RTX A4000" --spend-limit 2 \
//     [--cloud runpod] [--image REF] [--rig NAME] [--skip-smoke] --i-accept-the-cost
//
// What it checks, in order:
//   launch     the launch is accepted, on Secure cloud, with the spend limit;
//   enroll     control enrolls the pod through RunPod's proxy;
//   report     the rig's reports reach control;
//   isolation  the harness's isolation check at start passes on RunPod (goal 020);
//   smoke      the judge's smoke check passes on the pod's GPU; its no-op is an A/A run, so its
//              verdict says how noisy the pod's timing is (goal 018). --skip-smoke leaves it out;
//   outside    requests to the pod's proxy address from here, without control's signature, all
//              get the same empty 404 (goal 019);
//   stop       the runs are paused, the export reaches control, and the pod stops;
//   start      the pod runs again and reports, or RunPod says it has no GPU free for it;
//   terminate  every result leaves the pod, then RunPod removes it and the rig is retired.
// It prints each step and what the pod cost. On a failure it stops the pod (its volume stays, its
// GPU is no longer billed) and says how to terminate it once you have looked.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { acceptanceChecks } from "./lib/checks.mjs";

const { values: o } = parseArgs({
  options: {
    control: { type: "string" },
    "token-file": { type: "string" },
    cloud: { type: "string", default: "runpod" },
    gpu: { type: "string" },
    image: { type: "string" },
    rig: { type: "string" },
    "spend-limit": { type: "string" },
    "skip-smoke": { type: "boolean", default: false },
    "i-accept-the-cost": { type: "boolean", default: false },
  },
});
const usage =
  "usage: node scripts/acceptance/runpod-paid.mjs --control URL --token-file F --gpu G --spend-limit USD [--cloud C] [--image REF] [--rig NAME] [--skip-smoke] --i-accept-the-cost";
if (!o.control || !o["token-file"] || !o.gpu || !o["spend-limit"]) {
  console.error(usage);
  process.exit(2);
}
if (!o["i-accept-the-cost"]) {
  console.error(
    "This launches a real RunPod pod, billed by the hour. Run it again with --i-accept-the-cost once the owner agreed to spend.",
  );
  process.exit(2);
}
const spendLimit = Number(o["spend-limit"]);
if (!(spendLimit > 0)) {
  console.error("--spend-limit takes a number of US dollars above 0");
  process.exit(2);
}
const control = o.control.replace(/\/$/, "");
const token = readFileSync(o["token-file"], "utf8").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { check, failed } = acceptanceChecks();
async function api(path, body) {
  const r = await fetch(`${control}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { text };
  }
  return { status: r.status, body: json };
}
/** Waits until `fn` gives something; throws, in words, after `minutes`. */
async function until(what, fn, minutes) {
  const deadline = Date.now() + minutes * 60_000;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`no ${what} within ${minutes} minutes`);
    await sleep(10_000);
  }
}
const view = async (rig) => (await api(`/v1/rigs/${encodeURIComponent(rig)}/runpod`)).body;

let rig;
const t0 = Date.now();
try {
  // Launch.
  const launched = await api(`/v1/gpu-clouds/${encodeURIComponent(o.cloud)}/rigs`, {
    gpu: o.gpu,
    spend_limit_usd: spendLimit,
    ...(o.image ? { image: o.image } : {}),
    ...(o.rig ? { rig: o.rig } : {}),
  });
  if (
    !check(
      "the launch is accepted",
      launched.status === 201,
      JSON.stringify(launched.body).slice(0, 400),
    )
  )
    throw new Error("not launched: nothing was started");
  rig = launched.body.rig;
  const pod = launched.body.pod;
  console.log(
    `rig ${rig}, pod ${pod}, ${launched.body.gpu_name}, $${launched.body.price_per_hr}/h`,
  );
  check("on Secure cloud", launched.body.cloud_type === "SECURE");

  // Enroll and report.
  await until("enrollment", async () => (await view(rig)).enrolled_at, 20);
  check(
    "control enrolled the pod through RunPod's proxy",
    true,
    `${Math.round((Date.now() - t0) / 1000)} s after the launch`,
  );
  await until(
    "report",
    async () =>
      ((await api("/v1/rigs")).body.rigs ?? []).find(
        (u) => u.id === rig && Date.parse(u.last_seen) > 0,
      ),
    10,
  );
  check(
    "the rig's reports reach control",
    true,
    `${Math.round((Date.now() - t0) / 1000)} s after the launch`,
  );
  const iso = await until(
    "isolation check",
    async () => {
      const c = (await api(`/v1/rigs/${encodeURIComponent(rig)}/view`)).body.checks?.isolation;
      return c && c.ok !== null ? c : undefined;
    },
    15,
  );
  check("the isolation check at start passes on RunPod", iso.ok === true, iso.summary ?? "");

  // The judge's smoke check on the pod's GPU. Its no-op candidate is an A/A run: neutral when the
  // pod's timing stays inside the contract's equivalence band, inconclusive (with a note) when not.
  if (!o["skip-smoke"]) {
    const asked = await api("/v1/commands", {
      rig,
      kind: "rig_check",
      payload: { check: "smoke" },
      ttl_minutes: 30,
    });
    if (
      check(
        "the smoke check is asked for",
        asked.status === 201,
        JSON.stringify(asked.body).slice(0, 300),
      )
    ) {
      const smokeAt = Date.now();
      const smoke = await until(
        "smoke check",
        async () => {
          const c = (await api(`/v1/rigs/${encodeURIComponent(rig)}/view`)).body.checks?.smoke;
          return c && c.ok !== null ? c : undefined;
        },
        90,
      );
      check(
        "the judge's smoke check passes on the pod's GPU",
        smoke.ok === true,
        `${smoke.summary ?? ""} (${Math.round((Date.now() - smokeAt) / 60_000)} min)`,
      );
      console.log(
        `A/A, the smoke check's no-op: ${smoke.note ?? "neutral, inside the equivalence band"}`,
      );
    }
  }

  // From outside, without control's signature: nothing but the same empty 404.
  const base = `https://${pod}-8790.proxy.runpod.net`;
  const prefix = randomBytes(32).toString("hex");
  const seen = [];
  for (const path of ["/", "/enroll", "/exchange", `/${prefix}/enroll`, `/${prefix}/exchange`])
    for (const method of ["GET", "POST", "HEAD", "OPTIONS"]) {
      try {
        const r = await fetch(`${base}${path}`, {
          method,
          ...(method === "POST"
            ? { body: "{}", headers: { "content-type": "application/json" } }
            : {}),
          signal: AbortSignal.timeout(20_000),
        });
        const text = await r.text();
        seen.push({
          method,
          path: path.replace(prefix, "<random>"),
          status: r.status,
          bytes: text.length,
        });
      } catch (err) {
        seen.push({ method, path: path.replace(prefix, "<random>"), error: String(err) });
      }
    }
  const odd = seen.filter((s) => s.status !== 404 || s.bytes !== 0);
  check(
    "every request from outside gets the same empty 404",
    odd.length === 0,
    odd.length ? JSON.stringify(odd) : `${seen.length} requests`,
  );

  // Stop.
  const stop = await api(`/v1/rigs/${encodeURIComponent(rig)}/runpod/stop`, {});
  check(
    "the stop is accepted",
    stop.status === 200,
    stop.body.op_words ?? JSON.stringify(stop.body),
  );
  const stopped = await until(
    "stop",
    async () => {
      const v = await view(rig);
      return v.status === "EXITED" && !v.op ? v : undefined;
    },
    20,
  );
  check(
    "the results left the pod before it stopped",
    stopped.last_export_left === true,
    stopped.history?.at(-1)?.detail ?? "",
  );

  // Start: it runs again, or RunPod says it has no GPU free.
  const startedAt = Date.now();
  const start = await api(`/v1/rigs/${encodeURIComponent(rig)}/runpod/start`, {});
  if (start.status === 409 && /no free GPU/.test(start.body.error ?? "")) {
    console.log(`NOTE RunPod had no GPU free for the pod: ${start.body.error}`);
    check("the start says plainly that RunPod has no GPU free", true);
  } else {
    check(
      "the start is accepted",
      start.status === 200,
      start.body.status ?? JSON.stringify(start.body),
    );
    await until(
      "report after the start",
      async () =>
        ((await api("/v1/rigs")).body.rigs ?? []).find(
          (u) => u.id === rig && Date.parse(u.last_seen) > startedAt,
        ),
      15,
    );
    check(
      "the pod runs again and reports, without enrolling again",
      true,
      `${Math.round((Date.now() - startedAt) / 1000)} s`,
    );
  }

  // Terminate.
  const term = await api(`/v1/rigs/${encodeURIComponent(rig)}/runpod/terminate`, {
    confirm: `terminate ${rig}`,
  });
  check(
    "the terminate is accepted",
    term.status === 200,
    term.body.op_words ?? JSON.stringify(term.body),
  );
  const gone = await until(
    "terminate",
    async () => {
      const v = await view(rig);
      if (v.error?.startsWith("Not terminated")) throw new Error(v.error);
      return v.active === false ? v : undefined;
    },
    90,
  );
  check("every result left the pod, then RunPod removed it", gone.status === "TERMINATED");
  console.log(
    `history: ${(gone.history ?? []).map((h) => `${h.step}${h.ok ? "" : " (not ok)"}`).join(", ")}`,
  );
  console.log(
    `it cost $${gone.spend_usd} by control's count, in ${Math.round((Date.now() - t0) / 60_000)} minutes`,
  );
} catch (err) {
  check("the script ran to its end", false, err instanceof Error ? err.message : String(err));
  if (rig) {
    const v = await view(rig).catch(() => undefined);
    if (v?.active && v.status !== "EXITED") {
      const s = await api(`/v1/rigs/${encodeURIComponent(rig)}/runpod/stop`, {});
      console.error(
        `Stopping the pod so its GPU is no longer billed (${s.status}): its volume stays. Look at it, then end it: thermite runpod terminate ${rig} --control ${control} --token-file ${o["token-file"]}`,
      );
    } else if (v?.active)
      console.error(
        `The pod is stopped. Look at it, then end it: thermite runpod terminate ${rig} --control ${control} --token-file ${o["token-file"]}`,
      );
  }
}
console.log(failed() ? `runpod paid acceptance: ${failed()} FAILED` : "runpod paid acceptance: OK");
process.exit(failed() ? 1 : 0);
