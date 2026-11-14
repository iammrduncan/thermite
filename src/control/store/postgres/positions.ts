import type { BusPositions } from "../positions.ts";
import { PgPart } from "./part.ts";

/** BusPositions on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresBusPositions extends PgPart implements BusPositions {
  /** The place in the stream control's store applied through: 0 before its first message. */
  async of(stream: string): Promise<number> {
    const r = (await this.q.get("select seq from bus_position where stream = ?", stream)) as
      | { seq: number }
      | undefined;
    return Number(r?.seq ?? 0);
  }

  /** The place control's store applied through now, in the transaction of what it applied. */
  async set(stream: string, seq: number): Promise<void> {
    await this.q.run(
      "insert into bus_position (stream, seq) values (?, ?) on conflict (stream) do update set seq = excluded.seq",
      stream,
      seq,
    );
  }
}
