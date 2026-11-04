import { redact } from "../../common/log.ts";
import { type Row, StorePart } from "./part.ts";

/**
 * Machines over SSH (goal 125, T6): the machines, the installs the owner approved on them, and
 * the rigs control set up there.
 */

/** A machine as listed (never its key). Host keys are known_hosts lines. */
export interface Machine {
  name: string;
  address: string;
  port: number;
  user: string;
  public_key: string;
  key_fingerprint: string;
  /** The host keys the owner trusted; empty until then. */
  host_keys: string[];
  /** The host keys the machine presented when last asked, for the owner to compare. */
  seen_host_keys: string[];
  facts: unknown;
  checked_at: string | null;
  check_error: string | null;
  created_at: string;
}

const machineOf = (r: Row): Machine => ({
  name: String(r.name),
  address: String(r.address),
  port: Number(r.port),
  user: String(r.user),
  public_key: String(r.public_key),
  key_fingerprint: String(r.key_fingerprint),
  host_keys: JSON.parse(String(r.host_keys)) as string[],
  seen_host_keys: JSON.parse(String(r.seen_host_keys)) as string[],
  facts: r.facts ? JSON.parse(String(r.facts)) : null,
  checked_at: r.checked_at === null ? null : String(r.checked_at),
  check_error: r.check_error === null ? null : String(r.check_error),
  created_at: String(r.created_at),
});

/** A rig control set up on a machine. */
export interface MachineRig {
  rig: string;
  machine: string;
  gpus: number[];
  /** With two or more GPUs: how many (the lowest-numbered) are the judge's; the rest are the agents'. */
  judge_gpus?: number | undefined;
  images: { harness: string; supervisor: string };
  root: boolean;
  /** deploying, running, stopped, failed, removed. */
  status: string;
  created_at: string;
  created_by: string;
}

const machineRigOf = (r: Row): MachineRig => ({
  rig: String(r.rig),
  machine: String(r.machine),
  gpus: JSON.parse(String(r.gpus)) as number[],
  judge_gpus:
    r.judge_gpus === null || r.judge_gpus === undefined ? undefined : Number(r.judge_gpus),
  images: JSON.parse(String(r.images)) as MachineRig["images"],
  root: Number(r.root) === 1,
  status: String(r.status),
  created_at: String(r.created_at),
  created_by: String(r.created_by),
});

export class Machines extends StorePart {
  add(m: {
    name: string;
    address: string;
    port: number;
    user: string;
    key_sealed: string;
    public_key: string;
    key_fingerprint: string;
    seen_host_keys: string[];
    by: string;
  }): void {
    this.db
      .prepare(
        `insert into machine (name, address, port, user, key_sealed, public_key, key_fingerprint, seen_host_keys, created_at, created_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
    this.store.auditLog.add(m.by, "machine_added", {
      name: m.name,
      address: m.address,
      port: m.port,
      user: m.user,
      key: m.key_fingerprint,
    });
  }

  get(name: string): (Machine & { key_sealed: string }) | undefined {
    const r = this.db.prepare("select * from machine where name = ?").get(name) as Row | undefined;
    return r ? { ...machineOf(r), key_sealed: String(r.key_sealed) } : undefined;
  }

  list(): Machine[] {
    return (this.db.prepare("select * from machine order by name").all() as Row[]).map(machineOf);
  }

  /** The host keys the machine presents now, kept for the owner to compare. */
  seeHostKeys(name: string, lines: string[]): void {
    this.db
      .prepare("update machine set seen_host_keys = ? where name = ?")
      .run(JSON.stringify(lines), name);
  }

  /** The owner trusts the host keys they were shown: from now on only these connect. */
  trustHostKeys(name: string, lines: string[], by: string): void {
    this.db
      .prepare("update machine set host_keys = ? where name = ?")
      .run(JSON.stringify(lines), name);
    this.store.auditLog.add(by, "machine_host_key_trusted", { name, keys: lines.length });
  }

  /** What the last check found, or why it failed (keeping the facts before it). */
  setFacts(name: string, r: { facts: unknown } | { error: string }): void {
    if ("facts" in r)
      this.db
        .prepare("update machine set facts = ?, checked_at = ?, check_error = null where name = ?")
        .run(JSON.stringify(r.facts), new Date().toISOString(), name);
    else
      this.db
        .prepare("update machine set checked_at = ?, check_error = ? where name = ?")
        .run(new Date().toISOString(), redact(r.error), name);
  }

  /** The owner's yes to one install: one recipe's exact script on one machine, used once. */
  approveInstall(i: {
    machine: string;
    recipe: string;
    script_sha: string;
    by: string;
    ttlMs: number;
  }): number {
    const now = Date.now();
    const r = this.db
      .prepare(
        `insert into machine_install (machine, recipe, script_sha, approved_by, approved_at, expires_at)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        i.machine,
        i.recipe,
        i.script_sha,
        i.by,
        new Date(now).toISOString(),
        new Date(now + i.ttlMs).toISOString(),
      );
    this.store.auditLog.add(i.by, "machine_install_approved", {
      machine: i.machine,
      recipe: i.recipe,
      script_sha: i.script_sha,
    });
    return Number(r.lastInsertRowid);
  }

