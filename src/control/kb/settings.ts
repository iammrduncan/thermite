import { z } from "zod";
import type { ControlStore } from "../store/index.ts";

/**
 * The knowledge base's settings on control (goal 175), the same on Settings › Knowledge base, REST
 * (`GET` and `PUT /v1/kb/settings`), MCP (`kb_settings`, `set_kb_settings`) and `thermite kb
 * settings`: the largest file it takes, none by default, and how long a file no item names stays,
 * by default THERMITE_CONTROL_KB_ORPHAN_HOURS. Each change is audited.
 */

/** What each setting is, for its ⓘ and the tools' descriptions. */
export const KB_SETTING_WORDS = {
  max_file_mib:
    "The largest file the knowledge base takes, in MiB. A file over it is refused in words, as a refused write, and control keeps none of its bytes. Empty or 0: no limit, the default.",
  orphan_hours:
    "How many hours control keeps a file no item names (its item never arrived, or was refused), counted from when control kept it; then control removes it. 0: every file is kept. Empty: THERMITE_CONTROL_KB_ORPHAN_HOURS, control's environment setting.",
} as const;

/** A change of the settings: each one given changes; null puts it back to its default. */
export const KbSettingsBody = z
  .strictObject({
    max_file_mib: z
      .number()
      .finite()
      .min(0)
      .nullable()
      .optional()
      .describe(KB_SETTING_WORDS.max_file_mib),
    orphan_hours: z
      .number()
      .finite()
      .min(0)
      .nullable()
      .optional()
      .describe(KB_SETTING_WORDS.orphan_hours),
  })
  .refine((b) => b.max_file_mib !== undefined || b.orphan_hours !== undefined, {
    message: "give max_file_mib, orphan_hours or both",
  });
export type KbSettingsBody = z.infer<typeof KbSettingsBody>;

/** The settings as they are now, with where each comes from and who last set one, and when. */
export interface KbSettings {
  /** 0: no limit. */
  max_file_mib: number;
  /** 0: every file is kept. */
  orphan_hours: number;
  /** "setting": the owner set it on control; "environment": THERMITE_CONTROL_KB_ORPHAN_HOURS. */
  orphan_hours_from: "setting" | "environment";
  /** The environment's value, which an empty setting goes back to. */
  orphan_hours_default: number;
  set_by: string | null;
  set_at: string | null;
}

/** The settings now; `orphanHoursDefault`: THERMITE_CONTROL_KB_ORPHAN_HOURS as control read it. */
export function kbSettingsOf(store: ControlStore, orphanHoursDefault = 0): KbSettings {
  const rows = store.kb().settings;
  const max = rows.get("max_file_mib");
  const hours = rows.get("orphan_hours");
  const last = [max, hours]
    .filter((r) => r !== undefined)
    .sort((a, b) => b.set_at.localeCompare(a.set_at))[0];
  return {
    max_file_mib: max?.value ?? 0,
    orphan_hours: hours?.value ?? orphanHoursDefault,
    orphan_hours_from: hours ? "setting" : "environment",
    orphan_hours_default: orphanHoursDefault,
    set_by: last?.set_by ?? null,
    set_at: last?.set_at ?? null,
  };
}

/** A number in words, with no more than 2 decimals. */
const num = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** The settings in words, as each surface says what a change did. */
export function kbSettingsWords(s: KbSettings): string {
  const size = s.max_file_mib > 0 ? `files up to ${num(s.max_file_mib)} MiB` : "files of any size";
  const orphans =
    s.orphan_hours > 0
      ? `a file no item names is removed after ${num(s.orphan_hours)} hours`
      : "every file is kept";
  const from = s.orphan_hours_from === "environment" ? " (THERMITE_CONTROL_KB_ORPHAN_HOURS)" : "";
  return `The knowledge base takes ${size}; ${orphans}${from}.`;
}

/** What a change did: the settings now and the words, or why it was refused. */
export type KbSettingsOutcome =
  | { ok: true; settings: KbSettings; said: string }
  | { ok: false; error: string };

/** A change of the settings by `by`, checked, kept and audited; refused in words. */
export function setKbSettings(
  store: ControlStore,
  raw: unknown,
  orphanHoursDefault: number,
  by: string,
): KbSettingsOutcome {
  const r = KbSettingsBody.safeParse(raw);
  if (!r.success)
    return {
      ok: false,
      error: r.error.issues
        .map((i) => `${i.path.join(".") || "settings"}: ${i.message}`)
        .join("; "),
    };
  const rows = store.kb().settings;
  const b = r.data;
  store.tx(() => {
    // Empty or 0 is no limit: the default, so no row is kept for it.
    if (b.max_file_mib !== undefined) rows.set("max_file_mib", b.max_file_mib || null, by);
    if (b.orphan_hours !== undefined) rows.set("orphan_hours", b.orphan_hours, by);
    store.auditLog.add(by, "kb_settings_set", b);
  });
  const settings = kbSettingsOf(store, orphanHoursDefault);
  return { ok: true, settings, said: kbSettingsWords(settings) };
}

/** Why a file over the largest the knowledge base takes is refused, in words. */
export function overLimitWords(file: { name?: string; bytes: number }, limitBytes: number): string {
  const what = file.name ? `the file ${file.name}` : "the file";
  return `${what} has ${file.bytes.toLocaleString("en-US")} bytes: over the knowledge base's limit of ${num(limitBytes / 1024 ** 2)} MiB (${limitBytes.toLocaleString("en-US")} bytes), set on control`;
}
