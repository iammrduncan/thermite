import type { ReachEntry } from "../../../core/reach.ts";
import { entryOf, type ReachableAddress, type ReachableAddresses } from "../reachable.ts";
import { PgPart, type Row } from "./part.ts";

/** ReachableAddresses on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresReachableAddresses extends PgPart implements ReachableAddresses {
  /** The list, by address. */
  async list(): Promise<ReachableAddress[]> {
    return ((await this.q.all("select * from reachable_address order by address")) as Row[]).map(
      entryOf,
    );
  }

  /** The list as it is to be from now on, in place of the one before; an entry that stays keeps its time. */
  async set(entries: ReachEntry[], by: string): Promise<void> {
    const before = new Map((await this.list()).map((e) => [e.address, e]));
    const at = new Date().toISOString();
    await this.tx(async () => {
      await this.q.exec("delete from reachable_address");
      const put =
        "insert into reachable_address (address, ports, note, set_at, set_by) values (?, ?, ?, ?, ?)";
      for (const e of entries) {
        const was = before.get(e.address);
        const same = was && was.note === e.note && was.ports.join() === e.ports.join();
        await this.q.run(
          put,
          e.address,
          JSON.stringify(e.ports),
          e.note,
          same ? was.set_at : at,
          same ? was.set_by : by,
        );
      }
      await this.store.auditLog.add(by, "reachable_addresses_set", { addresses: entries });
    });
  }
}
