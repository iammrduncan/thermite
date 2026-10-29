import { createPublicKey, randomBytes } from "node:crypto";
import { log, redact } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import { RIG_ID_WORDS } from "../../core/ids.ts";
import {
  controlCodeProof,
  EnrollAnswer,
  ExchangeOut,
  enrollmentProof,
  generateBoxKeys,
  keySha256,
  newNonce,
  open,
  type PodConfig,
  type PodLaunchEnv,
  publicKeyLine,
  type RequestHead,
  sameHex,
  seal,
  signRequest,
  TUNNEL_MAX_REQUEST,
  TUNNEL_PORT,
  TUNNEL_SKEW_MS,
  verifyAnswer,
} from "../../core/tunnel.ts";
import type { SecretBox } from "../secrets.ts";
import { type ControlStore, RIG_ID } from "../store/index.ts";
import { podPortUrl } from "./cloud.ts";

/**
 * Control's end of the tunnel to a rig in pull mode: one control connects to through a public
 * proxy (a RunPod pod: docs/plan/goals/_completed/019-rig-only-entry.goal and 021-enrollment-codes.goal,
 * and src/supervisor/tunnel-pod.ts for the rig's end).
 *
 * A launch mints the rig and its one-time code (mint), and names the pod once RunPod made it
 * (attach). Control then enrolls the pod once (it pins the keys the pod made, bound to the code),
 * and exchanges with it: each exchange returns the answers to the rig's earlier calls and collects
 * the calls waiting now. Control answers each call itself, as that rig, and only on the routes a
 * rig may use. Every request is signed with control's command-signing key; every answer must
 * verify against the pinned key and is sealed to this rig's key at control.
 */

/** A call the rig made to control, carried through the tunnel. */
export interface TunnelCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
}

/** Answers a rig's call in-process, as that rig (createControlApi gives it). */
export type TunnelDispatch = (rig: string, call: TunnelCall) => Promise<Response>;

/** The routes a rig may use, and only for itself. Anything else is not found. */
export function tunnelRouteAllowed(rig: string, method: string, path: string): boolean {
  const base = `/v1/rigs/${encodeURIComponent(rig)}/`;
  if (!path.startsWith(base)) return false;
  const rest = (path.slice(base.length).split("?")[0] ?? "").replace(/\/+$/, "");
  if (rest.includes("..") || rest.includes("//")) return false;
  const get = method === "GET";
  const post = method === "POST";
  return (
    (post && ["ingest", "supervisor", "live", "screens", "reports"].includes(rest)) ||
    // The agents' searches and reads of the knowledge base, for a rig off the bus (goal 175).
    (post && ["kb/search", "kb/read"].includes(rest)) ||
    // mcp-servers: the MCP servers its runs' kits name, with their sign-in (goal 068).
    (get &&
      ["commands/pending", "model-route", "advisor-routes", "kb", "mcp-servers"].includes(rest)) ||
    (post && /^commands\/[A-Za-z0-9._-]+\/ack$/.test(rest)) ||
    // Results out (goal 024): champion patches and exports, for a rig with no results repository.
    (post && /^champions\/[A-Za-z0-9._-]+\/[0-9]+\/patch$/.test(rest)) ||
    (post && /^exports\/[0-9TZ]{8,20}-[0-9a-f]{8}(\/file)?$/.test(rest)) ||
    (get && /^git-access\/[A-Za-z0-9._-]+$/.test(rest)) ||
    (get && /^git\/kits\/[A-Za-z0-9._-]+\.git\/[A-Za-z0-9._/-]+$/.test(rest))
  );
}

/** One piece of an answer to a rig's call; a large answer crosses in several. */
interface Piece {
  id: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  part?: number;
  parts?: number;
}

/** A piece's raw bytes at most: in base64 it leaves room in a request of TUNNEL_MAX_REQUEST. */
const PIECE_BYTES = 512 * 1024;
/** What one exchange's answers may take, as JSON, before sealing. */
const EXCHANGE_BUDGET = TUNNEL_MAX_REQUEST - 64 * 1024;
/** The most control reads of an answer from a pod: the calls one exchange carries, in base64. */
const MAX_ANSWER = 96 * 1024 * 1024;
/** After a failed step, the next waits this long, doubling up to a minute. */
const RETRY_MS = 2_000;
const RETRY_MAX_MS = 60_000;

/** What a launch gets: the rig's ID, and what the pod must start with. */
export interface MintedRig {
  rig: string;
  /** The pod's environment: public material, the one-time code and the snapshot key, nothing else. */
  env: PodLaunchEnv;
  /** The port the pod serves for control: the launch exposes it as HTTP. */
  port: number;
}

