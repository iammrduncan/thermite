/**
 * RunPod as a place for rigs (Settings › Providers): control seals the owner's API key and reads,
 * with RunPod's REST API v2, the GPU types with their prices and stock, the data centers, the
 * network volumes, the account's pods and, when asked, a pod's log (podLogs: what a pod that
 * never enrolls printed). Reading spends nothing. Control starts pods only when
 * asked: a test pod, by the owner or an operator (runpod/tests.ts), and a rig, by the owner alone
 * (runpod/rigs.ts).
 */

import { redact } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import type { SecretBox } from "../secrets.ts";
import type { ControlStore } from "../store/index.ts";

export const RUNPOD_API = "https://api.runpod.io";

export interface RunpodGpu {
  id: string;
  name: string;
  memory_gb: number;
  secure: boolean;
  community: boolean;
  /** USD per GPU per hour, list price. */
  price_secure: number | null;
  price_community: number | null;
  /** Stock for pods on Secure cloud: NONE, LOW, MEDIUM, HIGH. */
  availability?: string | undefined;
}

export interface RunpodFacts {
  gpus: RunpodGpu[];
  datacenters: { id: string; name: string; region: string }[];
  volumes: { id: string; name: string; size_gb: number; datacenter: string }[];
  pods: { id: string; name: string; status: string; cost_per_hr: number; gpus: number }[];
  /** What the account spent, from RunPod's billing (USD); or why it could not be read. */
  spend?: RunpodSpend | undefined;
}

export interface RunpodSpend {
  /** Today so far, this month so far, and the last 30 days (today included), in USD. */
  today: number | null;
  month: number | null;
  last30: number | null;
  /** The last 7 days, oldest first: the day (YYYY-MM-DD, UTC) and what it cost. */
  days: { day: string; usd: number }[];
  /** Set when billing could not be read (a key without billing access, say). */
  error?: string | undefined;
}

