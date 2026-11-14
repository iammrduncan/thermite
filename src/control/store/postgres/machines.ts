import { redact } from "../../../common/log.ts";
import {
  type Machine,
  type MachineRig,
  type Machines,
  machineOf,
  machineRigOf,
} from "../machines.ts";
import { PgPart, type Row } from "./part.ts";

/** Machines on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresMachines extends PgPart implements Machines {
  async add(m: {
    name: string;
    address: string;
    port: number;
    user: string;
    key_sealed: string;
    public_key: string;
    key_fingerprint: string;
    seen_host_keys: string[];
    by: string;
  }): Promise<void> {
    await this.q.run(
      `insert into machine (name, address, port, "user", key_sealed, public_key, key_fingerprint, seen_host_keys, created_at, created_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      m.name,
      m.address,
      m.port,
      m.user,
      m.key_sealed,
      m.public_key,
      m.key_fingerprint,
      JSON.stringify(m.seen_host_keys),
      new Date().toISOString(),
      m.by,
    );
    await this.store.auditLog.add(m.by, "machine_added", {
      name: m.name,
      address: m.address,
      port: m.port,
      user: m.user,
      key: m.key_fingerprint,
    });
  }

  async get(name: string): Promise<(Machine & { key_sealed: string }) | undefined> {
    const r = (await this.q.get("select * from machine where name = ?", name)) as Row | undefined;
    return r ? { ...machineOf(r), key_sealed: String(r.key_sealed) } : undefined;
  }

  async list(): Promise<Machine[]> {
    return ((await this.q.all("select * from machine order by name")) as Row[]).map(machineOf);
  }

  /** The host keys the machine presents now, kept for the owner to compare. */
  async seeHostKeys(name: string, lines: string[]): Promise<void> {
    await this.q.run(
      "update machine set seen_host_keys = ? where name = ?",
      JSON.stringify(lines),
      name,
    );
  }

  /** The owner trusts the host keys they were shown: from now on only these connect. */
  async trustHostKeys(name: string, lines: string[], by: string): Promise<void> {
    await this.q.run(
      "update machine set host_keys = ? where name = ?",
      JSON.stringify(lines),
      name,
    );
    await this.store.auditLog.add(by, "machine_host_key_trusted", { name, keys: lines.length });
  }

  /** What the last check found, or why it failed (keeping the facts before it). */
  async setFacts(name: string, r: { facts: unknown } | { error: string }): Promise<void> {
    if ("facts" in r)
      await this.q.run(
        "update machine set facts = ?, checked_at = ?, check_error = null where name = ?",
        JSON.stringify(r.facts),
        new Date().toISOString(),
        name,
      );
    else
      await this.q.run(
        "update machine set checked_at = ?, check_error = ? where name = ?",
        new Date().toISOString(),
        redact(r.error),
        name,
      );
  }

  /** The owner's yes to one install: one recipe's exact script on one machine, used once. */
  async approveInstall(i: {
    machine: string;
    recipe: string;
    script_sha: string;
    by: string;
    ttlMs: number;
  }): Promise<number> {
    const now = Date.now();
    const r = await this.q.insert(
      `insert into machine_install (machine, recipe, script_sha, approved_by, approved_at, expires_at)
         values (?, ?, ?, ?, ?, ?)`,
      i.machine,
      i.recipe,
      i.script_sha,
      i.by,
      new Date(now).toISOString(),
      new Date(now + i.ttlMs).toISOString(),
    );
    await this.store.auditLog.add(i.by, "machine_install_approved", {
      machine: i.machine,
      recipe: i.recipe,
      script_sha: i.script_sha,
    });
    return r;
  }

  /** Uses an approval: false when it was used already, has expired, or doesn't match. */
  async startInstall(
    id: number,
    machine: string,
    recipe: string,
    scriptSha: string,
  ): Promise<boolean> {
    const r = await this.q.run(
      `update machine_install set started_at = ?
         where id = ? and machine = ? and recipe = ? and script_sha = ? and started_at is null and expires_at > ?`,
      new Date().toISOString(),
      id,
      machine,
      recipe,
      scriptSha,
      new Date().toISOString(),
    );
    return Number(r.changes) > 0;
  }

  async finishInstall(id: number, ok: boolean, output: string): Promise<void> {
    const r = await this.q.run(
      "update machine_install set finished_at = ?, ok = ?, output = ? where id = ?",
      new Date().toISOString(),
      ok ? 1 : 0,
      output.slice(-4000),
      id,
    );
    if (Number(r.changes)) {
      const row = (await this.q.get(
        "select machine, recipe from machine_install where id = ?",
        id,
      )) as Row;
      await this.store.auditLog.add("control", "machine_install_finished", {
        machine: String(row.machine),
        recipe: String(row.recipe),
        ok,
      });
    }
  }

  /** A machine's installs, newest first. */
  async installs(machine: string): Promise<
    {
      id: number;
      recipe: string;
      approved_by: string;
      approved_at: string;
      started_at: string | null;
      finished_at: string | null;
      ok: boolean | null;
      output: string | null;
    }[]
  > {
    return (
      (await this.q.all(
        "select * from machine_install where machine = ? order by id desc limit 20",
        machine,
      )) as Row[]
    ).map((r) => ({
      id: Number(r.id),
      recipe: String(r.recipe),
      approved_by: String(r.approved_by),
      approved_at: String(r.approved_at),
      started_at: r.started_at === null ? null : String(r.started_at),
      finished_at: r.finished_at === null ? null : String(r.finished_at),
      ok: r.ok === null ? null : Number(r.ok) === 1,
      output: r.output === null ? null : String(r.output),
    }));
  }

  async addRig(r: Omit<MachineRig, "created_at" | "status">): Promise<void> {
    await this.q.run(
      `insert into machine_rig (rig, machine, gpus, judge_gpus, images, root, judge_on_runners, status, created_at, created_by)
         values (?, ?, ?, ?, ?, ?, ?, 'deploying', ?, ?)`,
      r.rig,
      r.machine,
      JSON.stringify(r.gpus),
      r.judge_gpus ?? null,
      JSON.stringify(r.images),
      r.root ? 1 : 0,
      r.judge_on_runners ? 1 : 0,
      new Date().toISOString(),
      r.created_by,
    );
    await this.store.auditLog.add(r.created_by, "machine_rig_created", {
      rig: r.rig,
      machine: r.machine,
      gpus: r.gpus,
      images: r.images,
    });
  }

  async rig(rig: string): Promise<MachineRig | undefined> {
    const r = (await this.q.get("select * from machine_rig where rig = ?", rig)) as Row | undefined;
    return r ? machineRigOf(r) : undefined;
  }

  /** The rigs control set up, on one machine or all, removed ones last. */
  async rigs(machine?: string): Promise<MachineRig[]> {
    const rows = (
      machine
        ? await this.q.all("select * from machine_rig where machine = ? order by rig", machine)
        : await this.q.all("select * from machine_rig order by machine, rig")
    ) as Row[];
    return rows.map(machineRigOf);
  }

  async setRigStatus(rig: string, status: string): Promise<void> {
    await this.q.run("update machine_rig set status = ? where rig = ?", status, rig);
  }

  /** The images a rig control set up on a machine runs now, after an update. */
  async setRigImages(rig: string, images: MachineRig["images"]): Promise<void> {
    await this.q.run(
      "update machine_rig set images = ? where rig = ?",
      JSON.stringify(images),
      rig,
    );
  }

  async delete(name: string, by: string): Promise<boolean> {
    const r = await this.q.run("delete from machine where name = ?", name);
    if (Number(r.changes)) await this.store.auditLog.add(by, "machine_deleted", { name });
    return Number(r.changes) > 0;
  }
}
