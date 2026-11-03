import { type Row, StorePart } from "./part.ts";
import type { RunningRun } from "./usage.ts";

/**
 * Rigs and test pods on GPU clouds (goal 125, T6), with their state as runpod/rigs.ts and
 * runpod/tests.ts keep it.
 */

/** A rig launched on a GPU cloud, as kept: its state is runpod/rigs.ts's RigState. */
export interface StoredRunpodRig {
  rig: string;
  cloud: string;
  pod: string;
  /** Control still follows its pod (false once RunPod no longer has it). */
  active: boolean;
  state: unknown;
  created_at: string;
  created_by: string;
}

const runpodRigOf = (r: Row): StoredRunpodRig => ({
  rig: String(r.rig),
  cloud: String(r.cloud),
  pod: String(r.pod),
  active: Number(r.active) === 1,
  state: JSON.parse(String(r.state)),
  created_at: String(r.created_at),
  created_by: String(r.created_by),
});

/** A test pod as kept: its state is runpod/tests.ts's TestState. */
export interface StoredRunpodTest {
  id: string;
  cloud: string;
  active: boolean;
  state: unknown;
  created_at: string;
  created_by: string;
}

const runpodTestOf = (r: Row): StoredRunpodTest => ({
  id: String(r.id),
  cloud: String(r.cloud),
  active: Number(r.active) === 1,
  state: JSON.parse(String(r.state)),
  created_at: String(r.created_at),
  created_by: String(r.created_by),
});

export class RunpodStore extends StorePart {
  addRig(t: { rig: string; cloud: string; pod: string; state: unknown; by: string }): void {
    this.db
      .prepare(
        "insert into runpod_rig (rig, cloud, pod, active, state, created_at, created_by) values (?, ?, ?, 1, ?, ?, ?)",
      )
      .run(t.rig, t.cloud, t.pod, JSON.stringify(t.state), new Date().toISOString(), t.by);
  }

  /**
   * Saves a rig's state on its GPU cloud. What its pod cost since control last counted it goes to
   * the runs its rig runs now, `running` (control/runpod's saveRunpodRig gives them).
   */
  saveRig(rig: string, state: unknown, active: boolean, running: RunningRun[]): void {
    const spent = (s: unknown) => {
      const n = (s as { spent_usd?: unknown } | null)?.spent_usd;
      return typeof n === "number" && Number.isFinite(n) ? n : 0;
    };
    this.tx(() => {
      const before = this.rig(rig);
      this.db
        .prepare("update runpod_rig set state = ?, active = ? where rig = ?")
        .run(JSON.stringify(state), active ? 1 : 0, rig);
      if (before) this.store.usage.notePodSpend(rig, spent(state) - spent(before.state), running);
    });
  }

  rig(rig: string): StoredRunpodRig | undefined {
    const r = this.db.prepare("select * from runpod_rig where rig = ?").get(rig) as Row | undefined;
    return r ? runpodRigOf(r) : undefined;
  }

  /** RunPod rigs, newest first: on one cloud, or only those control still follows. */
  rigs(f: { cloud?: string | undefined; active?: boolean } = {}): StoredRunpodRig[] {
    return (
      this.db
        .prepare(
          `select * from runpod_rig where (? is null or cloud = ?) and (? = 0 or active = 1)
           order by created_at desc, rig desc`,
        )
        .all(f.cloud ?? null, f.cloud ?? null, f.active ? 1 : 0) as Row[]
    ).map(runpodRigOf);
  }

  addTest(t: { id: string; cloud: string; state: unknown; by: string }): void {
    this.db
      .prepare(
        "insert into runpod_test (id, cloud, active, state, created_at, created_by) values (?, ?, 1, ?, ?, ?)",
      )
      .run(t.id, t.cloud, JSON.stringify(t.state), new Date().toISOString(), t.by);
  }

  /** Saves a test's state; `active` is false once its pod is gone. */
  saveTest(id: string, state: unknown, active: boolean): void {
    this.db
      .prepare("update runpod_test set state = ?, active = ? where id = ?")
      .run(JSON.stringify(state), active ? 1 : 0, id);
  }

  test(id: string): StoredRunpodTest | undefined {
    const r = this.db.prepare("select * from runpod_test where id = ?").get(id) as Row | undefined;
    return r ? runpodTestOf(r) : undefined;
  }

  /** Newest first; only those whose pod may still exist with `active`. */
  tests(
    f: { cloud?: string | undefined; active?: boolean; limit?: number } = {},
  ): StoredRunpodTest[] {
    return (
      this.db
        .prepare(
          `select * from runpod_test where (? is null or cloud = ?) and (? = 0 or active = 1)
           order by created_at desc, id desc limit ?`,
        )
        .all(f.cloud ?? null, f.cloud ?? null, f.active ? 1 : 0, f.limit ?? 50) as Row[]
    ).map(runpodTestOf);
  }
}
