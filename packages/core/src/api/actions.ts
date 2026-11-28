import { z } from "zod";
import type { CoreCapability } from "../policy/index.ts";
import { type ActionDef, type ActionScope, defineAction, type HttpMethod } from "./types.ts";

const s = z.string();
const id = s.min(1);
const opt = s.optional();
const b = z.boolean();
const ob = b.optional();
const ss = z.array(s);
const oss = ss.optional();
const rec = z.record(s, z.unknown());
const uInt = z.number().int().nonnegative().optional();
const lim = z.number().int().min(1).max(200).optional();
const kbLim = z.number().int().min(1).max(100).default(10);
const ttl = z.number().int().min(60).max(86400).optional();
const o = z.object;
const lit = z.literal;
const e = z.enum;
const arr = z.array;
const Mode = e(["hill_climb", "goal", "research"]);
const RunSt = e(["running", "paused", "completed", "closed"]);
const MachSt = e(["online", "draining", "offline", "retired"]);
const Res = e(["approve", "decline", "override", "resume", "dismiss"]);
const Prin = e(["owner_session", "delegated_agent", "operator_token", "ci_token"]);
const Prof = e(["viewer", "operator", "autonomous_delegate", "owner"]);
const KbKind = e(["campaign", "shared"]);
const NeedSt = e(["open", "resolved"]);
const ItemKind = e(["note", "finding", "source", "transcript"]).default("note");
const aBase = { attemptId: s, runId: s };
const wall = { wallPlugin: id, wallVersion: id };
const Run = o({ runId: s, campaignId: s, mode: Mode, status: RunSt, live: b, createdAt: s });
const Att = o({ ...aBase, laneId: s, commitRef: s, summary: s, status: s, promoted: b });
const Need = o({ needId: s, runId: s, kind: s, summary: s, status: NeedSt });
const Dev = o({ id, kind: id, name: id, memoryBytes: uInt, capabilities: oss });
const devs = arr(Dev);
const Mach = o({ machineId: s, name: s, status: MachSt, ...wall, wallPassed: b, devices: devs });
const KbCol = o({ collectionId: s, name: s, kind: KbKind, campaignId: opt, description: opt });
const KbHit = o({ itemId: s, collectionId: s, title: s, snippet: s, score: z.number(), kind: s });
const Scope = o({ campaignIds: oss, runIds: oss });
const oScope = Scope.optional();
const gBase = { id: s, label: s, principalKind: Prin, capabilities: ss };
const Grant = o({ ...gBase, scope: oScope, grantedBy: s, expiresAt: opt, revoked: ob });
const Plug = o({ name: s, version: s, description: s, enabled: b });
const vI = o({ yaml: id, repoUrl: opt });
const vO = o({ valid: b, errors: ss, warnings: ss });
const dI = o({ yaml: id, machineIds: oss });
const dO = o({ valid: b, mode: Mode, planSummary: s, matchedMachines: ss, warnings: ss });
const cI = o({ name: id, yaml: id, repoUrl: opt });
const cO = o({ campaignId: s, name: s, mode: Mode, createdAt: s });
const rlI = o({ campaignId: opt, status: RunSt.optional(), limit: lim });
const rO = Run.extend({ config: rec, championAttemptId: opt });
const stI = o({ campaignId: id, live: ob, configOverrides: rec.optional() });
const stO = o({ runId: s, campaignId: s, status: RunSt });
const rWhy = o({ runId: id, reason: opt });
const rSt = o({ runId: s, status: RunSt });
const rCl = o({ runId: s, status: lit("closed") });
const cfI = o({ runId: id, patch: rec });
const cfO = o({ runId: s, config: rec });
const alI = o({ runId: id, limit: lim });
const alO = o({ attempts: arr(Att) });
const aW = o({ runId: id, attemptId: id, reason: id });
const rjO = o({ ...aBase, jobId: s });
const iv = o({ ...aBase, invalidated: lit(true) });
const pmI = o({ runId: id, attemptId: id, note: opt });
const pmO = o({ ...aBase, promoted: lit(true) });
const nlI = o({ runId: opt, status: NeedSt.optional() });
const nlO = o({ needs: arr(Need) });
const nrI = o({ needId: id, runId: opt, resolution: Res, note: opt });
const nrO = o({ needId: s, resolution: Res, resolvedAt: s });
const mlI = o({ status: MachSt.optional() });
const mlO = o({ machines: arr(Mach) });
const mId = o({ machineId: id });
const mWhy = o({ machineId: id, reason: opt });
const mtI = o({ label: id, ttlSeconds: ttl });
const mtO = o({ tokenId: s, token: s, expiresAt: s });
const enI = o({ token: id, publicKey: id, name: id, ...wall, devices: devs });
const enO = o({ machineId: s, natsUrl: s, status: MachSt });
const drO = o({ machineId: s, status: lit("draining") });
const rtO = o({ machineId: s, status: lit("retired") });
const kcI = o({ kind: KbKind.optional(), campaignId: opt });
const kcO = o({ collections: arr(KbCol) });
const knI = KbCol.omit({ collectionId: true }).extend({ name: id });
const kbMeta = { collectionIds: oss, campaignId: opt, runId: opt };
const ksI = o({ query: id, ...kbMeta, include_transcripts: b.default(false), limit: kbLim });
const ksO = o({ hits: arr(KbHit) });
const itemMeta = { kind: ItemKind, campaignId: opt, tags: oss };
const kiI = o({ collectionId: id, title: id, content: s, ...itemMeta });
const kiO = o({ itemId: s, versionId: s, collectionId: s });
const setI = o({ section: opt });
const upI = o({ patch: rec });
const setO = o({ settings: rec });
const tlI = o({ includeRevoked: ob });
const tlO = o({ grants: arr(Grant) });
const tOpt = { profile: Prof.optional(), capabilities: arr(id).optional(), scope: oScope };
const tnI = o({ label: id, principalKind: Prin, ...tOpt, expiresAt: opt });
const tnO = o({ grant: Grant, token: s });
const trI = o({ grantId: id });
const trO = o({ grantId: s, revoked: lit(true) });
const plO = o({ plugins: arr(Plug) });
const paI = o({ source: id, settings: z.record(s, s).optional() });
const paO = o({ name: s, version: s, installed: lit(true) });
const pdI = o({ pluginName: id });
const pdO = o({ name: s, uninstalled: lit(true) });
const tmI = o({ runId: id, laneId: opt, data: id });
const tmO = o({ runId: s, accepted: lit(true) });

