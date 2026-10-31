import type { SQLInputValue } from "node:sqlite";
import type { ReportedBuild } from "../../core/version.ts";
import { type Row, StorePart } from "./part.ts";

/**
 * The builds rigs and control run (goal 125, T6): each part of a rig's last reported build, and
 * each build control ran, since when.
 */

/** The two parts of a rig that report a build. */
export type RigComponent = "harness" | "supervisor";

/** A build a part of a rig reported, and since when control has seen it. */
export interface StoredBuild extends ReportedBuild {
  since: string;
}

export class Builds extends StorePart {
  /** The build a part of the rig last reported, and since when; undefined when it reported none. */
  ofRig(rig: string, component: RigComponent): StoredBuild | undefined {
    const r = this.db
      .prepare("select * from rig_build where rig = ? and component = ?")
      .get(rig, component) as Row | undefined;
    if (!r) return undefined;
    const num = (v: SQLInputValue | undefined) =>
      v === null || v === undefined ? null : Number(v);
    return {
      version: r.version === null ? null : String(r.version),
      commit: r.commit_sha === null ? null : String(r.commit_sha),
      protocol: num(r.protocol),
      oldest_protocol: num(r.oldest_protocol),
      since: String(r.since),
    };
  }

  /**
   * Records the build a part of the rig reports (null: it reports none). Written only when it
   * changes, so `since` is when control first saw it. True when it changed.
   */
  setRig(rig: string, component: RigComponent, b: ReportedBuild | null): boolean {
    const was = this.ofRig(rig, component);
    if (!b) {
      if (!was) return false;
      this.db.prepare("delete from rig_build where rig = ? and component = ?").run(rig, component);
      return true;
    }
    if (
      was &&
      was.version === b.version &&
      was.commit === b.commit &&
      was.protocol === b.protocol &&
      was.oldest_protocol === b.oldest_protocol
    )
      return false;
    this.db
      .prepare(
        `insert or replace into rig_build (rig, component, version, commit_sha, protocol,
           oldest_protocol, since) values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rig,
        component,
        b.version,
        b.commit,
        b.protocol,
        b.oldest_protocol,
        new Date().toISOString(),
      );
    return true;
  }

  /**
   * Notes the build control runs now, and returns since when control runs it: a build is kept from
   * the first time control ran it, so a restart on the same build keeps its time.
   */
  noteControl(b: { version: string; commit: string | null }): string {
    const last = this.db
      .prepare("select version, commit_sha, since from control_build order by rowid desc limit 1")
      .get() as Row | undefined;
    if (last && String(last.version) === b.version && (last.commit_sha ?? null) === b.commit)
      return String(last.since);
    const since = new Date().toISOString();
    this.db
      .prepare("insert into control_build (version, commit_sha, since) values (?, ?, ?)")
      .run(b.version, b.commit, since);
    return since;
  }

  /** Since when control runs the build it noted last (noteControlBuild); undefined: none noted. */
  controlSince(): string | undefined {
    const r = this.db
      .prepare("select since from control_build order by rowid desc limit 1")
      .get() as Row | undefined;
    return r ? String(r.since) : undefined;
  }
}
