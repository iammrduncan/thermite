import { z } from "zod";
import { PLUGIN_SLUG_RE } from "../api/index.ts";
import { ThermiteError } from "../errors.ts";

const S1 = ["nav.item", "shell.corner", "run.header.action"] as const;
const S2 = ["run.inspector.tab", "knowledge.toolbar", "setup.section"] as const;
export const PLUGIN_UI_SLOTS = [...S1, ...S2] as const;
export type PluginUiSlot = (typeof PLUGIN_UI_SLOTS)[number];
export const PLUGIN_NAME_RE = PLUGIN_SLUG_RE;
export const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const s = z.string().min(1);
const optS = z.string().optional();
const optB = z.boolean().optional();
const slug = z.string().regex(PLUGIN_NAME_RE);
const ver = z.string().regex(SEMVER_RE);
const badPath = /^(?:[/\\]|[A-Za-z]:)|\0|(?:^|[/\\])\.\.(?:[/\\]|$)/;
const rel = s.refine((v) => !badPath.test(v)).optional();
const setting = z.object({ name: s, description: s, default: optS, secret: optB });
const need = z.union([s, z.object({ optional: optB, range: s.optional() })]);
const paths = { control: rel, runner: rel, page: rel, css: rel, migrations: rel };
const thermiteExt = z.object({
  minThermite: ver,
  ...paths,
  settings: z.array(setting).optional(),
  needs: z.record(slug, need).optional(),
  uiSlots: z.array(z.enum(PLUGIN_UI_SLOTS)).optional(),
});
const base = { name: slug, version: ver, description: s, license: s.optional() };
const ext = z.object({ "com.usethermite": thermiteExt }).passthrough();
export const PluginManifestSchema = z.object({ ...base, extensions: ext });
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export function pluginSchemaName(name: string): string {
  if (!PLUGIN_NAME_RE.test(name)) throw new ThermiteError("VALIDATION_ERROR", `Invalid "${name}"`);
  return `plugin_${name.replaceAll("-", "_")}`;
}
export function parsePluginManifest(raw: unknown): PluginManifest {
  const r = PluginManifestSchema.safeParse(raw);
  if (!r.success) throw new ThermiteError("VALIDATION_ERROR", "Invalid manifest", r.error.issues);
  return r.data;
}
