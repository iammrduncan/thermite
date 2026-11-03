import type { DatabaseSync } from "node:sqlite";
import type { ReachEntry } from "../../core/reach.ts";
import { type Row, StorePart } from "./part.ts";

/**
 * The addresses cluster rigs' harnesses may reach beside the internet (core/reach.ts): the owner's
 * list, each address once with its TCP ports and note, and who set it when. The audit log keeps
 * each list as it was set.
 */

/** An entry as the store keeps it. */
export interface ReachableAddress extends ReachEntry {
  set_at: string;
  set_by: string;
}

/** The list's table (store migration 20). */
export function reachableAddressTable(db: DatabaseSync): void {
  db.exec(`create table if not exists reachable_address (
  address text primary key,
  ports text not null,
  note text not null default '',
  set_at text not null,
  set_by text not null
)`);
}

const entryOf = (r: Row): ReachableAddress => ({
  address: String(r.address),
  ports: JSON.parse(String(r.ports)) as number[],
  note: String(r.note),
  set_at: String(r.set_at),
  set_by: String(r.set_by),
});

export class ReachableAddresses extends StorePart {
  /** The list, by address. */
  list(): ReachableAddress[] {
    return (this.db.prepare("select * from reachable_address order by address").all() as Row[]).map(
      entryOf,
    );
  }

  /** The list as it is to be from now on, in place of the one before; an entry that stays keeps its time. */
  set(entries: ReachEntry[], by: string): void {
    const before = new Map(this.list().map((e) => [e.address, e]));
    const at = new Date().toISOString();
    this.tx(() => {
      this.db.exec("delete from reachable_address");
      const put = this.db.prepare(
        "insert into reachable_address (address, ports, note, set_at, set_by) values (?, ?, ?, ?, ?)",
      );
      for (const e of entries) {
        const was = before.get(e.address);
        const same = was && was.note === e.note && was.ports.join() === e.ports.join();
        put.run(
          e.address,
          JSON.stringify(e.ports),
          e.note,
          same ? was.set_at : at,
          same ? was.set_by : by,
        );
      }
      this.store.auditLog.add(by, "reachable_addresses_set", { addresses: entries });
    });
  }
}
