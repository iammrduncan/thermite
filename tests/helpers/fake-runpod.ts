/**
 * RunPod for tests and acceptance runs: the calls control makes to RunPod's REST API v2
 * (src/control/runpod/cloud.ts) and RunPod's HTTP proxy, behind a fake fetch. Never the real RunPod: a
 * request to any other host throws, so nothing leaves the test, and no key but the fake's works.
 *
 * Pods move as RunPod's do, one step per read of the pod: a new pod is PROVISIONING and a started
 * one STARTING until control reads it, then RUNNING; a stopped pod is EXITED with no GPU; a
 * terminated pod is gone. A running pod costs its GPU's price times its GPUs an hour, and its
 * record (GET /v2/pods/{id}) gives each of its TCP ports a public address and port.
 *
 * Hooks put something real behind a pod: the RunPod acceptance (scripts/acceptance/runpod.mjs)
 * starts a container of the rig image for each pod and points the pod's proxy address at it.
 *
 * A pod's log (GET /v2/pods/{id}/logs) is Server-Sent Events as RunPod sends them: a comment
 * first, then the last `tail` lines (100 when not given, 5000 at most), each an event with an
 * `id:` and a JSON `data:` line, then the lines the test adds while the stream is open. The
 * stream stays open until the reader aborts, as RunPod's does.
 */

/** The fields of RunPod's create-a-pod body (v2); any other is refused, as RunPod does. */
const CREATE_POD_FIELDS = new Set([
  "name",
  "image",
  "args",
  "cmd",
  "entrypoint",
  "disk",
  "env",
  "ports",
  "registry",
  "cloud",
  "gpu",
  "cpu",
  "dataCenterIds",
  "globalNetworking",
  "mounts",
  "startJupyter",
  "startSsh",
  "templateId",
]);

export const FAKE_RUNPOD_KEY = "rpa_test-key-0123456789abcdef";

/** A GPU type as RunPod's catalog lists it. */
export interface FakeGpu {
  id: string;
  name: string;
  memory: number;
  secure: boolean;
  community?: boolean;
  price: { secure?: number | null; community?: number | null };
  availability?: string;
}

export const FAKE_GPUS: FakeGpu[] = [
  {
    id: "NVIDIA H100 80GB HBM3",
    name: "H100 SXM",
    memory: 80,
    secure: true,
    price: { secure: 2.69 },
    availability: "LOW",
  },
  {
    id: "NVIDIA RTX A4000",
    name: "RTX A4000",
    memory: 16,
    secure: true,
    community: true,
    price: { secure: 0.25, community: 0.17 },
    availability: "HIGH",
  },
];

/** What RunPod answers when it has no GPU free for a stopped pod's start (made up, in its style). */
export const NO_FREE_GPU = "There are not enough free GPUs on the host machine to start this pod.";

export interface FakePod {
  id: string;
  status: "PROVISIONING" | "STARTING" | "RUNNING" | "EXITED";
  gpu: string;
  /** The GPUs it was made with, and those it has now (none while stopped). */
  count: number;
  gpus: number;
  cloud: "SECURE" | "COMMUNITY";
  datacenter: string;
  /** The body control made it with: image, ports, env, disk, volume. */
  body: Record<string, unknown>;
  env: Record<string, string>;
  /** Where its proxy addresses lead (a hook sets it); none: the test's `proxy`, or a 404. */
  upstream?: string | undefined;
  /**
   * The public address and port of each TCP port it was made with, while it runs (`runtime.ports`
   * in its record); a hook or the test sets them. None given: a made-up address for each.
   */
  tcp?: Record<number, { ip: string; public: number }> | undefined;
  /** Its log, oldest first (FakeRunpod.log adds to it). */
  logs: FakeLogLine[];
}

/** A line of a pod's log as RunPod's logs route sends it. */
export interface FakeLogLine {
  source: "container" | "system";
  line: string;
  ts: string;
}