type Json = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** RunPod refused a call with this status (400: no capacity or a broken rule; 409: wrong state). */
export class RunpodRefused extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** One call to RunPod's REST API v2; null for a 204 or a 404. Throws, in words, otherwise. */
async function runpodCall(
  key: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<Json | null> {
  let r: Response;
  try {
    r = await fetchImpl(`${RUNPOD_API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(`control could not reach RunPod: ${errorText(err)}`);
  }
  if (r.status === 401 || r.status === 403)
    throw new Error(
      method === "GET"
        ? "RunPod refused the key"
        : "RunPod refused the key for this: a read-only key can't start or stop pods",
    );
  if (r.status === 204 || (r.status === 404 && method !== "POST")) return null;
  if (!r.ok) {
    // RunPod's errors are problem+json: a title and a detail, in words.
    let why = "";
    try {
      const p = (await r.json()) as Json;
      // A refused request names the fields at fault in `errors`: kept, so the words say which.
      const fields = p.errors === undefined ? "" : JSON.stringify(p.errors);
      // Before it is cut short: a value it echoes is taken out whole (a launch value, say).
      why = redact([str(p.title), str(p.detail), fields].filter(Boolean).join(": "));
    } catch {}
    throw new RunpodRefused(
      r.status,
      `RunPod answered ${r.status} for ${method} ${path.split("?")[0]}${why ? ` (${why.slice(0, 300)})` : ""}`,
    );
  }
  return (await r.json()) as Json;
}

/** A pod as control follows it. */
export interface RunpodPod {
  id: string;
  status: string;
  /** USD per hour while it runs; 0 when stopped or gone. */
  cost_per_hr: number;
  gpu: string;
  gpus: number;
  datacenter: string;
  /**
   * Its TCP ports with a public address now, as `address:port` by the pod's own port. RunPod's
   * pod record (GET /v2/pods/{id}) has them in `runtime.ports` while the pod runs, each with its
   * `private` port, its `public` one, its `type` and its `ip`; the list of pods has no runtime.
   */
  tcp: Record<number, string>;
}

/** A pod's TCP ports that have a public address and port, from its record's `runtime.ports`. */
function tcpOf(p: Json): Record<number, string> {
  const ports = ((p.runtime as Json | null | undefined)?.ports ?? []) as Json[];
  const out: Record<number, string> = {};
  for (const x of Array.isArray(ports) ? ports : []) {
    const inside = num(x.private);
    const outside = num(x.public);
    const ip = str(x.ip);
    if (str(x.type) === "tcp" && inside !== null && outside !== null && ip)
      out[inside] = `${ip}:${outside}`;
  }
  return out;
}

const podOf = (p: Json): RunpodPod => ({
  id: str(p.id),
  status: str(p.status),
  cost_per_hr: num(p.cost) ?? 0,
  gpu: str((p.gpu as Json | undefined)?.id),
  gpus: num((p.gpu as Json | undefined)?.count) ?? 0,
  datacenter: str(p.dataCenterId),
  tcp: tcpOf(p),
});

/** What a pod is started with (RunPod's create-a-pod body, v2). */
export interface RunpodPodSpec {
  name: string;
  image: string;
  gpu: string;
  gpuCount: number;
  cloud: "SECURE" | "COMMUNITY";
  /** The container's own disk, gone when the pod stops. */
  diskGb: number;
  minCudaVersion?: string | undefined;
  /** A data center's id; not given: RunPod chooses. */
  datacenter?: string | undefined;
  /** The pod's volume, kept when it stops, mounted at volumeMountPath (`/workspace` if not given); not given: none. */
  volumeGb?: number | undefined;
  volumeMountPath?: string | undefined;
  ports: string[];
  env: Record<string, string>;
  /** Not given: the image's own entry point and command. */
  cmd?: string[] | undefined;
}

/**
 * Starts a pod (it is billed from now). RunPod's v2 create-a-pod body takes the data center as a
 * list (`dataCenterIds`; a pod's own record says `dataCenterId`) and the pod's volume as
 * `mounts.persistent` (`size` in GB, at least 10, and `path`). The first launch of a rig on
 * RunPod was refused with other names (goal 022).
 */
export async function createPod(
  key: string,
  spec: RunpodPodSpec,
  fetchImpl: typeof fetch = fetch,
): Promise<RunpodPod> {
  const body = {
    name: spec.name,
    image: spec.image,
    gpu: {
      id: spec.gpu,
      count: spec.gpuCount,
      ...(spec.minCudaVersion ? { minCudaVersion: spec.minCudaVersion } : {}),
    },
    cloud: spec.cloud,
    disk: spec.diskGb,
    ...(spec.datacenter ? { dataCenterIds: [spec.datacenter] } : {}),
    ...(spec.volumeGb
      ? {
          mounts: {
            persistent: { size: spec.volumeGb, path: spec.volumeMountPath ?? "/workspace" },
          },
        }
      : {}),
    ports: spec.ports,
    env: spec.env,
    ...(spec.cmd ? { cmd: spec.cmd } : {}),
  };
  const r = await runpodCall(key, "POST", "/v2/pods", body, fetchImpl);
  if (!r) throw new Error("RunPod answered without the new pod");
  return podOf(r);
}

/** A pod now, or null when RunPod no longer has it. */
export async function getPod(
  key: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RunpodPod | null> {
  const r = await runpodCall(
    key,
    "GET",
    `/v2/pods/${encodeURIComponent(id)}`,
    undefined,
    fetchImpl,
  );
  return r ? podOf(r) : null;
}

/** Stops a running pod (its disk stays) or starts a stopped one. */
export async function podAction(
  key: string,
  id: string,
  action: "stop" | "start",
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await runpodCall(key, "POST", `/v2/pods/${encodeURIComponent(id)}/action`, { action }, fetchImpl);
}

/** Removes a pod for good; nothing more is billed. A pod already gone is fine. */
export async function terminatePod(
  key: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await runpodCall(key, "DELETE", `/v2/pods/${encodeURIComponent(id)}`, undefined, fetchImpl);
}

/** One line of a pod's log as RunPod streams it: from the pod's container or from RunPod's host. */
export interface PodLogLine {
  /** `container` (what the image printed) or `system` (RunPod's own steps: the pull, the start). */
  source: string;
  /** When RunPod logged it (RFC 3339). */
  ts: string;
  line: string;
}

/** The lines a log read asks RunPod for by default, and at most. */
export const POD_LOG_TAIL = 200;
export const POD_LOG_MAX_TAIL = 2000;
/** A read stops once no line came for this long: RunPod has sent what it had, and waits for more. */
const POD_LOG_IDLE_MS = 2_000;
/** And after this long in all, however many lines still come. */
const POD_LOG_TOTAL_MS = 10_000;

export interface PodLogOptions {
  /** Lines of history to ask for: 200 when not given, 2000 at most. */
  tail?: number | undefined;
  /** One source only; not given: both. */
  source?: "container" | "system" | undefined;
  /** The idle and the total stop, in ms (tests make them short). */
  idleMs?: number | undefined;
  totalMs?: number | undefined;
}

/** One Server-Sent Event: its type (`message` when it names none) and its data. */
export interface SseEvent {
  event: string;
  data: string;
}

/**
 * A Server-Sent Events parser, as the HTML standard reads a stream: lines end with CRLF, LF or
 * CR; a line that starts with ":" is a comment; `data:` lines add to the event's data (joined
 * with LF); `event:` names its type; a blank line ends the event, and one with no data is
 * dropped. Other fields (id, retry, unknown ones) are ignored.
 */
export class SseParser {
  private buf = "";
  private data: string[] = [];
  private type = "";
  private first = true;

  /** Takes the next piece of the stream; returns the events it ended. */
  push(text: string): SseEvent[] {
    this.buf += text;
    if (this.first && this.buf.length) {
      if (this.buf.startsWith("﻿")) this.buf = this.buf.slice(1);
      this.first = false;
    }
    const out: SseEvent[] = [];
    let start = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const ch = this.buf[i];
      if (ch !== "\n" && ch !== "\r") continue;
      // A CR at the end of what came so far may be the first half of a CRLF: wait for more.
      if (ch === "\r" && i === this.buf.length - 1) break;
      this.line(this.buf.slice(start, i), out);
      if (ch === "\r" && this.buf[i + 1] === "\n") i++;
      start = i + 1;
    }
    this.buf = this.buf.slice(start);
    return out;
  }

  /** The stream ended: a lone CR left ends its line; an event without its blank line is dropped. */
  end(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.buf.endsWith("\r")) this.line(this.buf.slice(0, -1), out);
    this.buf = "";
    this.data = [];
    this.type = "";
    return out;
  }

  private line(l: string, out: SseEvent[]): void {
    if (l === "") {
      const data = this.data.join("\n");
      if (this.data.length && data !== "") out.push({ event: this.type || "message", data });
      this.data = [];
      this.type = "";
      return;
    }
    if (l.startsWith(":")) return;
    const c = l.indexOf(":");
    const field = c < 0 ? l : l.slice(0, c);
    let value = c < 0 ? "" : l.slice(c + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.type = value;
  }
}

/** Terminal colour and cursor codes, which mean nothing outside a terminal. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");

/** A log line from one event's data, with what could be a credential taken out; null if not one. */
function podLogLineOf(ev: SseEvent): PodLogLine | null {
  if (ev.event !== "message") return null;
  let d: unknown;
  try {
    d = JSON.parse(ev.data);
  } catch {
    return null;
  }
  if (!d || typeof d !== "object") return null;
  const o = d as Json;
  if (typeof o.line !== "string") return null;
  return {
    source: str(o.source),
    ts: str(o.ts),
    line: redact(o.line.replace(ANSI, "").replace(/\r?\n$/, "")),
  };
}

/** Why RunPod would not stream a pod's log, in words: never the key. */
async function podLogRefusal(r: Response, podId: string): Promise<RunpodRefused> {
  const status = r.status;
  if (status === 401)
    return new RunpodRefused(
      status,
      "RunPod refused the key: it is wrong or was revoked. Check it in Settings › Providers",
    );
  if (status === 403)
    return new RunpodRefused(
      status,
      `RunPod refused to show pod ${podId}'s log with this key: the key may not read pod logs. A key with read access to pods can`,
    );
  if (status === 404)
    return new RunpodRefused(
      status,
      `RunPod has no pod ${podId}: it was removed, or it is not this key's account's`,
    );
  if (status === 429) {
    const after = Number(r.headers.get("retry-after"));
    return new RunpodRefused(
      status,
      `RunPod is limiting calls to its API: try again${Number.isFinite(after) && after > 0 ? ` in ${Math.ceil(after)} s` : " in a minute"}`,
    );
  }
  let why = "";
  try {
    const p = (await r.json()) as Json;
    why = [str(p.title), str(p.detail)].filter(Boolean).join(": ");
  } catch {}
  return new RunpodRefused(
    status,
    redact(
      `RunPod answered ${status} for pod ${podId}'s log${why ? ` (${why.slice(0, 300)})` : ""}`,
    ),
  );
}

/**
 * Reads a pod's log from RunPod (GET /v2/pods/{id}/logs, Server-Sent Events): RunPod sends the
 * last `tail` lines first, then streams new ones live. Control reads the history and stops: once
 * `tail` lines came, once no line came for 2 seconds, or after 10 seconds in all. The lines come
 * oldest first, each through redact(). Throws, in words, when RunPod refuses or can't be reached.
 */
export async function podLogs(
  key: string,
  podId: string,
  o: PodLogOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<PodLogLine[]> {
  const tail = Math.min(
    POD_LOG_MAX_TAIL,
    Math.max(1, Math.floor(Number.isFinite(o.tail) ? (o.tail as number) : POD_LOG_TAIL)),
  );
  const idleMs = o.idleMs ?? POD_LOG_IDLE_MS;
  const totalMs = o.totalMs ?? POD_LOG_TOTAL_MS;
  const q = new URLSearchParams({ tail: String(tail) });
  if (o.source) q.set("source", o.source);
  const stop = new AbortController();
  let stopped = false;
  const end = () => {
    stopped = true;
    stop.abort();
  };
  const all = setTimeout(end, totalMs);
  let idle: ReturnType<typeof setTimeout> | undefined;
  const lines: PodLogLine[] = [];
  try {
    let r: Response;
    try {
      r = await fetchImpl(`${RUNPOD_API}/v2/pods/${encodeURIComponent(podId)}/logs?${q}`, {
        headers: { authorization: `Bearer ${key}`, accept: "text/event-stream" },
        signal: stop.signal,
      });
    } catch (err) {
      if (stopped)
        throw new Error(`RunPod did not answer for pod ${podId}'s log within ${totalMs / 1000} s`);
      throw new Error(redact(`control could not reach RunPod: ${errorText(err)}`));
    }
    if (!r.ok) throw await podLogRefusal(r, podId);
    if (!r.body) return lines;
    const reader = r.body.getReader();
    const parser = new SseParser();
    const text = new TextDecoder();
    // The idle stop counts from the answer, and again from each line (a comment is not a line).
    const wait = () => {
      clearTimeout(idle);
      idle = setTimeout(end, idleMs);
    };
    wait();
    const take = (events: SseEvent[]) => {
      for (const ev of events) {
        const l = podLogLineOf(ev);
        if (!l) continue;
        lines.push(l);
        wait();
        if (lines.length >= tail) {
          end();
          return;
        }
      }
    };
    while (!stopped) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (stopped || lines.length) break;
        throw new Error(
          redact(`control lost RunPod's stream of pod ${podId}'s log: ${errorText(err)}`),
        );
      }
      if (chunk.done) {
        take(parser.push(text.decode()));
        take(parser.end());
        break;
      }
      take(parser.push(text.decode(chunk.value, { stream: true })));
    }
    reader.cancel().catch(() => {});
  } finally {
    clearTimeout(all);
    clearTimeout(idle);
    stop.abort();
  }
  return lines;
}

/** Where RunPod's HTTP proxy serves a pod's port (public: what it serves must need a secret path). */
export const podPortUrl = (podId: string, port: number) =>
  `https://${podId}-${port}.proxy.runpod.net`;

/** Reads the account. Throws, in words, when RunPod refuses the key or can't be reached. */
export async function readRunpod(
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RunpodFacts> {
  const get = (path: string) => runpodCall(key, "GET", path, undefined, fetchImpl);
  // The pods first: it needs the key, so a wrong key fails here, in words.
  const pods = (await get("/v2/pods")) ?? {};
  const gpus = (await get("/v2/catalog/gpus?include=AVAILABILITY&product=POD&cloud=SECURE")) ?? {};
  const dcs = (await get("/v2/catalog/datacenters")) ?? {};
  const vols = (await get("/v2/network-volumes")) ?? {};
  return {
    spend: await readSpend(get),
    gpus: ((gpus.gpus as Json[]) ?? [])
      .map((g) => {
        const price = (g.price ?? {}) as Json;
        return {
          id: str(g.id),
          name: str(g.name) || str(g.id),
          memory_gb: num(g.memory) ?? 0,
          secure: g.secure === true,
          community: g.community === true,
          price_secure: num(price.secure),
          price_community: num(price.community),
          availability: str(g.availability) || undefined,
        };
      })
      .sort((a, b) => (a.price_secure ?? 1e9) - (b.price_secure ?? 1e9)),
    datacenters: ((dcs.dataCenters as Json[]) ?? []).map((d) => ({
      id: str(d.id),
      name: str(d.name),
      region: typeof d.region === "string" ? d.region : str((d.region as Json | undefined)?.name),
    })),
    volumes: ((vols.networkVolumes as Json[]) ?? []).map((v) => ({
      id: str(v.id),
      name: str(v.name),
      size_gb: num(v.size) ?? 0,
      datacenter: str(v.dataCenter),
    })),
    pods: ((pods.pods as Json[]) ?? []).map((p) => ({
      id: str(p.id),
      name: str(p.name),
      status: str(p.status),
      cost_per_hr: num(p.cost) ?? 0,
      gpus: num((p.gpu as Json | undefined)?.count) ?? 0,
    })),
  };
}

/**
 * The account's spend from RunPod's billing API (GET /v2/billing: buckets of USD amounts across
 * pods, serverless, storage and the rest). A key without billing access gets the rest of the read
 * and a reason here.
 */
async function readSpend(get: (path: string) => Promise<Json | null>): Promise<RunpodSpend> {
  try {
    const days = (await get("/v2/billing?bucketSize=day&lastN=30")) ?? {};
    const month = (await get("/v2/billing?bucketSize=month&lastN=1")) ?? {};
    const records = ((days.records as Json[]) ?? [])
      .map((r) => ({ day: str(r.startTime).slice(0, 10), usd: num(r.totalAmount) ?? 0 }))
      .filter((r) => r.day)
      .sort((a, b) => a.day.localeCompare(b.day));
    const today = new Date().toISOString().slice(0, 10);
    const totals = ((days.metadata as Json | undefined)?.totals ?? {}) as Json;
    const monthTotals = ((month.metadata as Json | undefined)?.totals ?? {}) as Json;
    return {
      today: records.find((r) => r.day === today)?.usd ?? 0,
      month: num(monthTotals.totalAmount),
      last30: num(totals.totalAmount) ?? records.reduce((t, r) => t + r.usd, 0),
      days: records.slice(-7),
    };
  } catch (err) {
    return {
      today: null,
      month: null,
      last30: null,
      days: [],
      error:
        err instanceof Error && /refused the key/.test(err.message)
          ? "RunPod refused this key for billing: give the key read access to billing to see spend"
          : err instanceof Error
            ? err.message
            : String(err),
    };
  }
}

/** Reads every GPU cloud in Providers again (control's loop, every 15 minutes): prices, pods, spend. */
export async function refreshGpuClouds(
  store: ControlStore,
  secrets: SecretBox,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  for (const g of store.gpuClouds.list()) {
    const sealed = store.gpuClouds.get(g.name)?.key_sealed;
    if (!sealed) continue;
    try {
      store.gpuClouds.setFacts(g.name, {
        facts: await readRunpod(secrets.open(sealed), fetchImpl),
      });
    } catch (err) {
      store.gpuClouds.setFacts(g.name, { error: errorText(err) });
    }
  }
}

/** A short line about the account, for the Providers list. */
export function runpodLine(f: RunpodFacts): string {
  const cheapest = f.gpus.find((g) => g.secure && g.price_secure !== null);
  const running = f.pods.filter((p) => p.cost_per_hr > 0);
  const spend = running.reduce((t, p) => t + p.cost_per_hr, 0);
  return [
    `${f.gpus.length} GPU types`,
    cheapest ? `from $${cheapest.price_secure?.toFixed(2)}/h (${cheapest.name}, Secure)` : "",
    `${f.datacenters.length} data centers`,
    running.length
      ? `${running.length} pod${running.length === 1 ? "" : "s"} running, $${spend.toFixed(2)}/h`
      : "no pod running",
    f.spend && f.spend.month !== null ? `$${f.spend.month.toFixed(2)} spent this month` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
