import type * as A from "../api/index.ts";
import { assertPluginCapability } from "../api/index.ts";
import { ThermiteError, type ThermiteErrorCode } from "../errors.ts";
import type { DomainEvent } from "../machine/index.ts";
import type { PolicyGrant } from "../policy/index.ts";
import { compareSemver, DEFAULT_PLUGIN_BREAKS, type PluginBreakRule, unfit } from "./fit.ts";
import type { HarnessPlugin } from "./harness.ts";
import type * as K from "./kb.ts";
import { type PluginManifest, parsePluginManifest, SEMVER_RE } from "./manifest.ts";
import type * as T from "./types.ts";
import type * as W from "./wall.ts";

type G = PolicyGrant | null;
type WT = W.WallSelfTestTargets;
type Ok = { ok: boolean };
type Proof<V, R> = { value: V; verified: boolean; report: R | null };
type PM<V, R> = Map<string, Proof<V, R>>;
type Ep<H> = { pluginName: string; method?: string; path: string; fullPath: string; handler: H };
type EvFn = (ev: DomainEvent) => void | Promise<void>;
type Cleanup = () => void | Promise<void>;
type L1 = { manifest: PluginManifest; controller: AbortController };
type L2 = { api: Record<string, unknown> | null; cleanup: Cleanup | null; undo: (() => void)[] };
type Loaded = L1 & L2;
type CallFn = <N extends A.CoreActionName>(n: N, i: A.InputOf<N>, g: G) => Promise<A.OutputOf<N>>;
type RegFn = (plugin: string, bindings: readonly A.PluginActionBinding[]) => void;
type VerG = (g: PolicyGrant) => boolean;
type O1 = { thermiteVersion: string; breaks?: readonly PluginBreakRule[]; localUrl?: string };
type O2 = { callAction: CallFn; registerPluginActions?: RegFn };
type O3 = { unregisterPluginActions?: (p: string) => void; verifyGrant?: VerG };
export type PluginHostOptions = Readonly<O1 & O2 & O3>;
type S1 = { manifest: unknown; code?: string | null; setup: T.PluginSetup };
type S2 = { settings?: Readonly<Record<string, string>>; sql?: T.PluginSql; pluginGrant?: G };
type S3 = { secrets?: T.PluginApi["secrets"]; log?: (...p: unknown[]) => void };
export type PluginLoadSpec = Readonly<S1 & S2 & S3>;
export type PluginHost = ReturnType<typeof createPluginHost>;

const err = (c: ThermiteErrorCode, m: string, d?: unknown) => new ThermiteError(c, m, d);
const noSql: T.PluginSql = () => Promise.reject(err("INTERNAL", "No SQL configured"));
const okOf = <V, R>(m: PM<V, R>, id: string) =>
  m.get(id)?.verified ? (m.get(id)?.value ?? null) : null;

function mount<H>(plugin: string, raw: string, handler: H, method?: string) {
  const path = raw.trim().replace(/^\/?/, "/");
  if (/\0|(?:^|\/)\.\.(?:\/|$)/.test(path)) throw err("VALIDATION_ERROR", `Bad path "${raw}"`);
  const fullPath = `/v1/plugins/${plugin}${path === "/" ? "" : path}`;
  const m = method?.toUpperCase();
  const entry: Ep<H> = { pluginName: plugin, ...(m ? { method: m } : {}), path, fullPath, handler };
  return { key: m ? `${m} ${fullPath}` : fullPath, entry };
}
function satisfiesRange(ver: string, range: string): boolean {
  const r = range.trim();
  if (r === "*") return true;
  const base = r.replace(/^(?:>=|\^)\s*/, "");
  if (!SEMVER_RE.test(base)) throw err("VALIDATION_ERROR", `Bad range "${range}"`);
  if (compareSemver(ver, base) < 0) return false;
  if (!r.startsWith("^")) return true;
  const [bm, bn] = base.split(".").map(Number);
  const [vm, vn] = ver.split(".").map(Number);
  return bm ? vm === bm : bn ? vm === 0 && vn === bn : compareSemver(ver, base) === 0;
}
function freezeGrant(g?: G): G {
  if (!g) return null;
  const c = structuredClone(g);
  Object.freeze(c.capabilities);
  if (c.scope) Object.freeze(c.scope);
  return Object.freeze(c);
}
async function prove<V, R extends Ok>(
  m: PM<V, R>,
  id: string,
  l: string,
  fn: (v: V) => Promise<R>,
) {
  const r = m.get(id);
  if (!r) throw err("NOT_FOUND", `${l} "${id}" not found`);
  r.report = await fn(r.value);
  r.verified = r.report.ok === true;
  return r.report;
}
function memSecrets(): T.PluginApi["secrets"] {
  const m = new Map<string, string>();
  const set = async (k: string, v: string | null) => {
    if (v === null) m.delete(k);
    else m.set(k, v);
  };
  return { get: async (k) => m.get(k) ?? null, set };
}

