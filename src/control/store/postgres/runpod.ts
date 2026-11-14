import {
  type RunpodStore,
  runpodRigOf,
  runpodTestOf,
  type StoredRunpodRig,
  type StoredRunpodTest,
} from "../runpod.ts";
import type { RunningRun } from "../usage.ts";
import { PgPart, type Row } from "./part.ts";

/** RunpodStore on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresRunpodStore extends PgPart implements RunpodStore {
  async addRig(t: {
    rig: string;
    cloud: string;
    pod: string;
    state: unknown;
    by: string;
  }): Promise<void> {
    await this.q.run(
      "insert into runpod_rig (rig, cloud, pod, active, state, created_at, created_by) values (?, ?, ?, 1, ?, ?, ?)",
      t.rig,
      t.cloud,
      t.pod,
      JSON.stringify(t.state),
      new Date().toISOString(),
      t.by,
    );
  }

  /**
   * Saves a rig's state on its GPU cloud. What its pod cost since control last counted it goes to
   * the runs its rig runs now, `running` (control/runpod's saveRunpodRig gives them).
   */
  async saveRig(
    rig: string,
    state: unknown,
    active: boolean,
    running: RunningRun[],
  ): Promise<void> {
    const spent = (s: unknown) => {
      const n = (s as { spent_usd?: unknown } | null)?.spent_usd;
      return typeof n === "number" && Number.isFinite(n) ? n : 0;
    };
    await this.tx(async () => {
      const before = await this.rig(rig);
      await this.q.run(
        "update runpod_rig set state = ?, active = ? where rig = ?",
        JSON.stringify(state),
        active ? 1 : 0,
        rig,
      );
      if (before)
        await this.store.usage.notePodSpend(rig, spent(state) - spent(before.state), running);
    });
  }

  async rig(rig: string): Promise<StoredRunpodRig | undefined> {
    const r = (await this.q.get("select * from runpod_rig where rig = ?", rig)) as Row | undefined;
    return r ? runpodRigOf(r) : undefined;
  }

  /** RunPod rigs, newest first: on one cloud, or only those control still follows. */
  async rigs(f: { cloud?: string | undefined; active?: boolean } = {}): Promise<StoredRunpodRig[]> {
    return (
      (await this.q.all(
        `select * from runpod_rig where (?::text is null or cloud = ?) and (? = 0 or active = 1)
           order by created_at desc, rig desc`,
        f.cloud ?? null,
        f.cloud ?? null,
        f.active ? 1 : 0,
      )) as Row[]
    ).map(runpodRigOf);
  }

  async addTest(t: { id: string; cloud: string; state: unknown; by: string }): Promise<void> {
    await this.q.run(
      "insert into runpod_test (id, cloud, active, state, created_at, created_by) values (?, ?, 1, ?, ?, ?)",
      t.id,
      t.cloud,
      JSON.stringify(t.state),
      new Date().toISOString(),
      t.by,
    );
  }

  /** Saves a test's state; `active` is false once its pod is gone. */
  async saveTest(id: string, state: unknown, active: boolean): Promise<void> {
    await this.q.run(
      "update runpod_test set state = ?, active = ? where id = ?",
      JSON.stringify(state),
      active ? 1 : 0,
      id,
    );
  }

  async test(id: string): Promise<StoredRunpodTest | undefined> {
    const r = (await this.q.get("select * from runpod_test where id = ?", id)) as Row | undefined;
    return r ? runpodTestOf(r) : undefined;
  }

  /** Newest first; only those whose pod may still exist with `active`. */
  async tests(
    f: { cloud?: string | undefined; active?: boolean; limit?: number } = {},
  ): Promise<StoredRunpodTest[]> {
    return (
      (await this.q.all(
        `select * from runpod_test where (?::text is null or cloud = ?) and (? = 0 or active = 1)
           order by created_at desc, id desc limit ?`,
        f.cloud ?? null,
        f.cloud ?? null,
        f.active ? 1 : 0,
        f.limit ?? 50,
      )) as Row[]
    ).map(runpodTestOf);
  }
}
