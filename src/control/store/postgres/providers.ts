import type { ProviderType } from "../../../core/agents.ts";
import {
  type ModelProvider,
  type ModelProviders,
  type ProviderModel,
  providerOf,
} from "../providers.ts";
import { PgPart, type Row } from "./part.ts";

/** ModelProviders on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresModelProviders extends PgPart implements ModelProviders {
  /**
   * Creates or changes a model provider. A change without a new key keeps the sealed one. A
   * provider needs a key unless it is OpenCode's own or OpenAI-compatible: a new one, and one with
   * no key changed to another type. Its version moves on every change, so the rigs that use it
   * pick it up.
   */
  async put(p: {
    name: string;
    type: ProviderType;
    base_url: string;
    key?: { sealed: string; hint: string } | undefined;
  }): Promise<"created" | "updated" | "needs_key"> {
    const old = await this.get(p.name);
    // OpenCode's own free models need no key, and neither does an OpenAI-compatible server that
    // takes none, such as a local llama.cpp or Ollama: its calls then go with no key. Anthropic's
    // API does need one, also when a provider with no key is changed to it.
    if (!p.key && !old?.key_sealed && p.type !== "opencode" && p.type !== "openai")
      return "needs_key";
    await this.q.run(
      `insert into model_provider (name, type, base_url, key_sealed, key_hint, version, updated_at)
         values (?, ?, ?, ?, ?, 1, ?)
         on conflict (name) do update set type = excluded.type, base_url = excluded.base_url,
           key_sealed = excluded.key_sealed, key_hint = excluded.key_hint,
           version = model_provider.version + 1, updated_at = excluded.updated_at`,
      p.name,
      p.type,
      p.base_url,
      p.key?.sealed ?? old?.key_sealed ?? "",
      p.key?.hint ?? old?.key_hint ?? "",
      new Date().toISOString(),
    );
    return old ? "updated" : "created";
  }

  async list(): Promise<ModelProvider[]> {
    return ((await this.q.all("select * from model_provider order by name")) as Row[]).map(
      providerOf,
    );
  }

  async get(name: string): Promise<ModelProvider | undefined> {
    const r = (await this.q.get("select * from model_provider where name = ?", name)) as
      | Row
      | undefined;
    return r ? providerOf(r) : undefined;
  }

  /**
   * Keeps what the provider listed (and the models the owner added by name), or, when listing
   * failed, its error, keeping the last list so the rigs' models stay choosable.
   */
  async setModels(name: string, listed: ProviderModel[] | { error: string }): Promise<void> {
    const now = new Date().toISOString();
    if ("error" in listed) {
      await this.q.run(
        "update model_provider set models_error = ?, models_at = ? where name = ?",
        listed.error.slice(0, 300),
        now,
        name,
      );
      return;
    }
    const added = ((await this.get(name))?.models ?? []).filter(
      (m) => m.added && !listed.some((x) => x.id === m.id),
    );
    await this.q.run(
      "update model_provider set models = ?, models_error = null, models_at = ? where name = ?",
      JSON.stringify([...listed, ...added]),
      now,
      name,
    );
  }

  /**
   * A provider's sealed key replaced where nothing else changes (a ChatGPT login control renewed):
   * its version stays; the routes' revisions follow the key.
   */
  async setKey(name: string, sealed: string): Promise<void> {
    await this.q.run("update model_provider set key_sealed = ? where name = ?", sealed, name);
  }

  /** A model the provider does not list, added by the owner by its name. */
  async addModel(name: string, id: string): Promise<void> {
    const p = await this.get(name);
    if (!p || p.models.some((m) => m.id === id)) return;
    await this.q.run(
      "update model_provider set models = ? where name = ?",
      JSON.stringify([...p.models, { id, added: true }]),
      name,
    );
  }

  /** Deletes a provider no rig uses. */
  async delete(name: string): Promise<"deleted" | "in_use" | "missing"> {
    if (!(await this.get(name))) return "missing";
    if (
      (await this.q.get("select 1 from rig_model where provider = ?", name)) ||
      (await this.q.get("select 1 from rig_role_model where provider = ?", name))
    )
      return "in_use";
    await this.q.run("delete from model_provider where name = ?", name);
    return "deleted";
  }
}
