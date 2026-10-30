import { connect } from "node:net";
import {
  type AdvisorRunAnswer,
  AdvisorRunOutcome,
  type AdvisorRunRequest,
} from "../../core/advisor-runs.ts";

/** A run as the helper takes it: what core/advisor-runs.ts's `run` request carries, but its id. */
export type RunAsRequest = Omit<Extract<AdvisorRunRequest, { op: "run" }>, "id" | "op">;

/**
 * The supervisor's side of the advisors' runner (server.ts): each call on a connection of its
 * own, so that a run whose call is stopped (`signal`) ends with its connection, and the helper
 * kills every process of its user.
 */
export class RunAsClient {
  private readonly socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  /** One request on a connection of its own; its answer, or the helper's refusal as an error. */
  private ask(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const sock = connect(this.socketPath);
      let buf = "";
      let settled = false;
      const settle = (f: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", stop);
        sock.destroy();
        f();
      };
      const stop = () => settle(() => reject(new Error("the advisor's run was stopped")));
      if (signal?.aborted) return stop();
      signal?.addEventListener("abort", stop, { once: true });
      sock.setEncoding("utf8");
      sock.on("data", (chunk: string) => {
        buf += chunk;
        const end = buf.indexOf("\n");
        if (end < 0) return;
        const res = JSON.parse(buf.slice(0, end)) as AdvisorRunAnswer;
        settle(() =>
          res.ok ? resolve(res.result) : reject(new Error(`advisor runs: ${res.error}`)),
        );
      });
      sock.on("error", (err) => settle(() => reject(err)));
      sock.on("close", () =>
        settle(() => reject(new Error("the advisors' runner closed the connection"))),
      );
      sock.write(`${JSON.stringify({ id: 1, ...body })}\n`);
    });
  }

  /** Runs a program as an advisor user, in its folder (a child of the helper's root). */
  async run(req: RunAsRequest, signal?: AbortSignal): Promise<AdvisorRunOutcome> {
    return AdvisorRunOutcome.parse(await this.ask({ op: "run", ...req }, signal));
  }

  /** Removes a run's folder, with what its user left there. */
  async remove(dir: string): Promise<void> {
    await this.ask({ op: "remove", dir });
  }
}
