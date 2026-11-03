import type { Bus, BusMessage, Handled } from "../../common/bus/index.ts";
import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import { type ConfigFigures, FIGURE_CONFIG_SUBJECTS } from "../../core/api/control/rigs.ts";
import {
  CONFIG_STREAM,
  type ConfigKey,
  type ConfigValue,
  configConsumerName,
  configSubjects,
  readConfig,
} from "../../core/link/config.ts";

/**
 * The rig's config from the message bus (goal 168, step 3). The supervisor watches its rig's keys
 * in the config bucket: the latest value of each when it starts, then each new one as control
 * writes it. It opens each with the rig's seal key, checks it, keeps it in memory, and applies it
 * at once. A message it can't take is counted and passed over, and the value it knows stays
 * (owner's decision 6); while the bus is away, it keeps what it knows.
 */

/** What the supervisor knows of its rig's config: the latest value of each key, in memory only. */
export class RigConfig {
  private readonly values = new Map<ConfigKey, { revision: string; value: unknown }>();

  /** A key's value, or undefined before the bus gave one. */
  get<K extends ConfigKey>(key: K): ConfigValue<K> | undefined {
    return this.values.get(key)?.value as ConfigValue<K> | undefined;
  }

  revision(key: ConfigKey): string | undefined {
    return this.values.get(key)?.revision;
  }

  /** Keeps a key's value; false when it held this revision already. */
  set(key: ConfigKey, revision: string, value: unknown): boolean {
    if (this.values.get(key)?.revision === revision) return false;
    this.values.set(key, { revision, value });
    return true;
  }
}

/** The config updates taken from the bus and refused there, by subject: the figures' `config`. */
export class ConfigCounts {
  private readonly total = { taken: 0, refused: 0 };
  private readonly subjects = new Map<string, { taken: number; refused: number }>();

  add(subject: string, what: "taken" | "refused"): void {
    this.total[what]++;
    const row = this.subjects.get(subject) ?? { taken: 0, refused: 0 };
    row[what]++;
    // A subject past the most counted by name is counted in the totals alone.
    if (this.subjects.has(subject) || this.subjects.size < FIGURE_CONFIG_SUBJECTS)
      this.subjects.set(subject, row);
  }

  figures(): ConfigFigures {
    return { ...this.total, subjects: Object.fromEntries(this.subjects) };
  }
}

/** What watching the rig's config needs. */
export interface ConfigWatch {
  rig: string;
  /** The rig's seal key's private part (PEM), which opens its values. */
  sealKey: string;
  known: RigConfig;
  counts: ConfigCounts;
  /** Applies a key's value just taken, at once: to the harness, or to the advisors. */
  apply: (key: ConfigKey) => Promise<void>;
}

/** Why each subject was last refused, so it is logged once until the why changes. */
const told = new Map<string, string>();

/**
 * One message from the rig's consumer. A value taken is kept and applied; one held already (the
 * same revision, as when watching starts again) is passed over. A value that can't be applied now
 * (the harness away) stays known, and the supervisor hands it over at its next look. Each message
 * is acked: the next value of a key replaces it.
 */
export async function takeConfig(w: ConfigWatch, m: BusMessage): Promise<Handled> {
  const read = readConfig(w.rig, m.subject, m.data, w.sealKey);
  if ("refused" in read) {
    w.counts.add(m.subject, "refused");
    const why = { subject: m.subject, seq: m.seq, why: read.refused, error: read.error };
    if (told.get(m.subject) !== read.refused) {
      told.set(m.subject, read.refused);
      log(
        "supervisor",
        "a config message from the bus refused; the value known stays",
        why,
        "warn",
      );
    }
    return undefined;
  }
  told.delete(m.subject);
  if (!w.known.set(read.key, read.revision, read.value)) return undefined;
  w.counts.add(m.subject, "taken");
  const what = { key: read.key, revision: read.revision, written_at: read.writtenAt, seq: m.seq };
  log("supervisor", "config taken from the bus", what);
  try {
    await w.apply(read.key);
  } catch (err) {
    const error = errorText(err).slice(0, 300);
    log(
      "supervisor",
      "config not applied yet; tried again at the next look",
      { ...what, error },
      "warn",
    );
  }
  return undefined;
}

/**
 * Watches the rig's keys until the bus is closed: the latest value of each, read by its subject,
 * then each new one from the rig's consumer. The stream and the consumer are control's, and are
 * waited for.
 */
export async function followConfig(bus: Pick<Bus, "watch">, w: ConfigWatch): Promise<void> {
  await bus.watch(CONFIG_STREAM, configConsumerName(w.rig), configSubjects(w.rig), (m) =>
    takeConfig(w, m),
  );
}
