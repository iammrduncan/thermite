import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { log } from "../common/env.ts";
import { errorText } from "../common/errors.ts";
import { writeAtomic } from "../common/fs.ts";
import { sameSecret } from "../common/secrets.ts";
import { readNumber } from "../common/settings.ts";
import {
  controlCodeProof,
  ENROLLED_FILES,
  EnrollRequest,
  ExchangeIn,
  enrollmentProof,
  generateTunnelKeys,
  keySha256,
  open,
  type PodConfig,
  podTunnelDirs,
  publicKeyFromLine,
  type RequestHead,
  sameHex,
  seal,
  signAnswer,
  TUNNEL_MAX_REQUEST,
  TUNNEL_NONCE_MS,
  TUNNEL_SKEW_MS,
  type TunnelKeys,
  verifyRequest,
} from "../core/tunnel.ts";
import { BUILD_HEADERS } from "../core/version.ts";
import { SUPERVISOR_NUMBERS } from "./settings.ts";

/**
 * The rig's end of the tunnel, for a rig in pull mode: one control connects to, through a public
 * proxy (a RunPod pod: docs/plan/goals/_completed/019-rig-only-entry.goal). The rig never connects to
 * control. Instead:
 *
 * - The supervisor makes its calls to control over HTTPS at a local address (127.0.0.1) that takes
 *   only the supervisor's own token: the registration of its keys on the message bus, and its
 *   results (champions' patches, exports) and kits by git. Everything else goes on the bus,
 *   through the pod's leaf node (leaf.ts). Each call waits there as a request for control.
 * - Control connects to the public port, behind the proxy, and in each exchange collects the
 *   waiting requests and returns the answers to earlier ones. Control answers them as this rig.
 *
 * The public port answers only a request control signed for this rig and this pod, fresh and
 * never seen before, under the secret path. Everything else, on either port, gets the same empty
 * 404; a wrong path is refused before its body is read. Bodies are sealed both ways and answers
 * are signed, so the proxy only moves bytes.
 *
 * Enrollment: the launch gives the pod the SHA-256 of control's key and a one-time code. Control's
 * first request brings its key, a proof that it holds the code, and the rig's settings; the pod
 * answers with the keys it made at its first start, bound to the code. Control's first exchange
 * (sealed to those keys, so control has pinned them) completes it: the pod writes control's key
 * and the rig's settings for the harness, and the code is spent.
 */

export interface PodTunnelOptions {
  rig: string;
  /** The pod's ID, as control knows it (RUNPOD_POD_ID). */
  pod: string;
  /** The secret path prefix control set at launch (no slashes). */
  prefix: string;
  /** The SHA-256 of control's command-signing public key, as the launch named it. */
  controlKeySha256: string;
  /** This rig's X25519 key at control: what goes to control is sealed to it. */
  controlBoxPublicPem: string;
  /** The one-time enrollment code from launch. */
  enrollCode: string;
  /** When the code expires (milliseconds since the epoch); not set: it does not expire. */
  enrollUntil?: number | undefined;
  /** The tunnel's private state: this rig's keys, the enrollment and the nonces seen (0700). */
  dir: string;
  /** Where enrollment leaves control's key and the rig's settings for the harness. */
  enrolledDir: string;
  /** The public port (all interfaces, for the proxy) and the supervisor's local one (0: any). */
  publicPort: number;
  localPort: number;
  /** The token the supervisor's calls to the local port carry. */
  localToken: string;
  now?: () => number;
  /** How long a supervisor's call waits for control's answer. */
  callTimeoutMs?: number;
}

interface Waiting {
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
  respond: (status: number, headers: Record<string, string>, body: Buffer) => void;
  /** When it last went to control (0: never). Unanswered calls go again after a while. */
  offeredAt: number;
  /** The parts of a large answer received so far. */
  parts?: Buffer[];
}

/** What the enrollment left: control's key and the rig's settings; done once control pinned. */
interface Enrollment {
  control_key: string;
  config: PodConfig;
  answered_at: string;
  done_at?: string;
}

