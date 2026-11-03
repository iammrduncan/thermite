import { readFileSync, writeFileSync } from "node:fs";
import {
  type BackupBus,
  messageDigest,
  StreamApiError,
  type StreamEnd,
  type StreamSnapshot,
} from "../../src/common/backup/index.ts";
import type { StreamSettings } from "../../src/common/bus/index.ts";
import type { FakeBus, Kept } from "./fake-bus.ts";

/**
 * The backup's side of the fake bus (common/backup/streams.ts speaks to a real server): a stream's
 * state and a message's digest from the fake's messages, a snapshot written as their JSON, and a
 * restore that makes the stream from it, refused where the bus has one of that name, as the server
 * refuses it. `stopAfter` stands for a server stopped part way through a restore: it keeps the
 * stream's first messages, which look whole, and the restore fails.
 */
export class FakeBackupBus implements BackupBus {
  readonly bus: FakeBus;
  /** Set: a restore keeps this many messages, then fails as a server stopped part way. */
  stopAfter: number | undefined;
  closed = false;

  constructor(bus: FakeBus) {
    this.bus = bus;
  }

  async state(stream: string): Promise<StreamEnd | undefined> {
    const copy = this.bus.streamCopy(stream);
    if (!copy) return undefined;
    const m = copy.messages;
    const bytes = m.reduce((n, k) => n + Buffer.byteLength(k.data), 0);
    return { messages: m.length, first_seq: m[0]?.seq ?? 0, last_seq: m.at(-1)?.seq ?? 0, bytes };
  }

  async messageSha256(stream: string, seq: number): Promise<string | undefined> {
    const m = this.bus.streamCopy(stream)?.messages.find((k) => k.seq === seq);
    return m ? messageDigest(m.subject, new TextEncoder().encode(m.data)) : undefined;
  }

  async snapshot(stream: string, file: string): Promise<StreamSnapshot> {
    const copy = this.bus.streamCopy(stream);
    if (!copy) throw new StreamApiError({ err_code: 10059, description: "stream not found" });
    writeFileSync(file, JSON.stringify(copy), { flag: "wx", mode: 0o600 });
    const end = (await this.state(stream)) as StreamEnd;
    return { ...end, config: copy.settings as unknown as Record<string, unknown> };
  }

  async restore(stream: string, file: string): Promise<void> {
    if (this.bus.made.has(stream))
      throw new StreamApiError({ err_code: 10058, description: "stream name already in use" });
    const copy = JSON.parse(readFileSync(file, "utf8")) as {
      settings: StreamSettings;
      messages: Kept[];
    };
    const kept =
      this.stopAfter === undefined ? copy.messages : copy.messages.slice(0, this.stopAfter);
    this.bus.putStream(copy.settings, kept);
    if (this.stopAfter !== undefined) throw new Error("connection closed");
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
