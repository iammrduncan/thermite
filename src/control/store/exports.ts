import { canonicalJson } from "../../core/canonical.ts";
import { type Row, StorePart } from "./part.ts";

/**
 * The exports rigs send to control (goal 125, T6), with which of their files arrived (the files are
 * on disk: exports.ts).
 */

/** An export a rig sent to control (its files are on disk: exports.ts). */
export interface RigExport {
  rig: string;
  name: string;
  manifest: Record<string, unknown>;
  /** The files the rig sends: each one's size and SHA-256. */
  files: Record<string, { size: number; sha256: string }>;
  /** The files that arrived with their SHA-256. */
  done: string[];
  bytes: number;
  full: boolean;
  from_event: number;
  through_event: number;
  created_at: string;
  complete_at: string | null;
}

function rigExportOf(r: Row): RigExport {
  return {
    rig: String(r.rig),
    name: String(r.name),
    manifest: JSON.parse(String(r.manifest)) as Record<string, unknown>,
    files: JSON.parse(String(r.files)) as RigExport["files"],
    done: JSON.parse(String(r.done)) as string[],
    bytes: Number(r.bytes),
    full: Number(r.full) === 1,
    from_event: Number(r.from_event),
    through_event: Number(r.through_event),
    created_at: String(r.created_at),
    complete_at: r.complete_at === null ? null : String(r.complete_at),
  };
}

export class RigExports extends StorePart {
  /**
   * Starts an export a rig sends (or finds the one it started): "created", "same" when one by
   * that name has this manifest and these files, "different" when it has others.
   */
  begin(
    rig: string,
    name: string,
    e: {
      manifest: unknown;
      files: Record<string, { size: number; sha256: string }>;
      full: boolean;
      fromEvent: number;
      throughEvent: number;
    },
  ): "created" | "same" | "different" {
    const manifest = canonicalJson(e.manifest);
    const files = canonicalJson(e.files);
    const had = this.db
      .prepare("select manifest, files from rig_export where rig = ? and name = ?")
      .get(rig, name) as { manifest: string; files: string } | undefined;
    if (had) return had.manifest === manifest && had.files === files ? "same" : "different";
    const bytes = Object.values(e.files).reduce((n, f) => n + f.size, 0);
    this.db
      .prepare(
        `insert into rig_export (rig, name, manifest, files, bytes, full, from_event, through_event, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
  get(rig: string, name: string): RigExport | undefined {
    const r = this.db
      .prepare("select * from rig_export where rig = ? and name = ?")
      .get(rig, name) as Row | undefined;
    return r ? rigExportOf(r) : undefined;
  }

  /** The exports a rig sent to control, newest first. */
  ofRig(rig: string, limit = 100): RigExport[] {
    return (
      this.db
        .prepare(
          "select * from rig_export where rig = ? order by created_at desc, name desc limit ?",
        )
        .all(rig, limit) as Row[]
    ).map(rigExportOf);
  }

  /** The exports every rig sent to control, newest first (the Exports page, goal 103). */
  all(limit = 500): RigExport[] {
    return (
      this.db
        .prepare("select * from rig_export order by created_at desc, rig, name desc limit ?")
        .all(limit) as Row[]
    ).map(rigExportOf);
  }

  /** A file of an export arrived with its SHA-256; the export is complete with its last file. */
  fileDone(rig: string, name: string, path: string): { complete: boolean } {
    return this.tx(() => {
      const e = this.get(rig, name);
      if (!e) throw new Error(`no export ${name} of rig ${rig}`);
      const done = [...new Set([...e.done, path])].sort();
      const complete = Object.keys(e.files).every((p) => done.includes(p));
      this.db
        .prepare(
          "update rig_export set done = ?, complete_at = coalesce(complete_at, ?) where rig = ? and name = ?",
        )
        .run(JSON.stringify(done), complete ? new Date().toISOString() : null, rig, name);
      return { complete };
    });
  }
}
