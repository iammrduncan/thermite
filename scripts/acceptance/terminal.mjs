#!/usr/bin/env node
// The terminal host in the harness image (goal 169): the image as a rig runs it (the broker as
// root, which closes /tmp to the roles and puts each role's work under the GPU fence; only the
// broker's capabilities; no new privileges; no network at all), with the host run by the broker as
// lane-1, as a trial will run it. tests/stand-ins/terminal/check.mjs runs inside, as the
// controller's user: the fake TUI (tests/helpers/fake-tui.ts) through every request of the host;
// the real Codex CLI and OpenCode (its server first, then its terminal) in their own terminals,
// against a stand-in model; and the real Claude Code when the image has it, against
// containers/test-anthropic's stand-in, with a made-up sign-in; then one short trial through the
// trial loop's terminal mode for the fake TUI, the real Codex and the real OpenCode, with each
// trial's last screen kept in memory, and the owner's input (terminal_input's) typed through a
// trial's console into the fake TUI and the real Codex; then a full usage window (goal 169): the
// fake, as Claude Code, waits for its reset and goes on by itself, and the real OpenCode meets the
// stand-in model's 429 and the loop types its continuation after the reset; each wait recorded,
// nothing typed during it, and the owner's input queued during it typed after the reset
// (tests/stand-ins/terminal/trials.mjs); then a worker in Pi in its Pi view, run by the broker as
// agent-1 in its own folder, one short trial to its result with the owner's inputs through its
// console, and what lane-1 and another agent may reach of that folder
// (tests/stand-ins/terminal/pi-view.mjs). Then the supervisor image: root serves the advisors'
// runner as the image's entry does, and the supervisor's user starts the host through it on the
// fake TUI, as an advisor user in a folder of its own, as an advisor's call in its terminal runs
// it; another advisor user may reach none of it (tests/stand-ins/terminal/supervisor.mjs). It
// downloads nothing but what the images' builds do, and no model is called.
//
// Usage: COMPOSE="podman compose" node scripts/acceptance/terminal.mjs
//   IMAGE      an image already built: no build, and it is kept (one built with
//              CLAUDE_CODE_VERSION, such as claude-real.mjs's, checks Claude Code too)
//   SUPERVISOR_IMAGE  a supervisor image already built: no build, and it is kept
//   SOURCE=1   the check runs this working copy's code (src/, as TypeScript) with the image's
//              packages, instead of the image's build: no build is needed for a change to src/
//   KEEP=1     leave the container and the image
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { cleanEngine, engine } from "./lib/smoke-env.mjs";

const image = process.env.IMAGE ?? "localhost/thermite-harness:terminal-check";
const name = "thermite-terminal";
const supervisorImage =
  process.env.SUPERVISOR_IMAGE ?? "localhost/thermite-supervisor:terminal-check";
const supervisorName = "thermite-terminal-supervisor";
const source = process.env.SOURCE === "1";
const sh = (args, opts = {}) =>
  execFileSync(engine, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const report = (c) => {
  console.log(
    `${c.ok ? "PASS" : "FAIL"} ${c.name}${c.detail === undefined || c.detail === "" ? "" : `: ${JSON.stringify(c.detail).slice(0, 800)}`}`,
  );
  if (!c.ok) failed++;
};
const logs = () => {
  const r = spawnSync(engine, ["logs", name], { encoding: "utf8" });
  return `${r.stdout}${r.stderr}`;
};
const ready = () => logs().includes('"msg":"judge ready"');

const started = Date.now();
try {
  if (!process.env.IMAGE) {
    console.log("building the harness image ...");
    execFileSync(
      engine,
      ["build", "-q", "-t", image, "-f", "containers/harness/Containerfile", "."],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
  }
  spawnSync(engine, ["rm", "-f", name], { stdio: "ignore" });
  const { publicKey } = generateKeyPairSync("ed25519");
  // The working copy's code, beside the image's packages (node-pty built for the image).
  const sourceMounts = source
    ? ["src", "package.json"].flatMap((p) => ["-v", `${resolve(p)}:/opt/thermite-src/${p}:ro`])
    : [];
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
    "THERMITE_RIG_ID=terminal-check",
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
    "-v",
    `${resolve("tests/stand-ins/terminal")}:/opt/test-terminal:ro`,
    "-v",
    `${resolve("tests/helpers/fake-tui.ts")}:/opt/fake-tui/fake-tui.ts:ro`,
    ...sourceMounts,
    "--entrypoint",
    "/opt/test-anthropic/enter",
    image,
  ]);
  if (source)
    sh(["exec", name, "ln", "-s", "/opt/thermite/node_modules", "/opt/thermite-src/node_modules"]);
  const deadline = Date.now() + 180_000;
  while (!ready()) {
    if (Date.now() > deadline)
      throw new Error(`the harness did not start:\n${logs().slice(-3000)}`);
    await sleep(2000);
  }
  const r = spawnSync(
    engine,
    [
      "exec",
      "--user",
      "10010:10010",
      ...(source ? ["-e", "THERMITE_SRC=/opt/thermite-src/src"] : []),
      name,
      "node",
      "/opt/test-terminal/check.mjs",
    ],
    { encoding: "utf8", timeout: 900_000 },
  );
  const line = r.stdout.trim().split("\n").at(-1) ?? "";
  let out;
  try {
    out = JSON.parse(line);
  } catch {
    out = {
      checks: [{ name: "check.mjs ran", ok: false, detail: `${r.stdout}${r.stderr}`.slice(-2000) }],
    };
  }
  for (const c of out.checks) report(c);
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
  }
}