export function createPluginHost(opts: PluginHostOptions) {
  const breaks = opts.breaks ?? DEFAULT_PLUGIN_BREAKS;
  const localUrl = opts.localUrl ?? "http://127.0.0.1:8800";
  const loaded = new Map<string, Loaded>();
  const kbIndexed: ((ev: K.KbItemIndexedEvent) => Promise<void>)[] = [];
  const eventSubs: { filter: DomainEvent["type"] | "*"; handler: EvFn }[] = [];
  const reg = {
    actions: new Map<string, A.PluginActionBinding>(),
    routes: new Map<string, Ep<T.PluginRoute>>(),
    sockets: new Map<string, Ep<T.PluginSocketHandler>>(),
    kb: { lanes: new Map<string, K.KbSearchLane>(), extractors: [] as K.KbExtractor[] },
    harnesses: new Map<string, HarnessPlugin>(),
    devices: new Map<string, T.DevicePlugin>(),
    computes: new Map<string, T.ComputePlugin>(),
    walls: new Map<string, Proof<W.WallPlugin, W.WallSelfTestReport>>(),
    judges: new Map<string, Proof<T.JudgePlugin, T.JudgeCalibrationReport>>(),
  };
  const drop = (name: string, undo: (() => void)[]) => {
    for (const fn of undo.reverse()) fn();
    loaded.delete(name);
  };

  async function load(spec: PluginLoadSpec) {
    const manifest = parsePluginManifest(spec.manifest);
    const name = manifest.name;
    if (loaded.has(name)) throw err("CONFLICT", `Plugin "${name}" loaded`);
    const bad = unfit(manifest, spec.code ?? null, opts.thermiteVersion, breaks);
    if (bad) throw err("VALIDATION_ERROR", bad.reason, bad);
    const ext = manifest.extensions["com.usethermite"];
    for (const [dep, raw] of Object.entries(ext.needs ?? {})) {
      const got = loaded.get(dep);
      const range = typeof raw === "string" ? raw : raw.range;
      if (!got && (typeof raw !== "object" || !raw.optional))
        throw err("VALIDATION_ERROR", `Missing "${dep}"`);
      if (got && range && !satisfiesRange(got.manifest.version, range))
        throw err("VALIDATION_ERROR", `Dep "${dep}" fails ${range}`);
    }
    const controller = new AbortController();
    const rec: Loaded = { manifest, controller, api: null, cleanup: null, undo: [] };
    const frozenGrant = freezeGrant(spec.pluginGrant);
    const settings: Record<string, string> = {};
    for (const d of ext.settings ?? []) if (d.default !== undefined) settings[d.name] = d.default;
    Object.assign(settings, spec.settings);
    const put = <V>(m: Map<string, V>, k: string, v: V, lbl: string) => {
      if (m.has(k)) throw err("CONFLICT", `${lbl} "${k}" exists`);
      m.set(k, v);
      rec.undo.push(() => m.delete(k));
    };
    const push = <V>(a: V[], v: V) => {
      a.push(v);
      rec.undo.push(() => {
        const i = a.indexOf(v);
        if (i >= 0) a.splice(i, 1);
      });
    };
    const putEp = <H>(m: Map<string, Ep<H>>, r: { key: string; entry: Ep<H> }, lbl: string) =>
      put(m, r.key, r.entry, lbl);

    const api: T.PluginApi = {
      name,
      settings: Object.freeze(settings),
      sql: spec.sql ?? noSql,
      secrets: spec.secrets ?? memSecrets(),
      localUrl,
      signal: rec.controller.signal,
      kb: {
        registerSearchLane: (l) => put(reg.kb.lanes, l.name, l, "KB lane"),
        registerExtractor: (e) => push(reg.kb.extractors, e),
        onItemIndexed: (h) => push(kbIndexed, h),
      },
      log: spec.log ?? (() => {}),
      provide: (p) => {
        rec.api = p;
      },
      need: <U = Record<string, unknown>>(d: string) => (loaded.get(d)?.api as U | null) ?? null,
      dependents: () =>
        [...loaded.values()].flatMap(({ manifest: m, api: a }) => {
          const needs = m.extensions["com.usethermite"].needs ?? {};
          return Object.hasOwn(needs, name)
            ? [{ name: m.name, version: m.version, needs, api: a }]
            : [];
        }),
      onEvent: (filter, handler) => push(eventSubs, { filter, handler: handler as EvFn }),
      registerActions: (bindings) => {
        const batch = new Set<string>();
        for (const b of bindings) {
          assertPluginCapability(name, b.def.capability);
          if (reg.actions.has(b.def.name) || batch.has(b.def.name))
            throw err("CONFLICT", `Action "${b.def.name}" exists`);
          batch.add(b.def.name);
        }
        opts.registerPluginActions?.(name, bindings);
        rec.undo.push(() => opts.unregisterPluginActions?.(name));
        for (const b of bindings) put(reg.actions, b.def.name, b, "Action");
      },
      route: (m, raw, h) => putEp(reg.routes, mount(name, raw, h, m), "Route"),
      socket: (raw, h) => putEp(reg.sockets, mount(name, raw, h), "Socket"),
      callAction: async (act, input, callerGrant) => {
        if (rec.controller.signal.aborted) throw err("FORBIDDEN", `Plugin "${name}" unloaded`);
        if (callerGrant !== undefined) {
          if (!opts.verifyGrant?.(callerGrant)) throw err("FORBIDDEN", "Unverified callerGrant");
          if (callerGrant.revoked) throw err("UNAUTHORIZED", "Grant revoked");
          return opts.callAction(act, input, callerGrant);
        }
        return opts.callAction(act, input, frozenGrant);
      },
      registerHarness: (h) => put(reg.harnesses, h.id, h, "Harness"),
      registerDevice: (d) => put(reg.devices, d.id, d, "Device"),
      registerCompute: (c) => put(reg.computes, c.id, c, "Compute"),
      registerWall: (w) =>
        put(reg.walls, w.id, { value: w, verified: false, report: null }, "Wall"),
      registerJudge: (j) =>
        put(reg.judges, j.id, { value: j, verified: false, report: null }, "Judge"),
    };

    loaded.set(name, rec);
    try {
      const done = await spec.setup(api);
      if (typeof done === "function") rec.cleanup = done;
    } catch (e) {
      rec.controller.abort(e);
      drop(name, rec.undo);
      throw e;
    }
    return manifest;
  }

  async function unload(name: string) {
    const rec = loaded.get(name);
    if (!rec) throw err("NOT_FOUND", `Plugin "${name}" not loaded`);
    rec.controller.abort("plugin unloaded");
    try {
      await rec.cleanup?.();
    } finally {
      drop(name, rec.undo);
    }
  }

  return {
    load,
    unload,
    getPlugin: (name: string) => loaded.get(name)?.manifest ?? null,
    emitEvent: async (ev: DomainEvent) => {
      for (const s of [...eventSubs])
        if (s.filter === "*" || s.filter === ev.type) await s.handler(ev);
    },
    emitKbItemIndexed: async (ev: K.KbItemIndexedEvent) => {
      for (const fn of [...kbIndexed]) await fn(ev);
    },
    verifyWall: (id: string, t: WT) => prove(reg.walls, id, "Wall", (w) => w.selfTest(t)),
    getVerifiedWall: (id: string) => okOf(reg.walls, id),
    verifyJudge: (id: string) => prove(reg.judges, id, "Judge", (j) => j.calibrateAA()),
    getVerifiedJudge: (id: string) => okOf(reg.judges, id),
    ...reg,
  };
}
