import { cardsOf, type GpuLayout, judgeCardOf, type Role, UNSEALED_DIRS } from "../broker/index.ts";

/**
 * What each role probes, and how a result reads: the kinds of probe, the script each role runs,
 * which results fail the selftest, and the probes of the GPU's device nodes.
 */

export interface Probe {
  name: string;
  op:
    | "read"
    | "list"
    | "write"
    | "access"
    | "open"
    | "create"
    | "readable"
    | "reachable"
    | "gpus"
    | "runpod"
    | "sealed"
    | "environ"
    | "connect";
  path: string;
  /**
   * For `gpus`: the only card UUIDs nvidia-smi may list, comma-separated. For `environ`: the
   * variable no environment the role can read may hold. For `connect`: the port on the host
   * `path` names.
   */
  expect?: string;
}

const FAILURES = [
  "ALLOWED",
  "UNREADABLE",
  "UNREACHABLE",
  "WRONG",
  "FOUND",
  "OPENED",
  "MISSING",
  "failed",
];

/**
 * A result that fails the selftest: a probe that must be refused got through (ALLOWED), one that
 * must succeed did not (UNREADABLE, UNREACHABLE), the wrong cards or user (WRONG ...), something
 * found that must not be there (FOUND, OPENED), something missing (MISSING), or a probe that
 * failed to run.
 */
export function isFailure(result: string): boolean {
  return FAILURES.some((m) => result.startsWith(m));
}

/**
 * The probe script each role runs (node -e, the probes as JSON in argv[1]). `runpod` lists /proc
 * (the probe's `path`): RunPod's variables must be in neither the role's own environment nor any
 * process environment it can read; `environ` does the same for one variable (`expect`). `sealed`
 * tries to list the state snapshot's folder and to write an empty file in it (removed again):
 * refused, as it must be where the volume keeps permissions, or, where it does not, "open,
 * sealed" when the folder holds only what a sealed snapshot holds, as inspectSnapshotFolder
 * (broker/snapshot.ts) looks, and "FOUND" with the first thing that is not. `connect` opens a TCP
 * connection to `path` on port `expect`, after the other probes: one that is made is "ALLOWED";
 * one refused, unreachable or not answered in 3 s passes.
 */