export interface FakeRunpodOptions {
  /** The API key RunPod takes (default FAKE_RUNPOD_KEY). */
  key?: string | undefined;
  gpus?: FakeGpu[] | undefined;
  /** RunPod refuses every new pod: no capacity. */
  noCapacity?: boolean | undefined;
  /** RunPod has no GPU free to start a stopped pod (also settable later on the fake). */
  noGpuOnStart?: boolean | undefined;
  /** RunPod can't be reached at all. */
  down?: boolean | undefined;
  /** The key may not read billing. */
  noBilling?: boolean | undefined;
  /** The key may not read pod logs: RunPod answers 403. */
  noLogs?: boolean | undefined;
  /** Before RunPod answers: a pod made, started, stopped or terminated. A throw fails the call. */
  onCreate?: ((pod: FakePod) => void | Promise<void>) | undefined;
  onStart?: ((pod: FakePod) => void | Promise<void>) | undefined;
  onStop?: ((pod: FakePod) => void | Promise<void>) | undefined;
  onTerminate?: ((pod: FakePod) => void | Promise<void>) | undefined;
  /** A request to a running pod's proxy address with no upstream: the test answers it. */
  proxy?:
    | ((pod: FakePod, url: URL, init?: RequestInit) => Response | Promise<Response>)
    | undefined;
}

