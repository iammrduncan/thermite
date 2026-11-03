import { connect, type Socket } from "node:net";
import type { PairOutcome } from "./pair.ts";
import type { BrokerResponse } from "./protocol.ts";
import type { Role, Runner, RunOutcome, RunRequest } from "./runner.ts";

/** The controller's side of the broker socket: a Runner whose roles are separate users. */
export class BrokerClient implements Runner {
  readonly separated = true;
  private readonly socketPath: string;
  private sock: Socket | undefined;
  private buf = "";
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  private socket(): Socket {
    if (this.sock && !this.sock.destroyed) return this.sock;
    const sock = connect(this.socketPath);
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      this.buf += chunk;
      for (let i = this.buf.indexOf("\n"); i >= 0; i = this.buf.indexOf("\n")) {
        const res = JSON.parse(this.buf.slice(0, i)) as BrokerResponse;
        this.buf = this.buf.slice(i + 1);
        const p = this.pending.get(res.id);
        // Every request carries its id, and the broker answers a refused one under it too.
        if (!p) continue;
        this.pending.delete(res.id);
        if (res.ok) p.resolve(res.result);
        else p.reject(new Error(`broker: ${res.error}`));
      }
    });
    const failAll = (err: Error) => {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.sock = undefined;
    };
    sock.on("error", failAll);
    sock.on("close", () => failAll(new Error("broker connection closed")));
    this.sock = sock;
    return sock;
  }

  private call<T>(body: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.socket().write(`${JSON.stringify({ id, ...body })}\n`);
    });
  }

  run(req: RunRequest): Promise<RunOutcome> {
    return this.call({ op: "run", req });
  }

  runPair(driver: RunRequest, candidate: RunRequest): Promise<PairOutcome> {
    return this.call({ op: "runPair", driver, candidate });
  }

  handOver(path: string, role: Role, opts: { harnessReads?: boolean } = {}): Promise<void> {
    return this.call({ op: "handOver", path, role, ...opts });
  }

  reclaim(path: string): Promise<void> {
    return this.call({ op: "reclaim", path });
  }

  remove(path: string): Promise<void> {
    return this.call({ op: "remove", path });
  }

  killRole(role: Role, opts: { gpu?: boolean } = {}): Promise<number> {
    return this.call({ op: "killRole", role, ...(opts.gpu ? { gpu: true } : {}) });
  }

  close(): void {
    this.sock?.end();
  }
}