// The supervisor image: the host as an advisor's call in its terminal runs it (goal 169).
try {
  if (!process.env.SUPERVISOR_IMAGE) {
    console.log("building the supervisor image ...");
    execFileSync(
      engine,
      ["build", "-q", "-t", supervisorImage, "-f", "containers/supervisor/Containerfile", "."],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
  }
  spawnSync(engine, ["rm", "-f", supervisorName], { stdio: "ignore" });
  const sourceMounts = source
    ? ["src", "package.json"].flatMap((p) => ["-v", `${resolve(p)}:/opt/thermite-src/${p}:ro`])
    : [];
  // As compose runs it: only the entry's capabilities, no new privileges, here no network at all.
  // The image's entry is not started: the check serves the runner itself, as the entry does.
  sh([
    "run",
    "-d",
    "--name",
    supervisorName,
    "--network",
    "none",
    "--memory",
    "1g",
    "--cap-drop",
    "ALL",
    ...["CHOWN", "DAC_OVERRIDE", "FOWNER", "KILL", "SETGID", "SETUID"].flatMap((c) => [
      "--cap-add",
      c,
    ]),
    "--security-opt",
    "no-new-privileges",
    "-v",
    `${resolve("tests/stand-ins/terminal")}:/opt/test-terminal:ro`,
    "-v",
    `${resolve("tests/helpers/fake-tui.ts")}:/opt/fake-tui/fake-tui.ts:ro`,
    ...sourceMounts,
    supervisorImage,
    "node",
    "-e",
    "setInterval(() => {}, 1 << 30)",
  ]);
  if (source)
    sh([
      "exec",
      supervisorName,
      "ln",
      "-s",
      "/opt/thermite/node_modules",
      "/opt/thermite-src/node_modules",
    ]);
  const r = spawnSync(
    engine,
    [
      "exec",
      "--user",
      "0:0",
      ...(source ? ["-e", "THERMITE_SRC=/opt/thermite-src/src"] : []),
      supervisorName,
      "node",
      "/opt/test-terminal/supervisor.mjs",
    ],
    { encoding: "utf8", timeout: 360_000 },
  );
  const line = r.stdout.trim().split("\n").at(-1) ?? "";
  let out;
  try {
    out = JSON.parse(line);
  } catch {
    out = {
      checks: [
        { name: "supervisor.mjs ran", ok: false, detail: `${r.stdout}${r.stderr}`.slice(-2000) },
      ],
    };
  }
  for (const c of out.checks) report({ ...c, name: `supervisor image: ${c.name}` });
} catch (err) {
  report({
    name: "the supervisor image's part ran",
    ok: false,
    detail: err instanceof Error ? err.message : String(err),
  });
} finally {
  if (process.env.KEEP !== "1") {
    spawnSync(engine, ["rm", "-f", supervisorName], { stdio: "ignore" });
    if (!process.env.SUPERVISOR_IMAGE)
      spawnSync(engine, ["rmi", "-f", supervisorImage], { stdio: "ignore" });
    cleanEngine();
  }
}
console.log(
  `${failed ? `${failed} FAILED` : "all passed"} in ${Math.round((Date.now() - started) / 1000)} s`,
);
process.exit(failed ? 1 : 0);