type Cap = Exclude<CoreCapability, "*">;
type Spec = `${HttpMethod} /${string}|${Cap}|${string}`;
type Extra = Pick<ActionDef, "idempotent" | "mcp" | "cli">;

function autoScope(input: unknown): ActionScope {
  if (!input || typeof input !== "object") return {};
  const { campaignId: c, runId: r } = input as { campaignId?: unknown; runId?: unknown };
  return {
    ...(typeof c === "string" && c ? { campaignId: c } : {}),
    ...(typeof r === "string" && r ? { runId: r } : {}),
  };
}

const mk =
  (extra?: Extra) =>
  <const N extends string, I extends z.ZodType, O extends z.ZodType>(
    name: N,
    spec: Spec,
    input: I,
    output: O,
  ): ActionDef<N, I, O> => {
    const [route, capability, summary] = spec.split("|") as [string, Cap, string];
    const sp = route.indexOf(" ");
    const http = { method: route.slice(0, sp) as HttpMethod, path: `/v1${route.slice(sp + 1)}` };
    const base = { name, summary, capability, http, input, output, extractScope: autoScope };
    return defineAction({ ...base, ...extra });
  };

const act = mk();
const ro = mk({ idempotent: true, mcp: { readOnly: true } });
const idem = mk({ idempotent: true });
const ds = mk({ idempotent: true, mcp: { destructive: true } });
const tok = mk({ cli: { path: "thermite machine token" } });
const CP = "/campaigns/:campaignId" as const;
const AP = "/runs/:runId/attempts/:attemptId" as const;
const MP = "/machines/:machineId" as const;
const KP = "/kb/collections/:collectionId" as const;
const PP = "/plugins/:pluginName" as const;

