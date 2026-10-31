#!/usr/bin/env node
// Claude Code itself, not a stand-in: the harness image built with CLAUDE_CODE_VERSION runs as a
// rig runs it (the broker as root, which closes /tmp to the roles and puts each role's work under
// the GPU fence; only the broker's capabilities; no new privileges), with no network at all. A
// stand-in for Anthropic's Messages API in the container (containers/test-anthropic) plays the
// model, and a made-up token signs in to it, so no subscription, key or network is needed:
//   - the model check: Claude Code runs its Bash call as the model check's user;
//   - a planner call: Claude Code's Grep reads past research outside its folder;
//   - a trial as lane-1, in Claude Code's own terminal (goal 169: the rig's default) through the
//     terminal host, and again headless (`-p`, an advanced choice): its Write tool edits the
//     workspace, its command finds the token in no environment, and it submits with
//     thermite-trial; in its terminal, its tally comes from its transcript, which the host copies
//     for the harness, and its screen is kept at the end;
//   - a trial in its terminal that compacts (the stand-in reports a large conversation):
//     Thermite's PreCompact hook copies the whole transcript, to the last tool result, which
//     Claude Code writes only after the hook starts, and the summary names the kept file (goal
//     070);
//   - an advisor's call as the supervisor's user, with /tmp closed to it (the one-container rig):
//     without CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, with the token on file descriptor 3 and in no
//     process's environment;
//   - every call to the stand-in was signed in with the token;
//   - the image has no bubblewrap: no call of Claude Code needs it.
// It prints the peak memory the broker recorded for Claude Code's runs in its trials, headless and
// in its terminal (the terminal host, Claude Code and its commands), the figure Claude Code's
// limits note states.
//
// Usage: COMPOSE="podman compose" node scripts/acceptance/claude-real.mjs
//   CLAUDE_CODE_VERSION  the version the image is built with (default 2.1.308)
//   IMAGE                an image already built with Claude Code: no build, and it is kept
//   KEEP=1               leave the container and the image
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { cleanEngine, engine } from "./lib/smoke-env.mjs";

const version = process.env.CLAUDE_CODE_VERSION ?? "2.1.308";
const image = process.env.IMAGE ?? "localhost/thermite-harness:claude-real-check";
const name = "thermite-claude-real";
const sh = (args, opts = {}) =>
  execFileSync(engine, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const report = (c) => {
  console.log(
    `${c.ok ? "PASS" : "FAIL"} ${c.name}${c.detail === undefined ? "" : `: ${JSON.stringify(c.detail).slice(0, 600)}`}`,
  );
  // A failed check's own account of why (Claude Code's debug lines, say), in full.
  if (!c.ok && Array.isArray(c.log)) for (const line of c.log) console.log(`  | ${line}`);
  if (!c.ok) failed++;
};
const logs = () => {
  const r = spawnSync(engine, ["logs", name], { encoding: "utf8" });
  return `${r.stdout}${r.stderr}`;
};
const logLine = (msg) =>
  logs()
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return undefined;
      }
    })
    .find((l) => l?.msg === msg);
/** One run of check.mjs in the container; its checks. */
const inside = (user, mode, env = []) => {
  const r = spawnSync(
    engine,
    ["exec", "--user", user, ...env, name, "node", "/opt/test-anthropic/check.mjs", mode],
    { encoding: "utf8", timeout: 900_000 },
  );
  const line = r.stdout.trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(line);
  } catch {
    return {
      checks: [
        { name: `check.mjs ${mode} ran`, ok: false, detail: `${r.stdout}${r.stderr}`.slice(-1500) },
      ],
    };
  }
};

