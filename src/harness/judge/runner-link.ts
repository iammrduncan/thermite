import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { QueuedRun, RunAsk } from "../../core/api/harness/runs.ts";
import type { RunLink } from "./remote-runner.ts";

/**
 * The core's link to its runners (goal 206): the asks of a runner process wait here until the
 * supervisor takes them (RUN_ASKS), carries each on the bus and brings back the runner's answer
 * (RUN_ANSWER). The harness never reaches its supervisor; the supervisor comes for the asks. A git
 * bundle waits as a file in the outbox, which the supervisor reads (its outbox is read-only to it),
 * and which goes once the ask is answered or fails. An ask not answered in time fails, and the
 * judge's job with it, which the judge tries again as an infrastructure failure. The supervisor's
 * first take after it starts takes again the asks a supervisor took before and never answered: it
 * stopped, and nobody carries them.
 */

/** The longest a runner may take to answer: a build or a run of the longest kits. */
const RUNNER_ANSWER_MS = 3 * 3_600_000;
/** The longest a runner may take to say how its fetch of model files stands (goal 213). */
const POLL_ANSWER_MS = 5 * 60_000;

/**
 * A runner that left the rig or stopped answering (goal 206): its run failed for that alone. The
 * judge queues its job again and a lane is told; neither counts it against the change.
 */
export class RunnerAway extends Error {}

interface Open {
  item: QueuedRun;
  deadline: number;
  resolve: (answer: unknown) => void;
  reject: (err: Error) => void;
}

export class RunnerLink {
  private readonly outboxDir: string;
  private readonly answerMs: number;
  private readonly waiting: Open[] = [];
  private readonly taken = new Map<string, Open>();
  private wakers: (() => void)[] = [];

  constructor(o: { outboxDir: string; answerMs?: number | undefined }) {
    this.outboxDir = o.outboxDir;
    this.answerMs = o.answerMs ?? RUNNER_ANSWER_MS;
  }

  /** How the core reaches one runner process. */
  to(runner: string): RunLink {
    return {
      ask: (ask: RunAsk, answerMs?: number) =>
        this.put({ id: randomUUID(), runner, kind: "ask", ask }, answerMs),
      sendGit: async (repo, commit, bundle) => {
        const id = randomUUID();
        // A dot folder: the supervisor's exports take no name that starts with a dot.
        const dir = join(this.outboxDir, ".runs");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${id}.bundle`), bundle, { mode: 0o640 });
        await this.put({ id, runner, kind: "git", repo, commit, file: `.runs/${id}.bundle` });
      },
      // In turns, each answered at once (goal 213): within a part's time, never a build's.
      fetchModels: (models, poll) =>
        this.put({ id: randomUUID(), runner, kind: "models", models, poll }, POLL_ANSWER_MS),
    };
  }

  private put(item: QueuedRun, answerMs = this.answerMs): Promise<unknown> {
    // A bundle's file goes once its ask ends, answered or not.
    const done = () => {
      if (item.kind === "git") rmSync(join(this.outboxDir, item.file), { force: true });
    };
    return new Promise((ok, no) => {
      const resolve = (answer: unknown) => {
        done();
        ok(answer);
      };
      const reject = (err: Error) => {
        done();
        no(err);
      };
      this.waiting.push({ item, deadline: Date.now() + answerMs, resolve, reject });
      for (const wake of this.wakers.splice(0)) wake();
      // Failed at its time also while no supervisor comes for the asks.
      setTimeout(() => this.expire(), answerMs + 10).unref?.();
    });
  }

  /**
   * Fails every ask of `runner` now, waiting or taken, as a runner away: it left the rig or stopped
   * answering. An answer that comes later finds no ask open.
   */
  fail(runner: string, reason: string): void {
    const mine = (o: Open) => o.item.runner === runner;
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      const o = this.waiting[i] as Open;
      if (!mine(o)) continue;
      this.waiting.splice(i, 1);
      o.reject(new RunnerAway(reason));
    }
    for (const [id, o] of this.taken)
      if (mine(o)) {
        this.taken.delete(id);
        o.reject(new RunnerAway(reason));
      }
  }

  /** Fails the asks past their time, waiting or taken. */
  private expire(now = Date.now()): void {
    const late = (o: Open) => o.deadline <= now;
    const fail = (o: Open) =>
      o.reject(new Error(`runner ${o.item.runner} gave no answer to its ${what(o.item)} in time`));
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      const o = this.waiting[i] as Open;
      if (!late(o)) continue;
      this.waiting.splice(i, 1);
      fail(o);
    }
    for (const [id, o] of this.taken)
      if (late(o)) {
        this.taken.delete(id);
        fail(o);
      }
  }

  /**
   * The asks waiting, at most `max`, taken by the supervisor; waits up to `waitMs` for one.
   * `again`: the supervisor's first take since it started, which takes again, first, the asks a
   * supervisor took before and never answered.
   */
  async take(waitMs: number, max = 16, again = false): Promise<QueuedRun[]> {
    if (again) {
      this.waiting.unshift(...this.taken.values());
      this.taken.clear();
    }
    this.expire();
    if (!this.waiting.length && waitMs > 0)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        this.wakers.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    const out = this.waiting.splice(0, max);
    for (const o of out) this.taken.set(o.item.id, o);
    return out.map((o) => o.item);
  }

  /** A runner's answer to an ask taken, or why none came. False: no such ask is open. */
  answer(id: string, a: { answer?: unknown; error?: string | undefined }): boolean {
    const o = this.taken.get(id);
    if (!o) return false;
    this.taken.delete(id);
    if (a.error !== undefined) o.reject(new Error(`runner ${o.item.runner}: ${a.error}`));
    else o.resolve(a.answer);
    return true;
  }
}

/** An ask in words, for a failure's reason. */
function what(item: QueuedRun): string {
  return item.kind === "git"
    ? `commit ${item.commit.slice(0, 12)}`
    : item.kind === "models"
      ? `model files (${item.models.length})`
      : item.ask.op;
}
