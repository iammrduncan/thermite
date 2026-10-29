import type { Bus } from "../../common/bus/index.ts";
import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import { COMMAND_STREAM, commandConsumerConfig } from "../../core/link/commands.ts";
import { CONFIG_STREAM, configConsumerConfig } from "../../core/link/config.ts";
import type { ControlStore } from "../store/index.ts";
import { busRigs } from "./users.ts";

/**
 * Each rig's two consumers on the message bus (goal 168): its commands and its config. Control
 * makes them, with their settings (core/link/commands.ts, core/link/config.ts), for every rig with
 * a user on the bus; the rig's user may only read them and take from them (core/link/users.ts).
 * Each round makes those of the rigs it has not made yet; every RIG_CONSUMERS_LOOK_AGAIN_MS it
 * looks at every rig's again, so one a stream lost is made again. A stream not made yet, or a
 * failure, is tried again at the next round.
 */

/** How often control looks again at the consumers it made. */
export const RIG_CONSUMERS_LOOK_AGAIN_MS = 60_000;

export interface RigConsumersOptions {
  store: ControlStore;
  bus: Pick<Bus, "makeConsumer">;
  clock?: (() => number) | undefined;
}

export class RigConsumers {
  private readonly o: RigConsumersOptions;
  private readonly made = new Set<string>();
  private lookedAt = 0;
  /** Why each rig's consumers were last not made, so that a failure is logged once until it changes. */
  private readonly told = new Map<string, string>();

  constructor(o: RigConsumersOptions) {
    this.o = o;
  }

  /** One round: the consumers of each rig with a user that it has not made yet. Never throws. */
  async make(): Promise<void> {
    const now = (this.o.clock ?? Date.now)();
    if (now - this.lookedAt >= RIG_CONSUMERS_LOOK_AGAIN_MS) {
      this.made.clear();
      this.lookedAt = now;
    }
    for (const { rig } of busRigs(this.o.store)) {
      if (this.made.has(rig)) continue;
      try {
        await this.o.bus.makeConsumer(COMMAND_STREAM, commandConsumerConfig(rig));
        await this.o.bus.makeConsumer(CONFIG_STREAM, configConsumerConfig(rig));
        this.made.add(rig);
        this.told.delete(rig);
      } catch (err) {
        const error = errorText(err);
        if (this.told.get(rig) !== error)
          log(
            "control",
            "a rig's consumers on the bus not made; trying again",
            { rig, error },
            "warn",
          );
        this.told.set(rig, error);
      }
    }
  }
}