/** The supervisor's calls: at most this many bytes each (control takes a champion of 64 MB). */
const MAX_LOCAL_CALL = 64 * 1024 * 1024;
/** One exchange hands control at most this many bytes of calls (and always at least one call). */
const MAX_CALLS_PER_EXCHANGE = 64 * 1024 * 1024;
/** A refused request's body is let through unread up to this size, then cut off. */
const DISCARD_MAX = 4 * TUNNEL_MAX_REQUEST;
/** At most this many of the supervisor's calls wait at once; more are refused (503). */
const MAX_WAITING = 64;
/** Requests to the public port in any one second, refused or not. */
const MAX_PER_SECOND = 20;
/** Long-poll: an exchange with nothing to collect waits at most this long for a new call. */
const MAX_HOLD_MS = 25_000;
/** A call control has not answered is offered again after this long. */
const REOFFER_MS = 5_000;
/** Headers of the supervisor's calls carried to control (never its token): its build too. */
const CARRIED = [
  "content-type",
  "accept",
  "git-protocol",
  "content-encoding",
  ...Object.values(BUILD_HEADERS),
];

/** This rig's keys: made once, at the first start, then read back (mode 0600). */
export function podKeys(dir: string): TunnelKeys {
  const path = join(dir, "keys.json");
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as TunnelKeys;
  const keys = generateTunnelKeys();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(keys), { mode: 0o600, flag: "wx" });
  return keys;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        resolve(undefined);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(undefined));
  });
}

export class PodTunnel {
  private readonly o: PodTunnelOptions;
  private readonly keys: TunnelKeys;
  private readonly now: () => number;
  private readonly nonces = new Map<string, number>();
  private readonly waiting = new Map<string, Waiting>();
  private enrollment: Enrollment | undefined;
  private holders: (() => void)[] = [];
  private second = { at: 0, n: 0 };
  /** Requests refused on either port since the last exchange (reported to control). */
  private refused = 0;
  private servers: Server[] = [];

  constructor(o: PodTunnelOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    mkdirSync(o.dir, { recursive: true, mode: 0o700 });
    chmodSync(o.dir, 0o700);
    this.keys = podKeys(o.dir);
    const enrollPath = join(o.dir, "enrollment.json");
    if (existsSync(enrollPath))
      this.enrollment = JSON.parse(readFileSync(enrollPath, "utf8")) as Enrollment;
    const noncePath = join(o.dir, "nonces.json");
    if (existsSync(noncePath))
      for (const [n, until] of JSON.parse(readFileSync(noncePath, "utf8")) as [string, number][])
        this.nonces.set(n, until);
    // Enrolled before a restart: the harness's files again, in case they were on a fresh disk.
    if (this.enrollment?.done_at) this.writeEnrolled(this.enrollment);
  }

  publicKeys(): { sign: string; box: string } {
    return { sign: this.keys.signPublicPem, box: this.keys.boxPublicPem };
  }

  /** True once control has pinned this rig's keys and the code is spent. */
  enrolled(): boolean {
    return Boolean(this.enrollment?.done_at);
  }

  async start(): Promise<void> {
    const pub = createServer((req, res) => {
      void this.onPublic(req, res);
    });
    // Small and short: headers in 10 s, the whole request in 60 s, few connections at once.
    pub.headersTimeout = 10_000;
    pub.requestTimeout = 60_000;
    pub.maxHeadersCount = 30;
    pub.maxConnections = 4;
    const local = createServer((req, res) => {
      void this.onLocal(req, res);
    });
    const listen = (s: Server, port: number, host: string) =>
      new Promise<void>((resolve, reject) => {
        s.once("error", reject);
        s.listen(port, host, () => {
          s.off("error", reject);
          resolve();
        });
      });
    await Promise.all([
      listen(pub, this.o.publicPort, "0.0.0.0"),
      listen(local, this.o.localPort, "127.0.0.1"),
    ]);
    this.servers = [pub, local];
    log("supervisor", "pull mode: listening for control", {
      ...this.ports(),
      enrolled: this.enrolled(),
    });
  }

  /** The ports listened on (the ones given, or those the system chose for 0). */
  ports(): { public_port: number; local_port: number } {
    const port = (s?: Server) => {
      const a = s?.address();
      return typeof a === "object" && a ? a.port : 0;
    };
    return { public_port: port(this.servers[0]), local_port: port(this.servers[1]) };
  }

  async stop(): Promise<void> {
    for (const w of this.waiting.values()) w.respond(503, {}, Buffer.from("stopping"));
    this.waiting.clear();
    for (const wake of this.holders) wake();
    this.holders = [];
    await Promise.all(this.servers.map((s) => new Promise((r) => s.close(() => r(null)))));
  }

  /** The same empty 404 for everything refused: nothing says why. */
  private nothing(res: ServerResponse): void {
    this.refused++;
    res.writeHead(404, { "content-length": "0" });
    res.end();
  }

