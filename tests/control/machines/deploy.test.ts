import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  deployScript,
  manageScript,
  type RigPlan,
  rigUnits,
  updateScript,
} from "../../../src/control/machines/deploy.ts";

const plan: RigPlan = {
  rig: "gpu-box-1-a",
  controlUrl: "https://control.example.com/",
  images: {
    harness: "registry.example.com/thermite/harness-cuda:0.2.0",
    supervisor: "registry.example.com/thermite/supervisor:0.2.0",
  },
  gpus: [2, 3],
  root: false,
  controlPublicKey: "-----PUBLIC KEY-----\nabc\n",
  controlFingerprint: "sha256:abcd",
};
const secrets = {
  controlToken: "rig-token-$(id)-'quoted'",
  harnessSupervisorToken: "sup-token-xyz",
};

describe("a rig deployed on a machine", () => {
  test("its units mirror the compose rig: two networks, the capabilities, the GPUs through CDI", () => {
    const u = rigUnits(plan);
    assert.deepEqual(Object.keys(u).sort(), [
      "thermite-gpu-box-1-a-egress.network",
      "thermite-gpu-box-1-a-harness.container",
      "thermite-gpu-box-1-a-supervisor.container",
      "thermite-gpu-box-1-a.network",
    ]);
    const h = u["thermite-gpu-box-1-a-harness.container"] ?? "";
    assert.match(h, /^Image=registry\.example\.com\/thermite\/harness-cuda:0\.2\.0$/m);
    assert.match(h, /^Environment=THERMITE_TARGET=cuda-gpu$/m);
    assert.match(h, /^Environment=THERMITE_GPUS=0,1$/m);
    assert.match(h, /^Environment=THERMITE_JUDGE_GPUS=1$/m);
    assert.match(h, /^AddDevice=nvidia\.com\/gpu=2\nAddDevice=nvidia\.com\/gpu=3$/m);
    assert.match(h, /^AddCapability=CHOWN DAC_OVERRIDE FOWNER KILL SETGID SETUID$/m);
    assert.match(h, /^DropCapability=ALL$/m);
    assert.ok(!h.includes("control-rig-token"), "the harness never sees control's token");
    // The harness reads the inbox in its image's closed folder; the supervisor fills it.
    assert.match(h, /^Volume=thermite-gpu-box-1-a-inbox:\/controller\/inbox:ro$/m);
    const s = u["thermite-gpu-box-1-a-supervisor.container"] ?? "";
    assert.match(s, /^Volume=thermite-gpu-box-1-a-inbox:\/inbox:U$/m);
    assert.match(s, /^Environment=CONTROL_URL=https:\/\/control\.example\.com$/m);
    assert.match(s, /^Environment=HARNESS_URL=http:\/\/thermite-gpu-box-1-a-harness:8700$/m);
    assert.match(s, /^Requires=thermite-gpu-box-1-a-harness\.service$/m);
    assert.match(u["thermite-gpu-box-1-a.network"] ?? "", /^Internal=true$/m);
    // A CPU rig has no devices; more GPUs are split, the lowest-numbered for the judge.
    const cpu = rigUnits({ ...plan, gpus: [] })["thermite-gpu-box-1-a-harness.container"] ?? "";
    assert.match(cpu, /^Environment=THERMITE_TARGET=cpu$/m);
    assert.ok(!/AddDevice|GPU_INDEX|THERMITE_GPUS/.test(cpu));
    const four =
      rigUnits({ ...plan, gpus: [2, 3, 5, 7], judgeGpus: 1 })[
        "thermite-gpu-box-1-a-harness.container"
      ] ?? "";
    assert.match(four, /^Environment=THERMITE_GPUS=0,1,2,3$/m);
    assert.match(four, /^Environment=THERMITE_JUDGE_GPUS=1$/m);
    assert.match(four, /^AddDevice=nvidia.com\/gpu=7$/m);
    assert.throws(() => rigUnits({ ...plan, gpus: [0, 1], judgeGpus: 2 }), /judge takes 1 to 1/);
    assert.throws(
      () => rigUnits({ ...plan, gpus: Array.from({ length: 17 }, (_, i) => i) }),
      /at most 16 GPUs/,
    );
  });

  test("each unit names its log driver and limits, and checks its part's health (goal 173)", () => {
    const u = rigUnits(plan);
    for (const [name, port] of [
      ["thermite-gpu-box-1-a-harness.container", 8700],
      ["thermite-gpu-box-1-a-supervisor.container", 8701],
    ] as const) {
      const unit = u[name] ?? "";
      assert.match(unit, /^LogDriver=journald$/m, name);
      assert.match(unit, /^LogRateLimitIntervalSec=30s\nLogRateLimitBurst=10000$/m, name);
      assert.match(
        unit,
        new RegExp(`^HealthCmd=node -e "fetch\\('http://127\\.0\\.0\\.1:${port}/v1/health'`, "m"),
        name,
      );
      assert.match(unit, /^HealthOnFailure=kill$/m, name);
      assert.match(unit, /^HealthStartPeriod=5m$/m, name);
      // The keys sit in their sections: the container's in [Container], the journal's in [Service].
      const container = unit.split("[Service]")[0] ?? "";
      assert.match(container, /HealthCmd=/);
      assert.ok(!container.includes("LogRateLimit"));
      assert.ok(!unit.includes("$"), "nothing for systemd to expand");
    }
  });

  test("the deploy script writes the tokens verbatim through stdin, refuses an existing rig, and starts the services", () => {
    const home = mkdtempSync(join(tmpdir(), "thermite-deploy-"));
    const bin = join(home, "bin");
    execFileSync("mkdir", ["-p", bin]);
    // Stand-ins that record what the script asked for.
    for (const tool of ["systemctl", "podman"])
      execFileSync("sh", [
        "-c",
        `printf '#!/bin/sh\\necho "${tool} $*" >> "$HOME/calls"\\n' > ${bin}/${tool} && chmod +x ${bin}/${tool}`,
      ]);
    const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
    const script = deployScript(plan, secrets);
    assert.ok(
      !script.split("\n").some((l) => l.startsWith("printf") || /echo .*rig-token/.test(l)),
    );
    const out = execFileSync("sh", ["-s"], { input: script, env, encoding: "utf8" });
    assert.match(out, /started/);
    const dir = join(home, ".local/share/thermite/rigs/gpu-box-1-a");
    assert.equal(
      readFileSync(join(dir, "secrets/control-rig-token"), "utf8"),
      `${secrets.controlToken}\n`,
    );
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    // The harness's controller (not the container's root) reads control's public key.
    assert.equal(statSync(join(dir, "keys")).mode & 0o777, 0o755);
    assert.equal(statSync(join(dir, "keys", "control-signing.pub")).mode & 0o777, 0o644);
    assert.equal(statSync(join(dir, "secrets")).mode & 0o777, 0o700);
    assert.deepEqual(
      readdirSync(join(home, ".config/containers/systemd")).sort(),
      Object.keys(rigUnits(plan)).sort(),
    );
    const calls = readFileSync(join(home, "calls"), "utf8");
    assert.match(calls, /^systemctl --user daemon-reload$/m);
    assert.match(
      calls,
      /^podman image exists registry\.example\.com\/thermite\/harness-cuda:0\.2\.0$/m,
    );
    assert.match(
      calls,
      /^systemctl --user start thermite-gpu-box-1-a-harness\.service thermite-gpu-box-1-a-supervisor\.service$/m,
    );
    // A second deploy of the same rig changes nothing.
    assert.throws(
      () => execFileSync("sh", ["-s"], { input: deployScript(plan, secrets), env, stdio: "pipe" }),
      /exists on this machine already/,
    );
    // Removing it takes its units and files away.
    execFileSync("sh", ["-s"], { input: manageScript(plan, "remove"), env });
    assert.deepEqual(readdirSync(join(home, ".config/containers/systemd")), []);
    assert.throws(() => statSync(dir));
  });

  test("with the message bus, its supervisor gets the bus's address and control's authority, at setup and at each update", () => {
    const bus = {
      url: "nats://control.example.com:4222",
      ca: "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n",
    };
    const withBus = { ...plan, bus };
    const s = rigUnits(withBus)["thermite-gpu-box-1-a-supervisor.container"] ?? "";
    assert.match(s, /^Environment=THERMITE_NATS_URL=nats:\/\/control\.example\.com:4222$/m);
    assert.match(s, /^Environment=THERMITE_NATS_CA_FILE=\/keys\/bus-ca\.pem$/m);
    // Its own folder, so that the harness's keys folder keeps its own label.
    assert.match(s, /^Volume=%h\/\.local\/share\/thermite\/rigs\/gpu-box-1-a\/bus:\/keys:ro,Z$/m);
    const h = rigUnits(withBus)["thermite-gpu-box-1-a-harness.container"] ?? "";
    assert.ok(!/NATS|\/bus:/.test(h), "the harness never reaches the bus");
    // Without the bus: none of it.
    assert.ok(
      !/NATS|\/bus:/.test(rigUnits(plan)["thermite-gpu-box-1-a-supervisor.container"] ?? ""),
    );

    const home = mkdtempSync(join(tmpdir(), "thermite-deploy-bus-"));
    const bin = join(home, "bin");
    execFileSync("mkdir", ["-p", bin]);
    for (const tool of ["systemctl", "podman"])
      execFileSync("sh", [
        "-c",
        `printf '#!/bin/sh\\nexit 0\\n' > ${bin}/${tool} && chmod +x ${bin}/${tool}`,
      ]);
    const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
    const dir = join(home, ".local/share/thermite/rigs/gpu-box-1-a");
    const units = join(home, ".config/containers/systemd");
    execFileSync("sh", ["-s"], { input: deployScript(withBus, secrets), env });
    assert.equal(readFileSync(join(dir, "bus", "bus-ca.pem"), "utf8"), bus.ca);
    assert.equal(statSync(join(dir, "bus")).mode & 0o777, 0o755);
    assert.equal(statSync(join(dir, "bus", "bus-ca.pem")).mode & 0o777, 0o644);
    // An update writes control's authority and its address again, as control has them now.
    const later = { url: "nats://bus.example.com:14222", ca: bus.ca.replace("ca", "new-ca") };
    execFileSync("sh", ["-s"], { input: updateScript({ ...withBus, bus: later }), env });
    assert.equal(readFileSync(join(dir, "bus", "bus-ca.pem"), "utf8"), later.ca);
    assert.match(
      readFileSync(join(units, "thermite-gpu-box-1-a-supervisor.container"), "utf8"),
      /^Environment=THERMITE_NATS_URL=nats:\/\/bus\.example\.com:14222$/m,
    );
    // An update of a rig set up before the bus gives it the bus; one with the bus off takes it out.
    execFileSync("sh", ["-s"], { input: updateScript(plan), env });
    assert.ok(
      !/NATS/.test(readFileSync(join(units, "thermite-gpu-box-1-a-supervisor.container"), "utf8")),
    );
  });
});
