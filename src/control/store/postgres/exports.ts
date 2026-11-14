import { canonicalJson } from "../../../core/canonical.ts";
import { type RigExport, type RigExports, rigExportOf } from "../exports.ts";
import { PgPart, type Row } from "./part.ts";

/** RigExports on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresRigExports extends PgPart implements RigExports {
  /**
   * Starts an export a rig sends (or finds the one it started): "created", "same" when one by
   * that name has this manifest and these files, "different" when it has others.
   */
  async begin(
    rig: string,
    name: string,
    e: {
      manifest: unknown;
      files: Record<string, { size: number; sha256: string }>;
      full: boolean;
      fromEvent: number;
      throughEvent: number;
    },
  ): Promise<"created" | "same" | "different"> {
    const manifest = canonicalJson(e.manifest);
    const files = canonicalJson(e.files);
    const had = (await this.q.get(
      "select manifest, files from rig_export where rig = ? and name = ?",
      rig,
      name,
    )) as { manifest: string; files: string } | undefined;
    if (had) return had.manifest === manifest && had.files === files ? "same" : "different";
    const bytes = Object.values(e.files).reduce((n, f) => n + f.size, 0);
    await this.q.run(
      `insert into rig_export (rig, name, manifest, files, bytes, "full", from_event, through_event, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rig,
      name,
      manifest,
      files,
      bytes,
      e.full ? 1 : 0,
      e.fromEvent,
      e.throughEvent,
      new Date().toISOString(),
    );
    return "created";
  }

  /** One export a rig sent to control, with which files arrived. */
  async get(rig: string, name: string): Promise<RigExport | undefined> {
    const r = (await this.q.get(
      "select * from rig_export where rig = ? and name = ?",
      rig,
      name,
    )) as Row | undefined;
    return r ? rigExportOf(r) : undefined;
  }

  /** The exports a rig sent to control, newest first. */
  async ofRig(rig: string, limit = 100): Promise<RigExport[]> {
    return (
      (await this.q.all(
        "select * from rig_export where rig = ? order by created_at desc, name desc limit ?",
        rig,
        limit,
      )) as Row[]
    ).map(rigExportOf);
  }

  /** The exports every rig sent to control, newest first (the Exports page, goal 103). */
  async all(limit = 500): Promise<RigExport[]> {
    return (
      (await this.q.all(
        "select * from rig_export order by created_at desc, rig, name desc limit ?",
        limit,
      )) as Row[]
    ).map(rigExportOf);
  }

  /** Forgets an export (control/exports.ts deletes its files first): whether there was one. */
  async remove(rig: string, name: string): Promise<boolean> {
    const r = await this.q.run("delete from rig_export where rig = ? and name = ?", rig, name);
    return Number(r.changes) > 0;
  }

  /** A file of an export arrived with its SHA-256; the export is complete with its last file. */
  async fileDone(rig: string, name: string, path: string): Promise<{ complete: boolean }> {
    return await this.tx(async () => {
      const e = await this.get(rig, name);
      if (!e) throw new Error(`no export ${name} of rig ${rig}`);
      const done = [...new Set([...e.done, path])].sort();
      const complete = Object.keys(e.files).every((p) => done.includes(p));
      await this.q.run(
        "update rig_export set done = ?, complete_at = coalesce(complete_at, ?) where rig = ? and name = ?",
        JSON.stringify(done),
        complete ? new Date().toISOString() : null,
        rig,
        name,
      );
      return { complete };
    });
  }
}
