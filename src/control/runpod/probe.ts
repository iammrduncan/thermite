/**
 * The test a RunPod test pod runs: Thermite's own harness image, started with this script in
 * place of the broker (node -e, from the THERMITE_PROBE_JS variable, base64). As root, it reads
 * what a rig depends on (its capabilities, the GPU device nodes and whether it can give them to
 * a group, RunPod's own variables and whether a role's user can read them, outbound HTTPS),
 * then starts the broker as a rig would and runs `thermite selftest isolation`.
 *
 * It serves what it found at http://0.0.0.0:8000/<THERMITE_PROBE_TOKEN>/report.json, which
 * control reads through RunPod's HTTP proxy. The proxy is public, so the report holds only names
 * and results, never a variable's value, and is served only under the unguessable token.
 */

export const PROBE_PORT = 8000;

/** CommonJS, Node built-ins only, no backticks: it runs as `node -e` in the harness image. */
export const PROBE_JS = String.raw`
"use strict";
const fs = require("node:fs");
const cp = require("node:child_process");
const http = require("node:http");
const os = require("node:os");
const crypto = require("node:crypto");
const TOKEN = process.env.THERMITE_PROBE_TOKEN || "";
const report = { version: 1, phase: "collecting", started_at: new Date().toISOString(), steps: {} };
http
  .createServer((req, res) => {
    if (!TOKEN || req.url !== "/" + TOKEN + "/report.json") {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(report));
  })
  .listen(8000, "0.0.0.0");
const errText = (e) => String((e && (e.code || e.message)) || e).slice(0, 2000);
const step = async (name, fn) => {
  const t = Date.now();
  try {
    report.steps[name] = { ok: true, value: await fn() };
  } catch (e) {
    report.steps[name] = { ok: false, error: errText(e) };
  }
  report.steps[name].ms = Date.now() - t;
};
const run = (cmd, args, opts) =>
  cp
    .execFileSync(cmd, args, Object.assign({ encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] }, opts || {}))
    .trim();
const CAPS = ["chown", "dac_override", "dac_read_search", "fowner", "fsetid", "kill", "setgid",
  "setuid", "setpcap", "linux_immutable", "net_bind_service", "net_broadcast", "net_admin",
  "net_raw", "ipc_lock", "ipc_owner", "sys_module", "sys_rawio", "sys_chroot", "sys_ptrace",
  "sys_pacct", "sys_admin", "sys_boot", "sys_nice", "sys_resource", "sys_time",
  "sys_tty_config", "mknod", "lease", "audit_write", "audit_control", "setfcap",
  "mac_override", "mac_admin", "syslog", "wake_alarm", "block_suspend", "audit_read",
  "perfmon", "bpf", "checkpoint_restore"];
const capsOf = (hex) => {
  const v = BigInt("0x" + (hex || "0"));
  return CAPS.filter((_, i) => (v >> BigInt(i)) & 1n);
};
const statusField = (k) => {
  const m = fs.readFileSync("/proc/self/status", "utf8").match(new RegExp("^" + k + ":\\s*(\\S+)", "m"));
  return m ? m[1] : "";
};
const gpuNodes = () => fs.readdirSync("/dev").filter((n) => /^nvidia\d+$/.test(n));
const LANE = 10101; // lane-1, as the image creates it

(async () => {
  await step("machine", () => ({
    uid: process.getuid(),
    hostname: os.hostname(),
    cpus: os.cpus().length,
    memory_gb: Math.round(os.totalmem() / 1e9),
    kernel: os.release(),
    boot_id: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    container_started_s_ago: Math.round(os.uptime()),
    disk: run("df", ["-h", "/"]),
  }));
  await step("capabilities", () => ({
    effective: capsOf(statusField("CapEff")),
    bounding: capsOf(statusField("CapBnd")),
    no_new_privs: statusField("NoNewPrivs") === "1",
    seccomp: statusField("Seccomp"),
  }));
  await step("gpus", () => ({
    list: run("nvidia-smi", ["-L"]),
    detail: run("nvidia-smi", ["--query-gpu=name,driver_version,memory.total,uuid", "--format=csv,noheader"]),
  }));
  await step("device_nodes", () =>
    fs.readdirSync("/dev").filter((n) => n.startsWith("nvidia")).map((n) => {
      const st = fs.statSync("/dev/" + n);
      return { node: n, uid: st.uid, gid: st.gid, mode: (st.mode & 0o7777).toString(8) };
    }),
  );
  // The broker gives each card to a group, mode 0660. Each change is put back afterwards, so
  // the broker started below does it itself.
  await step("device_chown", () => {
    const out = {};
    for (const n of gpuNodes()) {
      const p = "/dev/" + n;
      const st = fs.statSync(p);
      try {
        fs.chownSync(p, 0, 10500);
        fs.chmodSync(p, 0o660);
        const s2 = fs.statSync(p);
        out[n] = s2.gid === 10500 && (s2.mode & 0o777) === 0o660 ? "ok" : "unchanged";
      } catch (e) {
        out[n] = errText(e);
      } finally {
        try {
          fs.chownSync(p, st.uid, st.gid);
          fs.chmodSync(p, st.mode & 0o7777);
        } catch {}
      }
    }
    return out;
  });
  // The GPU fence (thermite-devfence, a Landlock rule set): what the kernel offers, and whether a
  // fenced lane-1 really can't open a card.
  await step("gpu_fence", () => {
    const abi = Number(run("/usr/local/bin/thermite-devfence", ["--abi"])) || 0;
    const card = gpuNodes()[0];
    let fenced = "no card node";
    if (abi && card) {
      try {
        run("/usr/local/bin/thermite-devfence", ["--", process.execPath, "-e", "require('fs').closeSync(require('fs').openSync('/dev/" + card + "','r+'))"], { uid: LANE, gid: LANE, env: {} });
        fenced = "OPENED";
      } catch (e) {
        fenced = /EACCES|permission denied/i.test(String(e.stderr || e.message)) ? "refused" : errText(e);
      }
    }
    return { landlock_abi: abi, lane_opens_card: fenced };
  });
  await step("temp_modes", () => {
    const out = {};
    for (const p of ["/tmp", "/dev/shm"]) {
      const st = fs.statSync(p);
      try {
        fs.chmodSync(p, 0o1770);
        out[p] = (fs.statSync(p).mode & 0o7777) === 0o1770 ? "ok" : "unchanged";
      } catch (e) {
        out[p] = errText(e);
      } finally {
        try {
          fs.chmodSync(p, st.mode & 0o7777);
        } catch {}
      }
    }
    return out;
  });
  // RunPod's variables: their names only (one may be a pod-scoped API key).
  await step("runpod_variables", () => {
    const inFiles = {};
    for (const f of ["/etc/environment", "/etc/rp_environment"]) {
      try {
        inFiles[f] = [...new Set(fs.readFileSync(f, "utf8").match(/RUNPOD_[A-Z0-9_]+/g) || [])];
      } catch (e) {
        inFiles[f] = errText(e);
      }
    }
    const names = Object.keys(process.env).filter((k) => k.startsWith("RUNPOD_")).sort();
    return {
      in_environment: names,
      in_files: inFiles,
      // The one-container rig image's entry point takes them out before anything starts, and
      // passes the pod's ID on as THERMITE_TUNNEL_POD: that variable shows RunPod did set them.
      removed_by_entry_point: names.length === 0 && Boolean(process.env.THERMITE_TUNNEL_POD),
    };
  });
  // What a role's user (lane-1, with an empty environment, as the broker starts roles) can read
  // of them: PID 1's environment and the files above.
  await step("role_reads_runpod_variables", () => {
    const code =
      "const fs=require('fs');const r={};" +
      "try{r.pid1=fs.readFileSync('/proc/1/environ','utf8').split(String.fromCharCode(0)).filter(x=>x.startsWith('RUNPOD_')).map(x=>x.split('=')[0])}catch(e){r.pid1=e.code||String(e)}" +
      "for(const f of ['/etc/environment','/etc/rp_environment']){try{r[f]=(fs.readFileSync(f,'utf8').match(/RUNPOD_[A-Z0-9_]+/g)||[]).length+' names'}catch(e){r[f]=e.code||String(e)}}" +
      "r.own=Object.keys(process.env).filter(k=>k.startsWith('RUNPOD_'));console.log(JSON.stringify(r))";
    return JSON.parse(run(process.execPath, ["-e", code], { uid: LANE, gid: LANE, env: {} }));
  });
  await step("outbound_https", async () => {
    const out = {};
    for (const u of ["https://github.com", "https://ghcr.io/v2/", "https://huggingface.co",
      "https://api.openai.com/v1/models", "https://registry.npmjs.org/", "https://pypi.org/simple/"]) {
      const t = Date.now();
      try {
        const r = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(15000) });
        out[u] = { status: r.status, ms: Date.now() - t };
      } catch (e) {
        out[u] = { error: errText(e.cause || e), ms: Date.now() - t };
      }
    }
    return out;
  });
  // The broker as a rig starts it (one card shared by the judge and the agents), then the
  // isolation self-test against it. The controller it starts has no control to talk to here;
  // the self-test needs only the broker.
  report.phase = "selftest";
  await step("isolation_selftest", async () => {
    const dir = "/run/thermite-probe";
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const f of ["supervisor-token", "proposer-token"])
      fs.writeFileSync(dir + "/" + f, crypto.randomBytes(24).toString("hex"), { mode: 0o600 });
    const env = Object.assign({}, process.env, {
      THERMITE_RIG_ID: "runpod-test",
      THERMITE_TARGET: "cuda-gpu",
      THERMITE_SUPERVISOR_TOKEN_FILE: dir + "/supervisor-token",
      THERMITE_PROPOSER_TOKEN_FILE: dir + "/proposer-token",
    });
    delete env.THERMITE_PROBE_JS;
    delete env.THERMITE_PROBE_TOKEN;
    // The one-container rig image runs in pull mode, whose broker waits for an enrollment a test
    // pod never has. Without pull mode's variables it starts as such a rig's broker otherwise
    // does, the supervisor's places included.
    for (const k of Object.keys(env)) if (k.startsWith("THERMITE_TUNNEL_")) delete env[k];
    let log = "";
    const keep = (b) => {
      log = (log + b.toString()).slice(-20000);
    };
    const broker = cp.spawn(process.execPath, ["/opt/thermite/dist/harness/broker/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
    broker.stdout.on("data", keep);
    broker.stderr.on("data", keep);
    const sock = "/run/thermite/broker.sock";
    const t0 = Date.now();
    while (!fs.existsSync(sock) && Date.now() - t0 < 180000) await new Promise((r) => setTimeout(r, 1000));
    if (!fs.existsSync(sock)) throw new Error("the broker did not start: " + log.slice(-3000));
    await new Promise((r) => setTimeout(r, 5000));
    const r = cp.spawnSync(process.execPath, ["/opt/thermite/dist/cli/thermite/main.js", "selftest", "isolation", "--force"], { env, encoding: "utf8", timeout: 600000 });
    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {}
    return {
      exit: r.status,
      passed: r.status === 0,
      report: parsed,
      stdout: parsed ? undefined : (r.stdout || "").slice(-4000),
      stderr: (r.stderr || "").slice(-4000),
      broker_log: log.slice(-4000),
    };
  });
  report.phase = "done";
  report.done_at = new Date().toISOString();
})().catch((e) => {
  report.phase = "done";
  report.error = errText(e);
});
`;

/** The variables a test pod gets: the probe and the token its report is served under. */
export function probeEnv(token: string): Record<string, string> {
  return {
    THERMITE_PROBE_TOKEN: token,
    THERMITE_PROBE_JS: Buffer.from(PROBE_JS).toString("base64"),
  };
}

/** The pod's command: the probe in place of the broker (tini stays PID 1). */
export const PROBE_CMD = [
  "node",
  "-e",
  "eval(Buffer.from(process.env.THERMITE_PROBE_JS,'base64').toString('utf8'))",
];
