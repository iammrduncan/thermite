import type { ReportedBuild } from "../../../core/version.ts";
import type { Builds, RigComponent, StoredBuild } from "../builds.ts";
import { PgPart, type Row } from "./part.ts";

/** Builds on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresBuilds extends PgPart implements Builds {
  /** The build a part of the rig last reported, and since when; undefined when it reported none. */
  async ofRig(rig: string, component: RigComponent): Promise<StoredBuild | undefined> {
    const r = (await this.q.get(
      "select * from rig_build where rig = ? and component = ?",
      rig,
      component,
    )) as Row | undefined;
    if (!r) return undefined;
    const num = (v: unknown | undefined) => (v === null || v === undefined ? null : Number(v));
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
  async setRig(rig: string, component: RigComponent, b: ReportedBuild | null): Promise<boolean> {
    const was = await this.ofRig(rig, component);
    if (!b) {
      if (!was) return false;
      await this.q.run("delete from rig_build where rig = ? and component = ?", rig, component);
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
    await this.q.run(
      `insert into rig_build (rig, component, version, commit_sha, protocol,
           oldest_protocol, since) values (?, ?, ?, ?, ?, ?, ?)
         on conflict (rig, component) do update set version = excluded.version,
           commit_sha = excluded.commit_sha, protocol = excluded.protocol,
           oldest_protocol = excluded.oldest_protocol, since = excluded.since`,
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
  async noteControl(b: { version: string; commit: string | null }): Promise<string> {
    const last = (await this.q.get(
      "select version, commit_sha, since from control_build order by rowid desc limit 1",
    )) as Row | undefined;
    if (last && String(last.version) === b.version && (last.commit_sha ?? null) === b.commit)
      return String(last.since);
    const since = new Date().toISOString();
    await this.q.run(
      "insert into control_build (version, commit_sha, since) values (?, ?, ?)",
      b.version,
      b.commit,
      since,
    );
    return since;
  }

  /** Since when control runs the build it noted last (noteControlBuild); undefined: none noted. */
  async controlSince(): Promise<string | undefined> {
    const r = (await this.q.get("select since from control_build order by rowid desc limit 1")) as
      | Row
      | undefined;
    return r ? String(r.since) : undefined;
  }
}