  /**
   * Refused before its body is read: the body is let through unread, then the same 404 (answered
   * while a body still comes in, the connection would end in a reset instead). One that goes on
   * past DISCARD_MAX is cut off.
   */
  private refuse(req: IncomingMessage, res: ServerResponse): void {
    if (req.complete) {
      this.nothing(res);
      return;
    }
    let seen = 0;
    req.on("data", (c: Buffer) => {
      seen += c.length;
      if (seen > DISCARD_MAX) req.destroy();
    });
    req.on("end", () => this.nothing(res));
    req.on("error", () => {
      this.refused++;
    });
  }

  private remember(nonce: string, t: number): void {
    for (const [n, until] of this.nonces) if (until < t) this.nonces.delete(n);
    this.nonces.set(nonce, t + TUNNEL_NONCE_MS);
    // Kept on disk, so a request replayed after a restart is still refused.
    writeAtomic(join(this.o.dir, "nonces.json"), JSON.stringify([...this.nonces]), 0o600);
  }

  private async onPublic(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const t = this.now();
    if (t - this.second.at >= 1000) this.second = { at: t, n: 0 };
    if (++this.second.n > MAX_PER_SECOND) return this.refuse(req, res);
    const path = (req.url ?? "").split("?")[0] ?? "";
    const op =
      path === `/${this.o.prefix}/enroll`
        ? "enroll"
        : path === `/${this.o.prefix}/exchange`
          ? "exchange"
          : "";
    const at = Number(req.headers["x-thermite-at"]);
    const nonce = String(req.headers["x-thermite-nonce"] ?? "");
    const signature = String(req.headers["x-thermite-signature"] ?? "");
    const length = Number(req.headers["content-length"] ?? "0");
    // A wrong path or method, a missing signature or too long a body: refused before the body is
    // read.
    if (
      !op ||
      req.method !== "POST" ||
      !Number.isFinite(at) ||
      !/^[0-9a-f]{64}$/.test(nonce) ||
      !signature ||
      length > TUNNEL_MAX_REQUEST
    )
      return this.refuse(req, res);
    const body = await readBody(req, TUNNEL_MAX_REQUEST);
    if (!body) return this.nothing(res);
    const head: RequestHead = { method: "POST", path, rig: this.o.rig, pod: this.o.pod, at, nonce };
    if (Math.abs(t - at) > TUNNEL_SKEW_MS || this.nonces.has(nonce)) return this.nothing(res);
    try {
      const out =
        op === "enroll"
          ? this.enroll(head, body, signature, t)
          : await this.exchange(head, body, signature, t);
      if (!out) return this.nothing(res);
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(out.length),
        "x-thermite-signature": signAnswer(nonce, 200, out, this.keys.signPrivatePem),
      });
      res.end(out);
    } catch (err) {
      log(
        "supervisor",
        "pull mode: a request from control failed",
        {
          error: errorText(err),
        },
        "error",
      );
      this.nothing(res);
    }
  }

  /**
   * Control's first request: its key (the one the launch named), a proof that it holds the code,
   * and the rig's settings. The answer is this rig's public keys, bound to the code. Refused once
   * the code is spent, and after its expiry when the launch set one.
   */
  private enroll(head: RequestHead, body: Buffer, signature: string, t: number) {
    if (this.enrollment?.done_at) return undefined;
    if (this.o.enrollUntil !== undefined && t > this.o.enrollUntil) return undefined;
    let req: EnrollRequest;
    try {
      req = EnrollRequest.parse(JSON.parse(body.toString("utf8")));
      if (!sameHex(keySha256(req.control_key), this.o.controlKeySha256)) return undefined;
    } catch {
      return undefined;
    }
    if (!verifyRequest(head, body, signature, req.control_key)) return undefined;
    const proof = controlCodeProof(this.o.enrollCode, this.o.rig, this.o.pod, head.nonce);
    if (!sameHex(req.code_proof, proof)) return undefined;
    this.remember(head.nonce, t);
    this.enrollment = {
      control_key: req.control_key,
      config: req.config,
      answered_at: new Date(t).toISOString(),
    };
    writeAtomic(join(this.o.dir, "enrollment.json"), JSON.stringify(this.enrollment), 0o600);
    return Buffer.from(
      JSON.stringify({
        sign: this.keys.signPublicPem,
        box: this.keys.boxPublicPem,
        proof: enrollmentProof(this.o.enrollCode, this.keys.signPublicPem, this.keys.boxPublicPem),
      }),
    );
  }

  /** Control's key and the rig's settings, for the harness; control's key last. */
  private writeEnrolled(e: Enrollment): void {
    const dir = this.o.enrolledDir;
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const env = Object.entries(e.config.env).map(([k, v]) => `${k}=${v}\n`);
    writeAtomic(
      join(dir, ENROLLED_FILES.rig),
      `${JSON.stringify(
        {
          rig: this.o.rig,
          pod: this.o.pod,
          control_key_sha256: keySha256(e.control_key),
          enrolled_at: e.done_at,
          config: e.config,
        },
        null,
        2,
      )}\n`,
      0o644,
    );
    writeAtomic(
      join(dir, ENROLLED_FILES.env),
      `THERMITE_RIG_ID=${this.o.rig}\n${env.join("")}`,
      0o644,
    );
    writeAtomic(join(dir, ENROLLED_FILES.controlKey), e.control_key, 0o644);
  }

  /**
   * Control's answers to earlier calls in, the calls waiting now out. With nothing to hand over,
   * it waits for a call (long poll), up to the time control asked for. Control's first exchange
   * completes the enrollment: it was sealed to this rig's key, so control has pinned it.
   */
  private async exchange(
    head: RequestHead,
    sealed: Buffer,
    signature: string,
    t: number,
  ): Promise<Buffer | undefined> {
    const e = this.enrollment;
    if (!e || !verifyRequest(head, sealed, signature, e.control_key)) return undefined;
    let msg: ExchangeIn;
    try {
      msg = ExchangeIn.parse(JSON.parse(open(sealed, this.keys.boxPrivatePem).toString("utf8")));
    } catch {
      return undefined;
    }
    this.remember(head.nonce, t);
    if (!e.done_at) {
      const done = { ...e, done_at: new Date(t).toISOString() };
      this.writeEnrolled(done);
      writeAtomic(join(this.o.dir, "enrollment.json"), JSON.stringify(done), 0o600);
      this.enrollment = done;
      log("supervisor", "pull mode: enrolled with control", { rig: this.o.rig });
    }
    for (const a of msg.answers) {
      const w = this.waiting.get(a.id);
      if (!w) continue;
      const parts = a.parts ?? 1;
      const body = Buffer.from(a.body, "base64");
      if (parts > 1) {
        w.parts ??= [];
        if ((a.part ?? 0) < parts) w.parts[a.part ?? 0] = body;
        if (w.parts.filter(Boolean).length < parts) continue;
      }
      this.waiting.delete(a.id);
      w.respond(a.status, a.headers ?? {}, parts > 1 ? Buffer.concat(w.parts ?? []) : body);
    }
    // A call goes to control once, and again if no answer came for a while (an answer the proxy
    // changed is dropped by control, and that exchange's calls with it). One with parts of its
    // answer here is being answered.
    const fresh = () =>
      [...this.waiting.values()].filter(
        (w) => !w.parts && (!w.offeredAt || this.now() - w.offeredAt > REOFFER_MS),
      );
    const wait = Math.min(msg.wait_ms ?? 0, MAX_HOLD_MS);
    if (!fresh().length && wait > 0)
      await new Promise<void>((r) => {
        const timer = setTimeout(r, wait);
        this.holders.push(() => {
          clearTimeout(timer);
          r();
        });
      });
    const calls: Waiting[] = [];
    let size = 0;
    for (const w of fresh()) {
      if (calls.length && size + w.body.length > MAX_CALLS_PER_EXCHANGE) break;
      calls.push(w);
      size += w.body.length;
    }
    for (const w of calls) w.offeredAt = this.now();
    const refused = this.refused;
    this.refused = 0;
    return seal(
      Buffer.from(
        JSON.stringify({
          requests: calls.map((w) => ({
            id: w.id,
            method: w.method,
            path: w.path,
            headers: w.headers,
            body: w.body.toString("base64"),
          })),
          refused,
        }),
      ),
      this.o.controlBoxPublicPem,
    );
  }

  /** The supervisor's call to control: kept until control's answer comes back. */
  private async onLocal(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = String(req.headers.authorization ?? "");
    const path = req.url ?? "";
    // Anyone but the supervisor (a lane in the same pod, say) gets the public port's 404.
    if (
      !sameSecret(auth, `Bearer ${this.o.localToken}`) ||
      !path.startsWith(`/v1/rigs/${encodeURIComponent(this.o.rig)}/`)
    )
      return this.refuse(req, res);
    if (this.waiting.size >= MAX_WAITING) {
      req.resume();
      res.writeHead(503, { "content-length": "0" });
      res.end();
      return;
    }
    const body = await readBody(req, MAX_LOCAL_CALL);
    if (!body) {
      res.writeHead(413, { "content-length": "0" });
      res.end();
      return;
    }
    const headers: Record<string, string> = {};
    for (const h of CARRIED) {
      const v = req.headers[h];
      if (typeof v === "string") headers[h] = v;
    }
    const id = randomBytes(12).toString("hex");
    let done = false;
    const timer = setTimeout(() => {
      this.waiting.delete(id);
      if (!done) {
        done = true;
        res.writeHead(504, { "content-length": "0" });
        res.end();
      }
    }, this.o.callTimeoutMs ?? 120_000);
    this.waiting.set(id, {
      id,
      method: req.method ?? "GET",
      path,
      headers,
      body,
      offeredAt: 0,
      respond: (status, h, b) => {
        clearTimeout(timer);
        if (done) return;
        done = true;
        const out: Record<string, string> = { "content-length": String(b.length) };
        if (h["content-type"]) out["content-type"] = h["content-type"];
        res.writeHead(status, out);
        res.end(b);
      },
    });
    // An exchange waiting for work goes now.
    const holders = this.holders;
    this.holders = [];
    for (const wake of holders) wake();
  }
}