  /** Uses an approval: false when it was used already, has expired, or doesn't match. */
  startInstall(id: number, machine: string, recipe: string, scriptSha: string): boolean {
    const r = this.db
      .prepare(
        `update machine_install set started_at = ?
         where id = ? and machine = ? and recipe = ? and script_sha = ? and started_at is null and expires_at > ?`,
      )
      .run(new Date().toISOString(), id, machine, recipe, scriptSha, new Date().toISOString());
    return Number(r.changes) > 0;
  }

  finishInstall(id: number, ok: boolean, output: string): void {
    const r = this.db
      .prepare("update machine_install set finished_at = ?, ok = ?, output = ? where id = ?")
      .run(new Date().toISOString(), ok ? 1 : 0, output.slice(-4000), id);
    if (Number(r.changes)) {
      const row = this.db
        .prepare("select machine, recipe from machine_install where id = ?")
        .get(id) as Row;
      this.store.auditLog.add("control", "machine_install_finished", {
        machine: String(row.machine),
        recipe: String(row.recipe),
        ok,
      });
    }
  }

  /** A machine's installs, newest first. */
  installs(machine: string): {
    id: number;
    recipe: string;
    approved_by: string;
    approved_at: string;
    started_at: string | null;
    finished_at: string | null;
    ok: boolean | null;
    output: string | null;
  }[] {
    return (
      this.db
        .prepare("select * from machine_install where machine = ? order by id desc limit 20")
        .all(machine) as Row[]
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

  addRig(r: Omit<MachineRig, "created_at" | "status">): void {
    this.db
      .prepare(
        `insert into machine_rig (rig, machine, gpus, judge_gpus, images, root, status, created_at, created_by)
         values (?, ?, ?, ?, ?, ?, 'deploying', ?, ?)`,
      )
      .run(
        r.rig,
        r.machine,
        JSON.stringify(r.gpus),
        r.judge_gpus ?? null,
        JSON.stringify(r.images),
        r.root ? 1 : 0,
        new Date().toISOString(),
        r.created_by,
      );
    this.store.auditLog.add(r.created_by, "machine_rig_created", {
      rig: r.rig,
      machine: r.machine,
      gpus: r.gpus,
      images: r.images,
    });
  }

  rig(rig: string): MachineRig | undefined {
    const r = this.db.prepare("select * from machine_rig where rig = ?").get(rig) as
      | Row
      | undefined;
    return r ? machineRigOf(r) : undefined;
  }

  /** The rigs control set up, on one machine or all, removed ones last. */
  rigs(machine?: string): MachineRig[] {
    const rows = (
      machine
        ? this.db.prepare("select * from machine_rig where machine = ? order by rig").all(machine)
        : this.db.prepare("select * from machine_rig order by machine, rig").all()
    ) as Row[];
    return rows.map(machineRigOf);
  }

  setRigStatus(rig: string, status: string): void {
    this.db.prepare("update machine_rig set status = ? where rig = ?").run(status, rig);
  }

  /** The images a rig control set up on a machine runs now, after an update. */
  setRigImages(rig: string, images: MachineRig["images"]): void {
    this.db
      .prepare("update machine_rig set images = ? where rig = ?")
      .run(JSON.stringify(images), rig);
  }

  delete(name: string, by: string): boolean {
    const r = this.db.prepare("delete from machine where name = ?").run(name);
    if (Number(r.changes)) this.store.auditLog.add(by, "machine_deleted", { name });
    return Number(r.changes) > 0;
  }
}