export interface FakeRunpod {
  /** Use as control's fetch for RunPod (cloudFetch) and for pull mode (the tunnels' fetch). */
  fetch: typeof fetch;
  calls: { method: string; host: string; path: string; search: string; body?: unknown }[];
  pods: Map<string, FakePod>;
  /** The bodies of every stop or start control asked for, in order. */
  actions(): { action: string }[];
  /** The stops only, as `{action: "stop"}`. */
  stops(): { action: string }[];
  /** The pods control removed. */
  terminated(): string[];
  /** RunPod has (or again has) no GPU free to start a stopped pod. */
  setNoGpuOnStart(on: boolean): void;
  /** The pod logs a line now: it goes to its log, and to every open stream of it that takes it. */
  log(pod: string, source: "container" | "system", line: string): void;
  /** The pod log streams open now (one the reader aborted is closed). */
  openLogStreams(): number;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function fakeRunpod(o: FakeRunpodOptions = {}): FakeRunpod {
  const key = o.key ?? FAKE_RUNPOD_KEY;
  const gpus = o.gpus ?? FAKE_GPUS;
  const pods = new Map<string, FakePod>();
  const calls: FakeRunpod["calls"] = [];
  const gone: string[] = [];
  let noGpuOnStart = o.noGpuOnStart ?? false;
  let n = 0;
  let tick = Date.parse("2026-01-01T00:00:00Z");
  /** The open log streams: the pod, its source filter, and how to send them a line. */
  const streams = new Set<{ pod: string; source: string | null; send: (l: FakeLogLine) => void }>();
  const sse = (l: FakeLogLine) =>
    `id: ${l.ts}\ndata: ${JSON.stringify({ ts: l.ts, source: l.source, line: l.line })}\n\n`;
  const logsOf = (p: FakePod, url: URL, init?: RequestInit): Response => {
    if (o.noLogs) return json({ title: "Forbidden", detail: "insufficient permissions" }, 403);
    const tailRaw = url.searchParams.get("tail");
    const tail = tailRaw === null ? 100 : Number(tailRaw);
    const source = url.searchParams.get("source");
    if (!Number.isInteger(tail) || tail < 0 || tail > 5000)
      return json({ title: "Bad Request", detail: "tail must be 0 to 5000" }, 400);
    if (source !== null && source !== "container" && source !== "system")
      return json({ title: "Bad Request", detail: "source must be container or system" }, 400);
    const enc = new TextEncoder();
    const lines = p.logs.filter((l) => source === null || l.source === source);
    const s = { pod: p.id, source, send: (_l: FakeLogLine) => {} };
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(": connected\n\n"));
        for (const l of tail === 0 ? [] : lines.slice(-tail)) c.enqueue(enc.encode(sse(l)));
        s.send = (l) => c.enqueue(enc.encode(sse(l)));
        streams.add(s);
        const signal = init?.signal;
        const abort = () => {
          streams.delete(s);
          try {
            c.error(signal?.reason ?? new DOMException("aborted", "AbortError"));
          } catch {}
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      },
      cancel() {
        streams.delete(s);
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  };
  const perGpu = (p: FakePod) => {
    const g = gpus.find((x) => x.id === p.gpu);
    return (p.cloud === "COMMUNITY" ? g?.price.community : g?.price.secure) ?? 0;
  };
  /** Its TCP ports' public addresses now, as RunPod's record of one pod has them while it runs. */
  const runtimeOf = (p: FakePod) => {
    if (p.status !== "RUNNING") return null;
    const tcp = ((p.body.ports ?? []) as string[]).filter((x) => x.endsWith("/tcp"));
    const ports = tcp.map((x, i) => {
      const inside = Number(x.split("/")[0]);
      const at = p.tcp?.[inside] ?? { ip: "203.0.113.10", public: 40000 + i };
      return { private: inside, public: at.public, type: "tcp", ip: at.ip };
    });
    return { ports };
  };
  /** A pod as RunPod answers it: one pod's record has its runtime; the list of pods has none. */
  const podJson = (p: FakePod, one = false) => ({
    id: p.id,
    status: p.status,
    cost: p.status === "RUNNING" ? perGpu(p) * p.gpus : 0,
    gpu: { id: p.gpu, count: p.gpus },
    dataCenterId: p.datacenter,
    runtime: one ? runtimeOf(p) : null,
  });

  const viaProxy = async (url: URL, init?: RequestInit): Promise<Response> => {
    const [podId] = url.host.split("-");
    const p = pods.get(podId ?? "");
    // RunPod's proxy answers 502 while nothing serves the pod's port.
    if (p?.status !== "RUNNING") return new Response("", { status: 502 });
    if (p.upstream) {
      try {
        return await fetch(`${p.upstream}${url.pathname}${url.search}`, init);
      } catch {
        return new Response("", { status: 502 });
      }
    }
    return o.proxy ? o.proxy(p, url, init) : new Response("", { status: 404 });
  };

  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const isProxy = url.host.endsWith(".proxy.runpod.net");
    let body: unknown;
    if (!isProxy && typeof init?.body === "string") body = JSON.parse(init.body);
    calls.push({
      method,
      host: url.host,
      path: url.pathname,
      search: url.search,
      ...(body ? { body } : {}),
    });
    if (isProxy) return viaProxy(url, init);
    if (url.host !== "api.runpod.io")
      throw new Error(`the fake RunPod answers only RunPod's API and proxy, not ${url.host}`);
    if (o.down) throw new Error("getaddrinfo ENOTFOUND api.runpod.io");
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${key}`)
      return json({ title: "Unauthorized" }, 401);
    const path = url.pathname;
    if (path === "/v2/catalog/gpus") return json({ gpus });
    if (path === "/v2/catalog/datacenters")
      return json({ dataCenters: [{ id: "EU-RO-1", name: "Romania", region: "Europe" }] });
    if (path === "/v2/network-volumes")
      return json({
        networkVolumes: [{ id: "v1", name: "kits", size: 50, dataCenter: "EU-RO-1" }],
      });
    if (path === "/v2/billing") {
      if (o.noBilling) return json({ title: "Forbidden" }, 403);
      return json({ records: [], metadata: { totals: { totalAmount: 0 } } });
    }
    if (path === "/v2/pods" && method === "GET")
      return json({ pods: [...pods.values()].map((p) => podJson(p)) });
    if (path === "/v2/pods" && method === "POST") {
      const b = body as {
        gpu: { id: string; count: number };
        cloud: "SECURE" | "COMMUNITY";
        dataCenterIds?: string[];
        env?: Record<string, string>;
      };
      // RunPod refuses a body with a field its create-a-pod schema (v2) does not have.
      const unknown = Object.keys(body as object).filter((k) => !CREATE_POD_FIELDS.has(k));
      const mounts = (body as { mounts?: Record<string, unknown> }).mounts;
      const persistent = mounts?.persistent as Record<string, unknown> | undefined;
      if (
        unknown.length ||
        (mounts && Object.keys(mounts).some((k) => k !== "persistent" && k !== "network")) ||
        (persistent &&
          (Object.keys(persistent).some((k) => k !== "size" && k !== "path") ||
            Number(persistent.size) < 10))
      )
        return json(
          {
            title: "Unprocessable Entity",
            detail: "Request validation failed.",
            errors: unknown.length ? unknown.map((k) => ({ field: k })) : [{ field: "mounts" }],
          },
          422,
        );
      if (o.noCapacity)
        return json({ title: "Bad Request", detail: "no capacity for that GPU" }, 400);
      const p: FakePod = {
        id: `pod${++n}`,
        status: "PROVISIONING",
        gpu: b.gpu.id,
        count: b.gpu.count,
        gpus: b.gpu.count,
        cloud: b.cloud,
        datacenter: b.dataCenterIds?.[0] ?? "EU-RO-1",
        body: body as Record<string, unknown>,
        env: b.env ?? {},
        logs: [],
      };
      await o.onCreate?.(p);
      pods.set(p.id, p);
      return json(podJson(p), 201);
    }
    const m = /^\/v2\/pods\/([^/]+)(\/action|\/logs)?$/.exec(path);
    const p = m ? pods.get(m[1] ?? "") : undefined;
    if (!m || !p) return json({ title: "Not Found" }, 404);
    if (m[2] === "/logs") return method === "GET" ? logsOf(p, url, init) : json({}, 405);
    if (method === "DELETE") {
      await o.onTerminate?.(p);
      pods.delete(p.id);
      gone.push(p.id);
      return new Response(null, { status: 204 });
    }
    if (m[2] === "/action") {
      const action = (body as { action?: string } | undefined)?.action;
      if (action === "stop") {
        if (p.status === "EXITED")
          return json({ title: "Conflict", detail: "already stopped" }, 409);
        await o.onStop?.(p);
        p.status = "EXITED";
        p.gpus = 0;
      } else if (action === "start") {
        if (p.status !== "EXITED") return json({ title: "Conflict", detail: "not stopped" }, 409);
        if (noGpuOnStart) return json({ title: "Bad Request", detail: NO_FREE_GPU }, 400);
        await o.onStart?.(p);
        p.status = "STARTING";
        p.gpus = p.count;
      } else return json({ title: "Bad Request", detail: `no action ${action}` }, 400);
      return json(podJson(p));
    }
    // Each read moves a pod that is being made or started on, as RunPod does in its own time.
    if (p.status === "PROVISIONING" || p.status === "STARTING") p.status = "RUNNING";
    return json(podJson(p, true));
  }) as typeof fetch;

  const actions = () =>
    calls
      .filter((c) => c.method === "POST" && c.path.endsWith("/action"))
      .map((c) => c.body as { action: string });
  return {
    fetch: f,
    calls,
    pods,
    actions,
    stops: () => actions().filter((a) => a.action === "stop"),
    terminated: () => [...gone],
    setNoGpuOnStart: (on) => {
      noGpuOnStart = on;
    },
    log: (pod, source, line) => {
      const p = pods.get(pod);
      if (!p) throw new Error(`the fake RunPod has no pod ${pod}`);
      tick += 1000;
      const l = { source, line, ts: new Date(tick).toISOString() };
      p.logs.push(l);
      for (const s of streams)
        if (s.pod === pod && (s.source === null || s.source === source)) s.send(l);
    },
    openLogStreams: () => streams.size,
  };
}
