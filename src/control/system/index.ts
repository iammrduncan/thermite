import type { Loops } from "../../common/health.ts";
import type { BuildInfo } from "../../core/version.ts";
import type { BusView } from "../bus/index.ts";
import type { ControlStore } from "../store/index.ts";
import type { RigView } from "../views/index.ts";
import { type BusFigures, BusFiguresLook, type FiguresAsker } from "./bus.ts";
import { type ControlFigures, ControlLook, type StorageFigures, storageFigures } from "./local.ts";
import { type RigFigures, rigFigures } from "./rigs.ts";

/**
 * The whole system as Metrics shows it (goal 179), and REST's `GET /v1/system` and MCP's
 * `system_state` give it: the message bus from its server's monitoring, with the events' sizes by
 * kind (bus.ts); control's process and where its state sits, in memory and on disk (local.ts);
 * each rig's parts as they report (rigs.ts). And the stream inspector, which reads a stream's
 * messages without a consumer (messages.ts).
 */

export {
  type BusFigures,
  BusFiguresLook,
  type BusStreamFigures,
  type FiguresAsker,
  type Traffic,
} from "./bus.ts";
export {
  type ControlFigures,
  ControlLook,
  type Place,
  type StorageFigures,
  storageFigures,
} from "./local.ts";
export {
  asText,
  inspectable,
  type MessagesPage,
  STREAM_LOOKUPS_MAX,
  type StreamMessage,
  streamMessage,
  streamPage,
  streamReader,
  subjectFilter,
} from "./messages.ts";
export { type RigFigures, rigFigures } from "./rigs.ts";

/** The parts of the system Metrics' tabs, REST and MCP ask for one at a time. */
export const SYSTEM_PARTS = ["bus", "control", "storage", "rigs"] as const;
export type SystemPart = (typeof SYSTEM_PARTS)[number];

interface SystemFiguresOptions {
  store: ControlStore;
  bus?: BusView | undefined;
  /** How control asks the bus's server for its figures; none: the bus tab says it can't. */
  look?: FiguresAsker | undefined;
  loops: Loops;
  build: BuildInfo;
  /** Control's own keys on the bus, in BusUsers.ownKeys' order: its user, its system user, the backup's. */
  ownKeys?: (() => readonly string[]) | undefined;
}

/** What the server's user keys are, in words: control's own, and each rig's. */
async function holders(store: ControlStore, own: readonly string[]): Promise<Map<string, string>> {
  const names = ["control", "control's system user", "the backup"];
  const m = new Map<string, string>();
  own.forEach((key, i) => {
    m.set(key, names[i] ?? "control");
  });
  for (const r of await store.busKeys.rigKeys()) m.set(r.key, `rig ${r.rig}`);
  return m;
}

/** The system's figures, made once with control's parts and shared by the page, REST and MCP. */
export class SystemFigures {
  private readonly o: SystemFiguresOptions;
  private readonly busLook: BusFiguresLook;
  private readonly controlLook: ControlLook;

  constructor(o: SystemFiguresOptions) {
    this.o = o;
    this.busLook = new BusFiguresLook({
      look: o.look,
      bus: o.bus,
      holders: async () => holders(o.store, o.ownKeys?.() ?? []),
    });
    this.controlLook = new ControlLook({ loops: o.loops, build: o.build });
  }

  bus(): Promise<BusFigures> {
    return this.busLook.read();
  }

  control(): ControlFigures {
    return this.controlLook.read();
  }

  async storage(): Promise<StorageFigures> {
    return storageFigures({
      store: this.o.store,
      bus: this.o.bus,
      control: this.control(),
      busFigures: await this.bus(),
    });
  }

  async rigs(views: readonly RigView[]): Promise<RigFigures[]> {
    return rigFigures(this.o.store, views);
  }

  /** The figures of one part, as REST and MCP give them. */
  async part(
    part: SystemPart,
    views: () => readonly RigView[] | Promise<readonly RigView[]>,
  ): Promise<unknown> {
    if (part === "bus") return this.bus();
    if (part === "control") return this.control();
    if (part === "storage") return this.storage();
    return this.rigs(await views());
  }
}