export const PROBE = `
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const probes = JSON.parse(process.argv[1]);
const out = {};
const connects = [];
const sealedLook = (dir, names) => {
  let manifest = false, files = 0;
  for (const n of names) {
    const path = dir + "/" + n;
    let st;
    try { st = fs.lstatSync(path); } catch { continue; }
    if (st.isDirectory())
      return { problem: (${JSON.stringify(UNSEALED_DIRS)}.includes(n) ? "an unsealed snapshot an older image left: " : "a folder a sealed snapshot never holds: ") + n };
    if (!st.isFile()) return { problem: "a link or special file a sealed snapshot never holds: " + n };
    const kind = n === "manifest" || n === "manifest.new" ? "M"
      : /^[0-9a-f]{64}$/.test(n) || /^\\.new-[0-9a-f]{32}$/.test(n) ? "B"
      : /^probe-\\d+$/.test(n) ? "P" : "";
    if (!kind) return { problem: "a name a sealed snapshot never uses: " + n };
    if (st.size === 0) continue;
    if (kind === "P") return { problem: "a file that is not sealed: " + n };
    let head;
    try {
      const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try { const b = Buffer.alloc(9); head = b.subarray(0, fs.readSync(fd, b, 0, 9, 0)); } finally { fs.closeSync(fd); }
    } catch { continue; }
    if (head.toString("latin1") !== "THMSEAL1" + kind) return { problem: "a file that is not sealed: " + n };
    if (n === "manifest") manifest = true;
    else if (/^[0-9a-f]{64}$/.test(n)) files++;
  }
  const count = files + " sealed file" + (files === 1 ? "" : "s");
  return { words: !manifest && !files ? "no snapshot yet" : manifest ? "the manifest and " + count : count + " and no manifest" };
};
for (const p of probes) {
  if (p.op === "connect") {
    connects.push(p);
    continue;
  }
  if (p.op === "environ") {
    const found = Object.keys(process.env).filter((k) => k === p.expect).map((k) => k + " (own)");
    try {
      for (const pid of fs.readdirSync(p.path).filter((d) => /^\\d+$/.test(d))) {
        let text;
        try {
          text = fs.readFileSync(p.path + "/" + pid + "/environ", "latin1");
        } catch {
          continue;
        }
        if (text.split("\\0").some((kv) => kv.startsWith(p.expect + "="))) found.push(p.expect + " (pid " + pid + ")");
      }
      out[p.name] = found.length ? "FOUND " + found.slice(0, 8).join(", ") : "none";
    } catch (e) {
      out[p.name] = "failed: " + (e.code || String(e));
    }
    continue;
  }
  if (p.op === "sealed") {
    let names, list = "", create = "";
    try { names = fs.readdirSync(p.path).sort(); } catch (e) { list = e.code || String(e); }
    const mine = p.path + "/probe-" + process.getuid();
    try {
      fs.writeFileSync(mine, "", { flag: "wx" });
      try { fs.rmSync(mine); } catch {}
    } catch (e) { create = e.code || String(e); }
    if (!names && create) { out[p.name] = list; continue; }
    const look = names ? sealedLook(p.path, names) : { words: "can't list it" };
    const can = names && !create ? "lists it and writes in it" : names ? "lists it" : "writes in it";
    out[p.name] = look.problem ? "FOUND " + look.problem : "open, sealed: " + can + "; " + look.words;
    continue;
  }
  if (p.op === "runpod") {
    const found = Object.keys(process.env).filter((k) => k.startsWith("RUNPOD_")).map((k) => k + " (own)");
    try {
      for (const pid of fs.readdirSync(p.path).filter((d) => /^\\d+$/.test(d))) {
        let text;
        try {
          text = fs.readFileSync(p.path + "/" + pid + "/environ", "latin1");
        } catch {
          continue;
        }
        for (const kv of text.split("\\0"))
          if (kv.startsWith("RUNPOD_")) found.push(kv.split("=")[0] + " (pid " + pid + ")");
      }
      out[p.name] = found.length ? "FOUND " + found.slice(0, 8).join(", ") : "none";
    } catch (e) {
      out[p.name] = "failed: " + (e.code || String(e));
    }
    continue;
  }
  if (p.op === "gpus") {
    // A card whose node is refused is silently left out, so check exactly which cards show.
    let ids = "";
    try {
      const listed = execFileSync("nvidia-smi", ["-L"], { encoding: "utf8" });
      ids = [...listed.matchAll(/UUID: (GPU-[0-9a-fA-F-]+)/g)].map((m) => m[1]).join(",");
    } catch (e) {
      ids = "none (" + (e.code || e.status) + ")";
    }
    out[p.name] = ids === p.expect ? "sees " + ids : "WRONG GPUS " + ids;
    continue;
  }
  try {
    if (p.op === "read" || p.op === "readable") fs.readFileSync(p.path);
    else if (p.op === "list") fs.readdirSync(p.path);
    else if (p.op === "write") fs.writeFileSync(p.path, "tampered", { flag: "r+" });
    else if (p.op === "create") fs.writeFileSync(p.path + "/probe-" + process.getuid(), "x");
    // A device node is opened for real (and closed): file modes and the Landlock fence both
    // act on opening, while access() sees only the modes.
    else if (p.op === "reachable" || p.op === "open") fs.closeSync(fs.openSync(p.path, "r+"));
    else fs.accessSync(p.path, fs.constants.W_OK);
    out[p.name] = p.op === "readable" || p.op === "reachable" ? p.op : "ALLOWED";
  } catch (e) {
    const must = { readable: "UNREADABLE ", reachable: "UNREACHABLE " }[p.op] || "";
    out[p.name] = must + (e.code || String(e));
  }
}
const connect = (p) => new Promise((done) => {
  const socket = require("node:net").connect({ host: p.path, port: Number(p.expect), timeout: 3000 });
  const end = (result) => { socket.destroy(); done(result); };
  socket.on("connect", () => end("ALLOWED: connected to " + p.path + " port " + p.expect));
  socket.on("timeout", () => end("no answer in 3 s"));
  socket.on("error", (e) => end(e.code || String(e)));
});
Promise.all(connects.map(async (p) => { out[p.name] = await connect(p); })).then(() =>
  process.stdout.write(JSON.stringify(out)),
);
`;

/** Who a role is to the device: the run user, a development run, or neither. */
export function deviceSide(role: Role, gpu: boolean): "judge" | "dev" | "other" {
  if (judgeCardOf(role) !== undefined) return "judge";
  return gpu || role.endsWith("-dev") ? "dev" : "other";
}

/**
 * The device-node probes for one side. In shared mode the run user and development runs reach
 * every node and are not probed; everyone else is refused every node. With dedicated cards each
 * judge identity and each development card must reach its own card and the shared nodes, and be
 * refused every other card, and nvidia-smi must list exactly its own card.
 */
export function deviceProbes(
  nodes: string[],
  side: "judge" | "dev" | "other",
  layout?: GpuLayout | undefined,
  card = 0,
): Probe[] {
  const refuse = (p: string): Probe => ({ name: `device:${p.slice(5)}`, op: "open", path: p });
  const reach = (p: string): Probe => ({ name: `device:${p.slice(5)}`, op: "reachable", path: p });
  if (side === "other") return nodes.map(refuse);
  if (!layout) return [];
  const { judges, devs } = cardsOf(layout);
  const own = (side === "judge" ? judges : devs)[card];
  if (!own) throw new Error(`no ${side === "judge" ? "judge" : "development"} card ${card + 1}`);
  const others = [...judges, ...devs].filter((c) => c.node !== own.node);
  return [
    reach(own.node),
    ...layout.control.map(reach),
    ...others.map((c) => refuse(c.node)),
    { name: "visible-gpus", op: "gpus", path: "nvidia-smi", expect: own.uuid },
  ];
}
