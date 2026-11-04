import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeviceAsk, QueuedAsk } from "../../core/api/harness/device.ts";
import type { DeviceLink } from "./remote.ts";

/**
 * The leader's link to its followers (goal 205): the judge's asks of a follower's device wait here
 * until the supervisor takes them (DEVICE_ASKS), carries each on the bus and brings back the
 * follower's answer (DEVICE_ANSWER). The harness never reaches its supervisor; the supervisor
 * comes for the asks. A git bundle waits as a file in the outbox, which the supervisor reads and
 * removes. An ask not answered in time fails, and the judge's job with it, which the judge tries
 * again as an infrastructure failure.
 */

/** The longest a follower may take to answer: a build or a run of the longest kits. */
const FOLLOWER_ANSWER_MS = 3 * 3_600_000;

interface Open {
  item: QueuedAsk;
  deadline: number;
  resolve: (answer: unknown) => void;
  reject: (err: Error) => void;
}

export class FollowerLink {
  private readonly outboxDir: string;
  private readonly answerMs: number;
  private readonly waiting: Open[] = [];
  private readonly taken = new Map<string, Open>();
  private wakers: (() => void)[] = [];

  constructor(o: { outboxDir: string; answerMs?: number | undefined }) {
    this.outboxDir = o.outboxDir;
    this.answerMs = o.answerMs ?? FOLLOWER_ANSWER_MS;
  }

  /** How the judge reaches one follower's device. */
  to(machine: string): DeviceLink {
    return {
      ask: (ask: DeviceAsk) => this.put({ id: randomUUID(), machine, kind: "ask", ask }),
      sendGit: async (repo, commit, bundle) => {
        const id = randomUUID();
        const dir = join(this.outboxDir, "device");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${id}.bundle`), bundle, { mode: 0o640 });
        await this.put({ id, machine, kind: "git", repo, commit, file: `device/${id}.bundle` });
      },
    };
  }

  private put(item: QueuedAsk): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.waiting.push({ item, deadline: Date.now() + this.answerMs, resolve, reject });
      for (const wake of this.wakers.splice(0)) wake();
    });
  }

  /** Fails the asks past their time, waiting or taken. */
  private expire(now = Date.now()): void {
    const late = (o: Open) => o.deadline <= now;
    const fail = (o: Open) =>
      o.reject(
        new Error(`follower ${o.item.machine} gave no answer to its ${what(o.item)} in time`),
      );
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

  /** The asks waiting, at most `max`, taken by the supervisor; waits up to `waitMs` for one. */
  async take(waitMs: number, max = 16): Promise<QueuedAsk[]> {
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

  /** A follower's answer to an ask taken, or why none came. False: no such ask is open. */
  answer(id: string, a: { answer?: unknown; error?: string | undefined }): boolean {
    const o = this.taken.get(id);
    if (!o) return false;
    this.taken.delete(id);
    if (a.error !== undefined) o.reject(new Error(`follower ${o.item.machine}: ${a.error}`));
    else o.resolve(a.answer);
    return true;
  }
}

/** An ask in words, for a failure's reason. */
function what(item: QueuedAsk): string {
  return item.kind === "git" ? `commit ${item.commit.slice(0, 12)}` : item.ask.op;
}