/** Reads a response's body, refusing one longer than `limit`. */
async function readCapped(res: Response, limit: number): Promise<Buffer> {
  if (Number(res.headers.get("content-length") ?? "0") > limit)
    throw new Error("the pod's answer is too large");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error("the pod's answer is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** An answer in pieces small enough for one request each. */
function piecesOf(id: string, status: number, headers: Record<string, string>, body: Buffer) {
  if (body.length <= PIECE_BYTES)
    return [{ id, status, headers, body: body.toString("base64") }] as Piece[];
  const parts = Math.ceil(body.length / PIECE_BYTES);
  return Array.from({ length: parts }, (_, part) => ({
    id,
    status,
    headers,
    body: body.subarray(part * PIECE_BYTES, (part + 1) * PIECE_BYTES).toString("base64"),
    part,
    parts,
  }));
}

export class ControlTunnels {
  private readonly store: ControlStore;
  private readonly secrets: SecretBox;
  private readonly signPrivatePem: string;
  private readonly controlPublicPem: string;
  private dispatch: TunnelDispatch | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** Answers waiting to go back to each rig in its next exchanges, in pieces. */
  private readonly pending = new Map<string, Piece[]>();
  private readonly running = new Set<string>();
  /** Calls each rig has offered that control has taken: one offered again is not run twice. */
  private readonly taken = new Map<string, Set<string>>();
  /** After failures: when each rig's next step may go, and how many failed in a row. */
  private readonly retry = new Map<string, { at: number; failures: number }>();

  /**
   * `signPrivatePem` is control's command-signing key: the pod checks control's requests with
   * its public half, which arrives at enrollment and must match the SHA-256 the launch named.
   */
  constructor(
    store: ControlStore,
    secrets: SecretBox,
    signPrivatePem: string,
    opts: { fetch?: typeof fetch | undefined; now?: (() => number) | undefined } = {},
  ) {
    this.store = store;
    this.secrets = secrets;
    this.signPrivatePem = signPrivatePem;
    this.controlPublicPem = createPublicKey(signPrivatePem)
      .export({ type: "spki", format: "pem" })
      .toString();
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** How the rigs' calls are answered: control's own API, in-process (createControlApi). */
  serveWith(dispatch: TunnelDispatch): void {
    this.dispatch = dispatch;
  }

  /**
   * Mints a rig in pull mode for a pod about to be launched: its ID (made here when none is
   * given), its one-time enrollment code and the pod's environment, with a new key for its state
   * snapshot that control does not keep. The code expires only when `codeTtlMs` is given.
   * `config` is the rig's settings, given to the pod at enrollment.
   */
  mint(o: {
    by: string;
    rig?: string | undefined;
    port?: number | undefined;
    codeTtlMs?: number | undefined;
    config?: PodConfig["env"] | undefined;
  }): MintedRig {
    const taken = (r: string) =>
      Boolean(this.store.tunnels.get(r)) ||
      this.store.enrollments.knownRig(r) ||
      this.store.reportedRigs.list({ withRetired: true }).some((u) => u.id === r);
    let rig = o.rig;
    if (rig !== undefined) {
      if (!RIG_ID.test(rig)) throw new Error(RIG_ID_WORDS);
      if (taken(rig)) throw new Error(`rig ${rig} exists already`);
    } else {
      do rig = `rp-${randomBytes(4).toString("hex")}`;
      while (taken(rig));
    }
    const port = o.port ?? TUNNEL_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(`the pod's port must be a port number, not ${port}`);
    if (o.codeTtlMs !== undefined && !(o.codeTtlMs > 0))
      throw new Error("an enrollment code's expiry must be a positive time");
    const box = generateBoxKeys();
    const prefix = randomBytes(32).toString("hex");
    const code = randomBytes(32).toString("hex");
    const until =
      o.codeTtlMs !== undefined ? new Date(this.now() + o.codeTtlMs).toISOString() : null;
    this.store.tunnels.add({
      rig,
      port,
      prefix_sealed: this.secrets.seal(prefix),
      box_private_sealed: this.secrets.seal(box.boxPrivatePem),
      box_public: box.boxPublicPem,
      code_sealed: this.secrets.seal(code),
      code_expires_at: until,
      config: { env: o.config ?? {} },
      created_by: o.by,
    });
    return {
      rig,
      port,
      env: {
        THERMITE_RIG_ID: rig,
        THERMITE_TUNNEL_PORT: String(port),
        THERMITE_TUNNEL_PREFIX: prefix,
        THERMITE_TUNNEL_CONTROL_KEY_SHA256: keySha256(this.controlPublicPem),
        THERMITE_TUNNEL_CONTROL_BOX: publicKeyLine(box.boxPublicPem),
        THERMITE_TUNNEL_ENROLL_CODE: code,
        ...(until ? { THERMITE_TUNNEL_ENROLL_UNTIL: until } : {}),
        // New for each launch, and never kept here: only the pod's settings at RunPod hold it.
        THERMITE_STATE_SNAPSHOT_KEY: randomBytes(32).toString("base64url"),
      },
    };
  }

  /**
   * Names the pod a minted rig runs in, once RunPod made it: control connects to it at `url`
   * (RunPod's proxy address for the pod's port, when none is given). Refused once enrolled.
   */
  attach(rig: string, pod: string, url?: string): void {
    const t = this.store.tunnels.get(rig);
    if (!t) throw new Error(`no rig ${rig} in pull mode`);
    if (!/^[A-Za-z0-9-]{1,64}$/.test(pod)) throw new Error(`${pod} is not a pod's ID`);
    const at = (url ?? podPortUrl(pod, t.port)).replace(/\/$/, "");
    if (!/^https?:\/\/[^\s/]+$/.test(at)) throw new Error(`${at} is not a pod's address`);
    if (!this.store.tunnels.attachPod(rig, pod, at))
      throw new Error(`rig ${rig} is enrolled already: its pod can't change`);
    this.retry.delete(rig);
  }

  private async post(
    t: { rig: string; pod: string; url: string },
    path: string,
    body: Buffer,
    nonce = newNonce(),
  ): Promise<{ nonce: string; status: number; body: Buffer; signature: string }> {
    const head: RequestHead = {
      method: "POST",
      path,
      rig: t.rig,
      pod: t.pod,
      at: this.now(),
      nonce,
    };
    const res = await this.fetchImpl(`${t.url}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-thermite-at": String(head.at),
        "x-thermite-nonce": head.nonce,
        "x-thermite-signature": signRequest(head, body, this.signPrivatePem),
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(60_000),
    });
    return {
      nonce: head.nonce,
      status: res.status,
      body: await readCapped(res, MAX_ANSWER),
      signature: res.headers.get("x-thermite-signature") ?? "",
    };
  }

  /**
   * One step for a rig: enrollment until its keys are pinned, then one exchange. Returns what
   * happened, in words; errors are kept on the rig's record and in control's log.
   */
  async step(rig: string, waitMs = 0): Promise<string> {
    const t = this.store.tunnels.get(rig);
    if (!t) return `no rig ${rig} in pull mode`;
    if (!t.pod || !t.url) return "its pod is not launched yet";
    const at = { rig, pod: t.pod, url: t.url };
    const prefix = this.secrets.open(t.prefix_sealed);
    const fail = (why: string) => {
      const error = redact(why);
      this.store.tunnels.exchanged(rig, { error });
      log("control", "pull mode", { rig, error });
      const failures = (this.retry.get(rig)?.failures ?? 0) + 1;
      this.retry.set(rig, {
        at: this.now() + Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (failures - 1)),
        failures,
      });
      return error;
    };
    try {
      if (!t.enrolled_at) {
        if (t.code_expires_at && Date.parse(t.code_expires_at) < this.now())
          return fail("its enrollment code expired before the pod enrolled. Launch it again.");
        const code = this.secrets.open(t.code_sealed);
        const nonce = newNonce();
        const r = await this.post(
          at,
          `/${prefix}/enroll`,
          Buffer.from(
            JSON.stringify({
              control_key: this.controlPublicPem,
              code_proof: controlCodeProof(code, rig, t.pod, nonce),
              config: t.config,
            }),
          ),
          nonce,
        );
        if (r.status !== 200)
          return fail(
            // RunPod's proxy answers an empty 404 when nothing listens on the pod's port, the same
            // answer a pod gives a request it refuses: the first is the likelier one, so it comes first.
            r.status === 404 && r.body.length === 0
              ? `the pod did not enroll (an empty 404). Most often nothing listens on the pod's port yet: the pod may still be pulling its image, its container may have stopped, or its service did not start. Its Pod log says which. A pod that does listen refuses a wrong or expired code, a second enrollment, and a clock more than ${TUNNEL_SKEW_MS / 1000} s from control's.`
              : `the pod did not enroll (answer ${r.status}). A pod refuses a wrong or expired code, a second enrollment, and a clock more than ${TUNNEL_SKEW_MS / 1000} s from control's.`,
          );
        const keys = EnrollAnswer.safeParse(JSON.parse(r.body.toString("utf8")));
        if (!keys.success) return fail("the pod's enrollment answer is not valid: not enrolled");
        const { sign, box, proof } = keys.data;
        if (!sameHex(proof, enrollmentProof(code, sign, box)))
          return fail("the pod's keys are not bound to its launch code: not enrolled");
        if (!verifyAnswer(r.nonce, 200, r.body, r.signature, sign))
          return fail("the pod's enrollment answer is not signed by its key: not enrolled");
        if (createPublicKey(box).asymmetricKeyType !== "x25519")
          return fail("the pod's sealing key is not an X25519 key: not enrolled");
        if (!this.store.tunnels.pin(rig, sign, box))
          return fail("it was enrolled already: a second enrollment is refused");
        this.retry.delete(rig);
        return "enrolled";
      }
      // The answers that fit one request; the rest go in the next exchanges.
      const queue = this.pending.get(rig) ?? [];
      const answers: Piece[] = [];
      let size = 0;
      while (queue.length) {
        const p = queue[0] as Piece;
        const add = p.body.length + 512;
        if (answers.length && size + add > EXCHANGE_BUDGET) break;
        answers.push(p);
        queue.shift();
        size += add;
      }
      this.pending.set(rig, queue);
      const back = () => this.pending.set(rig, [...answers, ...(this.pending.get(rig) ?? [])]);
      let r: Awaited<ReturnType<ControlTunnels["post"]>>;
      try {
        const out = seal(
          Buffer.from(JSON.stringify({ answers, wait_ms: queue.length ? 0 : waitMs })),
          t.pod_box_public as string,
        );
        r = await this.post(at, `/${prefix}/exchange`, out);
      } catch (err) {
        // Not delivered: the answers go again next time.
        back();
        throw err;
      }
      if (
        r.status !== 200 ||
        !verifyAnswer(r.nonce, 200, r.body, r.signature, t.pod_sign_public as string)
      ) {
        back();
        return fail(`the pod's answer did not verify (status ${r.status}): dropped`);
      }
      let msg: ExchangeOut;
      try {
        msg = ExchangeOut.parse(
          JSON.parse(open(r.body, this.secrets.open(t.box_private_sealed)).toString("utf8")),
        );
      } catch {
        back();
        return fail("the pod's answer could not be opened or read: dropped");
      }
      // Delivered: those calls are answered at the pod and won't come again.
      const taken = this.taken.get(rig) ?? new Set<string>();
      this.taken.set(rig, taken);
      for (const a of answers)
        if (a.parts === undefined || a.part === a.parts - 1) taken.delete(a.id);
      const calls = msg.requests.filter((c) => !taken.has(c.id));
      for (const c of calls) taken.add(c.id);
      const dispatch = this.dispatch;
      const done = await Promise.all(
        calls.map(async (c): Promise<Piece[]> => {
          if (!dispatch || !tunnelRouteAllowed(rig, c.method, c.path))
            return [{ id: c.id, status: 404, headers: {}, body: "" }];
          try {
            const res = await dispatch(rig, {
              method: c.method,
              path: c.path,
              headers: c.headers ?? {},
              body: Buffer.from(c.body, "base64"),
            });
            const ct = res.headers.get("content-type");
            return piecesOf(
              c.id,
              res.status,
              ct ? { "content-type": ct } : {},
              Buffer.from(await res.arrayBuffer()),
            );
          } catch (err) {
            // The call is answered all the same: the supervisor sees control's error, in words.
            const error = redact(errorText(err));
            log("control", "pull mode: a rig's call failed", { rig, path: c.path, error }, "error");
            return piecesOf(
              c.id,
              500,
              { "content-type": "application/json" },
              Buffer.from(JSON.stringify({ error })),
            );
          }
        }),
      );
      this.pending.set(rig, [...(this.pending.get(rig) ?? []), ...done.flat()]);
      this.store.tunnels.exchanged(rig, { refused: msg.refused, error: null });
      this.retry.delete(rig);
      return `exchanged: ${answers.length} answer(s) delivered, ${calls.length} call(s) collected`;
    } catch (err) {
      return fail(errorText(err));
    }
  }

  /**
   * Keeps every rig in pull mode going: control's loop calls this often. One step per rig at a
   * time; a rig whose pod isn't launched, a retired one, or one failing until its retry time
   * waits.
   */
  async advance(waitMs = 20_000): Promise<void> {
    await Promise.all(
      this.store.tunnels.list().map(async (t) => {
        if (!t.pod || this.running.has(t.rig) || this.store.retired.get(t.rig)) return;
        if ((this.retry.get(t.rig)?.at ?? 0) > this.now()) return;
        this.running.add(t.rig);
        try {
          // Answers waiting go at once; otherwise the pod holds the exchange until a call comes.
          const has = (this.pending.get(t.rig) ?? []).length > 0;
          await this.step(t.rig, has || !t.enrolled_at ? 0 : waitMs);
        } finally {
          this.running.delete(t.rig);
        }
      }),
    );
  }
}