export const CORE_ACTIONS = [
  ro("campaigns.validate", "POST /campaigns/validate|runs:read|Validate campaign yaml.", vI, vO),
  ro("campaigns.dry_run", "POST /campaigns/dry-run|runs:read|Dry-run campaign plan.", dI, dO),
  act("campaigns.create", "POST /campaigns|runs:write|Create a campaign.", cI, cO),
  ro("runs.list", "GET /runs|runs:read|List campaign runs.", rlI, o({ runs: arr(Run) })),
  ro("runs.get", "GET /runs/:runId|runs:read|Get run details and config.", o({ runId: id }), rO),
  act("runs.start", `POST ${CP}/runs|runs:write|Start a campaign run.`, stI, stO),
  idem("runs.pause", "POST /runs/:runId/pause|runs:write|Pause an active run.", rWhy, rSt),
  idem("runs.resume", "POST /runs/:runId/resume|runs:write|Resume a paused run.", rWhy, rSt),
  ds("runs.close", "POST /runs/:runId/close|runs:close|Permanently close a run.", rWhy, rCl),
  idem("runs.update_config", "PATCH /runs/:runId/config|runs:write|Patch run config.", cfI, cfO),
  ro("attempts.list", "GET /runs/:runId/attempts|runs:read|List run attempts.", alI, alO),
  act("attempts.rejudge", `POST ${AP}/rejudge|attempts:rejudge|Rejudge an attempt.`, aW, rjO),
  ds(
    "attempts.invalidate",
    `POST ${AP}/invalidate|attempts:invalidate|Invalidate verdict.`,
    aW,
    iv,
  ),
  act("promotions.approve", `POST ${AP}/promote|promotions:approve|Approve promotion.`, pmI, pmO),
  ro("needs.list", "GET /needs|runs:read|List open or resolved needs.", nlI, nlO),
  idem("needs.resolve", "POST /needs/:needId/resolve|needs:resolve|Resolve open need.", nrI, nrO),
  ro("machines.list", "GET /machines|compute:read|List enrolled machines.", mlI, mlO),
  ro("machines.get", `GET ${MP}|compute:read|Get machine details.`, mId, Mach),
  tok("machines.token_create", "POST /machines/tokens|compute:manage|Mint join token.", mtI, mtO),
  act("machines.enroll", "POST /machines/enroll|compute:manage|Enroll machine runner.", enI, enO),
  idem("machines.drain", `POST ${MP}/drain|compute:manage|Drain compute machine.`, mWhy, drO),
  ds("machines.retire", `DELETE ${MP}|compute:manage|Retire compute machine.`, mWhy, rtO),
  ro("kb.collections_list", "GET /kb/collections|runs:read|List KB collections.", kcI, kcO),
  act("kb.collection_create", "POST /kb/collections|runs:write|Create KB collection.", knI, KbCol),
  ro("kb.search", "POST /kb/search|runs:read|Search knowledge collections.", ksI, ksO),
  act("kb.item_write", `POST ${KP}/items|runs:write|Write knowledge item.`, kiI, kiO),
  ro("settings.get", "GET /settings|settings:read|Read control settings.", setI, setO),
  idem("settings.update", "PATCH /settings|settings:write|Update control settings.", upI, setO),
  ro("tokens.list", "GET /tokens|tokens:manage|List policy grants.", tlI, tlO),
  act("tokens.create", "POST /tokens|tokens:manage|Mint policy grant token.", tnI, tnO),
  ds("tokens.revoke", "DELETE /tokens/:grantId|tokens:manage|Revoke policy grant.", trI, trO),
  ro("plugins.list", "GET /plugins|settings:read|List installed plugins.", o({}), plO),
  act("plugins.install", "POST /plugins/install|plugins:manage|Install plugin package.", paI, paO),
  ds("plugins.uninstall", `DELETE ${PP}|plugins:manage|Uninstall plugin package.`, pdI, pdO),
  act("terminal.input", "POST /runs/:runId/terminal|terminal:input|Send terminal input.", tmI, tmO),
] as const;

export type CoreActionDef = (typeof CORE_ACTIONS)[number];
export type CoreActionName = CoreActionDef["name"];
export type ActionByName<K extends CoreActionName> = Extract<CoreActionDef, { readonly name: K }>;
export type InputOf<K extends CoreActionName> = z.input<ActionByName<K>["input"]>;
export type OutputOf<K extends CoreActionName> = z.output<ActionByName<K>["output"]>;
export type AnyActionDef = ActionDef<string, z.ZodType, z.ZodType>;
export const CORE_ACTIONS_BY_NAME: ReadonlyMap<CoreActionName, CoreActionDef> = new Map(
  CORE_ACTIONS.map((d) => [d.name, d]),
);
export function getCoreAction<K extends CoreActionName>(name: K): ActionByName<K> {
  const found = CORE_ACTIONS_BY_NAME.get(name);
  if (!found) throw new Error(`Unknown core action: ${name}`);
  return found as ActionByName<K>;
}