/** Settings of pull mode the supervisor reads, set by control at launch and by the image. */
export interface PullMode {
  tunnel: PodTunnel;
  /** Where the supervisor's own calls to control go, and the token they carry. */
  controlUrl: string;
  controlToken: string;
  /** The tunnel's private directory and the enrolled one: a full reset keeps both. */
  dirs: string[];
}

/**
 * The tunnel's options from the launch's values, when THERMITE_TUNNEL_PORT is set (pull mode).
 * Throws, in words, on a missing or bad value.
 */
export function pullModeOptions(
  env: NodeJS.ProcessEnv,
  rig: string,
  home: string,
): PodTunnelOptions | undefined {
  if (!env.THERMITE_TUNNEL_PORT) return undefined;
  const need = (name: string) => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`pull mode needs ${name}`);
    return v;
  };
  const port = readNumber(env, SUPERVISOR_NUMBERS.tunnelPort) ?? 0;
  const until = env.THERMITE_TUNNEL_ENROLL_UNTIL
    ? Date.parse(env.THERMITE_TUNNEL_ENROLL_UNTIL)
    : Number.NaN;
  if (env.THERMITE_TUNNEL_ENROLL_UNTIL && !Number.isFinite(until))
    throw new Error("THERMITE_TUNNEL_ENROLL_UNTIL must be an ISO time");
  let controlBoxPublicPem: string;
  try {
    controlBoxPublicPem = publicKeyFromLine(need("THERMITE_TUNNEL_CONTROL_BOX"));
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("pull mode needs")) throw err;
    throw new Error("THERMITE_TUNNEL_CONTROL_BOX is not a public key");
  }
  const controlKeySha256 = need("THERMITE_TUNNEL_CONTROL_KEY_SHA256");
  if (!/^[0-9a-f]{64}$/.test(controlKeySha256))
    throw new Error("THERMITE_TUNNEL_CONTROL_KEY_SHA256 must be 64 hexadecimal characters");
  return {
    rig,
    pod: env.THERMITE_TUNNEL_POD?.trim() || need("RUNPOD_POD_ID"),
    prefix: need("THERMITE_TUNNEL_PREFIX"),
    controlKeySha256,
    controlBoxPublicPem,
    enrollCode: need("THERMITE_TUNNEL_ENROLL_CODE"),
    enrollUntil: Number.isFinite(until) ? until : undefined,
    ...podTunnelDirs(env, home),
    publicPort: port,
    localPort: 0,
    localToken: randomBytes(32).toString("base64url"),
  };
}

/**
 * Pull mode, when THERMITE_TUNNEL_PORT is set: the tunnel started from the launch's values. The
 * code and RunPod's own key are taken out of this process's environment, so nothing it starts
 * (git, an advisor's model tool) inherits them; RunPod's key is never used on the pod.
 */
export async function startPullMode(
  env: NodeJS.ProcessEnv,
  rig: string,
  home: string,
): Promise<PullMode | undefined> {
  const o = pullModeOptions(env, rig, home);
  if (!o) return undefined;
  delete env.THERMITE_TUNNEL_ENROLL_CODE;
  delete env.RUNPOD_API_KEY;
  const tunnel = new PodTunnel(o);
  await tunnel.start();
  return {
    tunnel,
    controlUrl: `http://127.0.0.1:${tunnel.ports().local_port}`,
    controlToken: o.localToken,
    dirs: [o.dir, o.enrolledDir],
  };
}
