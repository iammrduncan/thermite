import { ThermiteError } from "../errors.ts";
import { type PluginManifest, SEMVER_RE } from "./manifest.ts";
import breaksFile from "./plugin-breaks.json" with { type: "json" };

type RuleBase = { id: string; since: string; reason: string };
type RuleOpt = { pattern?: string; minThermite?: string; removedHook?: string };
export type PluginBreakRule = Readonly<RuleBase & RuleOpt>;
export type PluginBreaksFile = { version: string; breaks: readonly PluginBreakRule[] };
export type UnfitReason = { kind: "min_thermite" | "break_rule"; reason: string; ruleId?: string };
export const DEFAULT_PLUGIN_BREAKS: readonly PluginBreakRule[] = breaksFile.breaks;
type Rules = readonly PluginBreakRule[];

function parse(v: string): [number, number, number, string[]] {
  const m = SEMVER_RE.exec(v);
  if (!m) throw new ThermiteError("VALIDATION_ERROR", `Invalid semver "${v}"`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? m[4].split(".") : []];
}
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const [a0, a1, a2, ap] = parse(a);
  const [b0, b1, b2, bp] = parse(b);
  const core = a0 - b0 || a1 - b1 || a2 - b2;
  if (core) return core < 0 ? -1 : 1;
  if (!ap.length && !bp.length) return 0;
  if (!ap.length || !bp.length) return ap.length ? -1 : 1;
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const [ia, ib] = [ap[i], bp[i]];
    if (ia === ib) continue;
    if (ia === undefined || ib === undefined) return ia === undefined ? -1 : 1;
    const [na, nb] = [/^\d+$/.test(ia), /^\d+$/.test(ib)];
    if (na && nb) return Number(ia) < Number(ib) ? -1 : 1;
    return na || nb ? (na ? -1 : 1) : ia < ib ? -1 : 1;
  }
  return 0;
}
export function unfit(
  m: PluginManifest,
  code: string | null,
  ver: string,
  breaks: Rules = DEFAULT_PLUGIN_BREAKS,
): UnfitReason | null {
  const min = m.extensions["com.usethermite"].minThermite;
  if (compareSemver(min, ver) > 0)
    return { kind: "min_thermite", reason: `Needs >= ${min} (got ${ver})` };
  for (const r of breaks) {
    if (compareSemver(ver, r.since) < 0) continue;
    const byCode = r.pattern !== undefined && code !== null && new RegExp(r.pattern).test(code);
    const oldVer = r.pattern === undefined && compareSemver(min, r.minThermite ?? r.since) < 0;
    const hookHit =
      r.pattern === undefined && Boolean(r.removedHook && code?.includes(r.removedHook));
    if (byCode || oldVer || hookHit) return { kind: "break_rule", ruleId: r.id, reason: r.reason };
  }
  return null;
}
