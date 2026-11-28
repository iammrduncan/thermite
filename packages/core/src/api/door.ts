import { ThermiteError, type ThermiteErrorCode } from "../errors.ts";
import { CORE_CAPABILITY_PREFIXES, checkPolicyAccess, evaluatePolicy } from "../policy/index.ts";
import { type ActionByName, CORE_ACTIONS, type CoreActionName, type OutputOf } from "./actions.ts";
import type * as A from "./types.ts";

export const PLUGIN_SLUG_RE = /^[a-z][a-z0-9-]*$/;
const PLUGIN_VERB_RE = /^[a-z][a-z0-9_-]*$/;
type Entry = {
  readonly def: A.ActionDef;
  readonly owner: string;
  readonly handler?: A.ActionHandler;
};
export type CoreActionHandlers = {
  readonly [K in CoreActionName]?: A.ActionHandler<
    ActionByName<K>["input"],
    ActionByName<K>["output"]
  >;
};
export type DoorExecutorOptions = {
  readonly actions?: readonly A.ActionDef[];
  readonly handlers: Partial<CoreActionHandlers> & Readonly<Record<string, A.ActionHandler>>;
  readonly onAudit?: (entry: A.DoorAuditEntry) => void | Promise<void>;
  readonly installedPluginPrefixes?: readonly string[];
};
export type DoorExecutor = {
  listActions(): readonly A.ActionDef[];
  getAction(name: string): A.ActionDef | undefined;
  registerPluginActions(pluginName: string, bindings: readonly A.PluginActionBinding[]): void;
  unregisterPluginActions(pluginName: string): void;
  execute<K extends CoreActionName>(name: K, raw: unknown, auth: A.DoorAuth): Promise<OutputOf<K>>;
  execute(name: string, raw: unknown, auth: A.DoorAuth): Promise<unknown>;
};

const rk = (d: A.ActionDef) => `${d.http.method} ${d.http.path}`;
function fail(code: ThermiteErrorCode, msg: string, issues?: unknown): never {
  throw new ThermiteError(code, msg, issues ? { issues } : undefined);
}

export function assertPluginCapability(pluginName: string, capability: string): void {
  const [p = "", v = "", x] = capability.split(":");
  if (
    x !== undefined ||
    p !== pluginName ||
    CORE_CAPABILITY_PREFIXES.has(p) ||
    !PLUGIN_VERB_RE.test(v)
  )
    fail("VALIDATION_ERROR", `Invalid capability "${capability}".`);
}

export function createDoorExecutor(opts: DoorExecutorOptions): DoorExecutor {
  const entries = new Map<string, Entry>();
  const routes = new Set<string>();
  const plugins = new Set<string>();
  const addBatch = (
    owner: string,
    items: readonly { def: A.ActionDef; handler?: A.ActionHandler }[],
  ) => {
    const seen = new Set<string>();
    for (const { def } of items) {
      if (owner !== "core") assertPluginCapability(owner, def.capability);
      const r = rk(def);
      if (entries.has(def.name) || seen.has(`a:${def.name}`))
        fail("CONFLICT", `Duplicate "${def.name}".`);
      if (routes.has(r) || seen.has(`r:${r}`)) fail("CONFLICT", `Duplicate route "${r}".`);
      seen.add(`a:${def.name}`).add(`r:${r}`);
    }
    for (const { def, handler } of items) {
      entries.set(def.name, { def, owner, handler });
      routes.add(rk(def));
    }
  };
  addBatch(
    "core",
    (opts.actions ?? CORE_ACTIONS).map((def) => ({ def, handler: opts.handlers[def.name] })),
  );

  async function execute(name: string, rawInput: unknown, auth: A.DoorAuth): Promise<unknown> {
    const entry = entries.get(name);
    if (!entry) fail("NOT_FOUND", `Unknown action "${name}".`);
    const { def, handler } = entry;
    const mOpts = opts.installedPluginPrefixes
      ? { installedPluginPrefixes: [...new Set([...opts.installedPluginPrefixes, ...plugins])] }
      : undefined;
    const caller = auth.callerKind ? { callerKind: auth.callerKind } : {};
    const pre = checkPolicyAccess(auth.grant, def.capability, auth.nowMs, { ...mOpts, ...caller });
    if (!pre.ok) fail(pre.code, pre.reason);
    const pIn = def.input.safeParse(rawInput);
    if (!pIn.success) fail("VALIDATION_ERROR", `Invalid input: "${name}".`, pIn.error.issues);
    const scope = def.extractScope ? def.extractScope(pIn.data) : {};
    const req = { capability: def.capability, principalId: auth.principalId, ...caller, ...scope };
    const dec = evaluatePolicy(pre.grant, req, auth.nowMs, mOpts);
    if (!dec.ok) fail(dec.code, dec.reason);
    if (!handler) fail("INTERNAL", `No handler for "${name}".`);
    const ctx = {
      action: name,
      actor: dec.actor,
      audit: dec.audit,
      grant: pre.grant,
      nowMs: auth.nowMs,
    };
    const pOut = def.output.safeParse(await handler(pIn.data, ctx));
    if (!pOut.success) fail("INTERNAL", `Invalid output: "${name}".`, pOut.error.issues);
    await opts.onAudit?.({ ...dec.audit, action: name, at: auth.nowMs });
    return pOut.data;
  }
  return {
    listActions: () => Array.from(entries.values(), (e) => e.def),
    getAction: (name) => entries.get(name)?.def,
    registerPluginActions(name, bindings) {
      if (!PLUGIN_SLUG_RE.test(name) || CORE_CAPABILITY_PREFIXES.has(name))
        fail("VALIDATION_ERROR", `Invalid plugin "${name}".`);
      addBatch(name, bindings);
      plugins.add(name);
    },
    unregisterPluginActions(name) {
      for (const [k, e] of entries) {
        if (e.owner === name) {
          entries.delete(k);
          routes.delete(rk(e.def));
        }
      }
      plugins.delete(name);
    },
    execute: execute as DoorExecutor["execute"],
  };
}