const started = Date.now();
try {
  if (!process.env.IMAGE) {
    console.log(`building the harness image with Claude Code ${version} ...`);
    execFileSync(
      engine,
      [
        "build",
        "-q",
        "-t",
        image,
        "-f",
        "containers/harness/Containerfile",
        "--build-arg",
        `CLAUDE_CODE_VERSION=${version}`,
        ".",
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
  }
  const has = spawnSync(engine, ["run", "--rm", "--entrypoint", "claude", image, "--version"], {
    encoding: "utf8",
  });
  if (has.status !== 0)
    throw new Error(`${image} has no Claude Code: build it with CLAUDE_CODE_VERSION`);
  console.log(`Claude Code in the image: ${has.stdout.trim()}`);
  spawnSync(engine, ["rm", "-f", name], { stdio: "ignore" });
  const { publicKey } = generateKeyPairSync("ed25519");
  sh([
    "run",
    "-d",
    "--name",
    name,
    "--network",
    "none",
    "--memory",
    "2g",
    "--cap-drop",
    "ALL",
    ...["CHOWN", "DAC_OVERRIDE", "FOWNER", "KILL", "SETGID", "SETUID"].flatMap((c) => [
      "--cap-add",
      c,
    ]),
    "--security-opt",
    "no-new-privileges",
    "-e",
    "THERMITE_RIG_ID=claude-real",
    "-e",
    "THERMITE_TARGET=cpu",
    "-e",
    "THERMITE_CALIBRATION_BLOCKS=0",
    "-e",
    "THERMITE_CONTROL_PUBKEY_FILE=/keys/control-signing.pub",
    "-e",
    "THERMITE_SUPERVISOR_TOKEN_FILE=/run/secrets/harness-supervisor-token",
    "-e",
    `TEST_SUPERVISOR_TOKEN=${randomBytes(24).toString("base64url")}`,
    "-e",
    `TEST_CONTROL_PUBKEY=${publicKey.export({ type: "spki", format: "pem" })}`,
    "-v",
    `${resolve("containers/test-anthropic")}:/opt/test-anthropic:ro`,
    "--entrypoint",
    "/opt/test-anthropic/enter",
    image,
  ]);
  const deadline = Date.now() + 180_000;
  while (!logLine("judge ready")) {
    if (Date.now() > deadline)
      throw new Error(`the harness did not start:\n${logs().slice(-3000)}`);
    await sleep(2000);
  }
  const fence = logLine("GPU fence");
  if (fence?.used)
    report({
      name: "the broker runs every role's work under the GPU fence (Landlock)",
      ok: true,
      detail: fence,
    });
  else
    console.log(
      `NOTE this kernel has no Landlock, so the GPU fence is off here: ${JSON.stringify(fence)}`,
    );
  const tmp = sh(["exec", name, "stat", "-c", "%U:%G %a", "/tmp"]).trim();
  report({
    name: "/tmp is closed to the roles, as the broker leaves it",
    ok: tmp === "root:thermite 1770",
    detail: tmp,
  });
  // Claude Code's own sandbox stays off everywhere, so the image carries no bubblewrap, and the
  // calls below pass without it.
  const bwrap = spawnSync(
    engine,
    ["exec", name, "sh", "-c", "if command -v bwrap; then exit 3; else echo none; fi"],
    { encoding: "utf8" },
  );
  report({
    name: "the image has no bubblewrap",
    ok: bwrap.status === 0 && bwrap.stdout.trim() === "none",
    detail: `${bwrap.stdout}${bwrap.stderr}`.trim() || `exit ${bwrap.status}`,
  });

  const results = [inside("10010:10010", "harness")];
  // The supervisor's user, with a temporary folder of its own, as in the one-container rig image.
  sh([
    "exec",
    name,
    "install",
    "-d",
    "-o",
    "10001",
    "-g",
    "10001",
    "-m",
    "0700",
    "/var/lib/claude-real-sup",
  ]);
  results.push(inside("10001:10001", "advisor", ["-e", "TMPDIR=/var/lib/claude-real-sup"]));
  for (const r of results) for (const c of r.checks) report(c);
  const mib = (b) =>
    typeof b === "number"
      ? `${Math.round(b / 2 ** 20)} MiB`
      : "not recorded (the trial did not run)";
  console.log(`Claude Code's peak memory in its trial, headless: ${mib(results[0]?.peakRssBytes)}`);
  console.log(
    `Claude Code's peak memory in its trial, in its terminal with the terminal host: ${mib(results[0]?.peakTerminalRssBytes)}`,
  );
} catch (err) {
  report({
    name: "the test ran",
    ok: false,
    detail: err instanceof Error ? err.message : String(err),
  });
} finally {
  if (process.env.KEEP !== "1") {
    spawnSync(engine, ["rm", "-f", name], { stdio: "ignore" });
    if (!process.env.IMAGE) spawnSync(engine, ["rmi", "-f", image], { stdio: "ignore" });
    cleanEngine();
  }
}
console.log(
  `${failed ? `${failed} FAILED` : "all passed"} in ${Math.round((Date.now() - started) / 1000)} s`,
);
process.exit(failed ? 1 : 0);
