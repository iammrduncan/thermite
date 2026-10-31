import type { DatabaseSync } from "node:sqlite";
import type { ProviderType } from "../../core/agents.ts";
import type { ModelPrice } from "../../core/usage.ts";
import { type Row, StorePart } from "./part.ts";

/**
 * Model providers (goal 125, T6): their keys only sealed, and the models they list.
 */

/**
 * The settings page's first version stored one route per model (model_route, rig_model_route).
 * Each becomes a provider of type openai with that model, and its rigs keep their model: a step of
 * the store's first migration (schema.ts).
 */
export function migrateModelRoutes(db: DatabaseSync): void {
  const has = (t: string) =>
    db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(t);
  if (!has("model_route")) return;
  const now = new Date().toISOString();
  const routes = db.prepare("select * from model_route").all() as Row[];
  for (const r of routes)
    db.prepare(
      `insert or ignore into model_provider (name, type, base_url, key_sealed, key_hint, version, updated_at, models)
       values (?, 'openai', ?, ?, ?, 1, ?, ?)`,
    ).run(
      String(r.name),
      String(r.base_url),
      String(r.key_sealed),
      String(r.key_hint),
      now,
      JSON.stringify([{ id: String(r.model), added: true }]),
    );
  if (has("rig_model_route")) {
    const given = db.prepare("select * from rig_model_route").all() as Row[];
    for (const g of given) {
      const route = routes.find((r) => r.name === g.route);
      if (route)
        db.prepare(
          "insert or ignore into rig_model (rig, provider, model, assigned_at) values (?, ?, ?, ?)",
        ).run(String(g.rig), String(route.name), String(route.model), now);
    }
    db.exec("drop table rig_model_route");
  }
  db.exec("drop table model_route");
}

/** A model in a provider's list: its id, and its context window when the provider says it. */
export interface ProviderModel {
  id: string;
  context_window?: number | undefined;
  /** Added by the owner by its name (the provider does not list it). */
  added?: boolean | undefined;
  /** Its price as the provider's list gives it, per million tokens (goal 075); none: not listed. */
  price?: ModelPrice | undefined;
  /**
   * The most tokens one reply may take, as the provider's list gives it (goal 079): the rig's route
   * carries it as its reply limit. None: none is sent, and the provider's own applies.
   */
  max_output?: number | undefined;
}

/** A model provider as stored: its key only sealed, and a hint of it for the dashboard. */
export interface ModelProvider {
  name: string;
  type: ProviderType;
  base_url: string;
  key_sealed: string;
  key_hint: string;
  version: number;
  updated_at: string;
  models: ProviderModel[];
  models_at: string | null;
  models_error: string | null;
}

function providerOf(r: Row): ModelProvider {
  let models: ProviderModel[] = [];
  try {
    models = JSON.parse(String(r.models ?? "[]")) as ProviderModel[];
  } catch {
    models = [];
  }
  return {
    name: String(r.name),
    type:
      r.type === "anthropic" || r.type === "opencode" || r.type === "claude" || r.type === "chatgpt"
        ? r.type
        : "openai",
    base_url: String(r.base_url),
    key_sealed: String(r.key_sealed),
    key_hint: String(r.key_hint),
    version: Number(r.version),
    updated_at: String(r.updated_at),
    models,
    models_at: r.models_at === null || r.models_at === undefined ? null : String(r.models_at),
    models_error:
      r.models_error === null || r.models_error === undefined ? null : String(r.models_error),
  };
}

export class ModelProviders extends StorePart {
  /**
   * Creates or changes a model provider. A change without a new key keeps the sealed one; a new
   * provider needs a key. Its version moves on every change, so the rigs that use it pick it up.
   */
  put(p: {
    name: string;
    type: ProviderType;
    base_url: string;
    key?: { sealed: string; hint: string } | undefined;
  }): "created" | "updated" | "needs_key" {
    const old = this.get(p.name);
    // OpenCode's own free models need no key; every other provider does.
    if (!old && !p.key && p.type !== "opencode") return "needs_key";
    this.db
      .prepare(
        `insert into model_provider (name, type, base_url, key_sealed, key_hint, version, updated_at)
         values (?, ?, ?, ?, ?, 1, ?)
         on conflict (name) do update set type = excluded.type, base_url = excluded.base_url,
           key_sealed = excluded.key_sealed, key_hint = excluded.key_hint,
           version = model_provider.version + 1, updated_at = excluded.updated_at`,
      )
      .run(
        p.name,
        p.type,
        p.base_url,
        p.key?.sealed ?? old?.key_sealed ?? "",
        p.key?.hint ?? old?.key_hint ?? "",
        new Date().toISOString(),
      );
    return old ? "updated" : "created";
  }

  list(): ModelProvider[] {
    return (this.db.prepare("select * from model_provider order by name").all() as Row[]).map(
      providerOf,
    );
  }

  get(name: string): ModelProvider | undefined {
    const r = this.db.prepare("select * from model_provider where name = ?").get(name) as
      | Row
      | undefined;
    return r ? providerOf(r) : undefined;
  }

  /**
   * Keeps what the provider listed (and the models the owner added by name), or, when listing
   * failed, its error, keeping the last list so the rigs' models stay choosable.
   */
  setModels(name: string, listed: ProviderModel[] | { error: string }): void {
    const now = new Date().toISOString();
    if ("error" in listed) {
      this.db
        .prepare("update model_provider set models_error = ?, models_at = ? where name = ?")
        .run(listed.error.slice(0, 300), now, name);
      return;
    }
    const added = (this.get(name)?.models ?? []).filter(
      (m) => m.added && !listed.some((x) => x.id === m.id),
    );
    this.db
      .prepare(
        "update model_provider set models = ?, models_error = null, models_at = ? where name = ?",
      )
      .run(JSON.stringify([...listed, ...added]), now, name);
  }

  /**
   * A provider's sealed key replaced where nothing else changes (a ChatGPT login control renewed):
   * its version stays; the routes' revisions follow the key.
   */
  setKey(name: string, sealed: string): void {
    this.db.prepare("update model_provider set key_sealed = ? where name = ?").run(sealed, name);
  }

  /** A model the provider does not list, added by the owner by its name. */
  addModel(name: string, id: string): void {
    const p = this.get(name);
    if (!p || p.models.some((m) => m.id === id)) return;
    this.db
      .prepare("update model_provider set models = ? where name = ?")
      .run(JSON.stringify([...p.models, { id, added: true }]), name);
  }

  /** Deletes a provider no rig uses. */
  delete(name: string): "deleted" | "in_use" | "missing" {
    if (!this.get(name)) return "missing";
    if (
      this.db.prepare("select 1 from rig_model where provider = ?").get(name) ||
      this.db.prepare("select 1 from rig_role_model where provider = ?").get(name)
    )
      return "in_use";
    this.db.prepare("delete from model_provider where name = ?").run(name);
    return "deleted";
  }
}
