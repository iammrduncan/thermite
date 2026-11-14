import { EFFORTS, type Effort, HARNESSES, type Harness } from "../../../core/agents.ts";
import { type AgentRole, harnessOf, type ModelAssignments } from "../models.ts";
import type { ModelProvider } from "../providers.ts";
import { PgPart, type Row } from "./part.ts";

/** ModelAssignments on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresModelAssignments extends PgPart implements ModelAssignments {
  /**
   * Gives a rig's agents a harness and a provider's model, or (null) returns them to the rig's own
   * settings. `contextCap`: a cap on the model's context window in tokens (goal 070); none when
   * left out, so a model given again without one loses it. `compactAt`: the compaction point, in
   * percent of the window (goal 070); left out, the harness's default.
   */
  async assignRig(
    rig: string,
    choice: {
      provider: string;
      model: string;
      harness?: Harness | undefined;
      effort?: Effort | undefined;
      contextCap?: number | undefined;
      compactAt?: number | undefined;
    } | null,
  ): Promise<void> {
    if (choice === null) {
      await this.q.run("delete from rig_model where rig = ?", rig);
      return;
    }
    if (!(await this.store.modelProviders.get(choice.provider)))
      throw new Error(`no model provider ${choice.provider}`);
    await this.q.run(
      `insert into rig_model (rig, provider, model, harness, effort, context_cap, compact_at, assigned_at) values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (rig) do update set provider = excluded.provider, model = excluded.model,
           harness = excluded.harness, effort = excluded.effort, context_cap = excluded.context_cap,
           compact_at = excluded.compact_at, assigned_at = excluded.assigned_at`,
      rig,
      choice.provider,
      choice.model,
      choice.harness ?? "pi",
      choice.effort ?? null,
      choice.contextCap ?? null,
      choice.compactAt ?? null,
      new Date().toISOString(),
    );
  }

  /**
   * Gives one of a rig's other agents a model, or (null) has it follow the workers again.
   * `harness`: the harness it runs in (goal 073); left out, what its model needs. `contextCap` and
   * `compactAt`: the agent's own cap on its model's window and its compaction point (goal 070), as
   * for the workers' model; none when left out.
   */
  async assignRole(
    rig: string,
    role: AgentRole,
    choice: {
      provider: string;
      model: string;
      effort?: Effort | undefined;
      harness?: Harness | undefined;
      contextCap?: number | undefined;
      compactAt?: number | undefined;
    } | null,
  ): Promise<void> {
    if (choice === null) {
      await this.q.run("delete from rig_role_model where rig = ? and role = ?", rig, role);
      return;
    }
    if (!(await this.store.modelProviders.get(choice.provider)))
      throw new Error(`no model provider ${choice.provider}`);
    await this.q.run(
      `insert into rig_role_model (rig, role, provider, model, effort, harness, context_cap, compact_at, assigned_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (rig, role) do update set provider = excluded.provider, model = excluded.model,
           effort = excluded.effort, harness = excluded.harness, context_cap = excluded.context_cap,
           compact_at = excluded.compact_at, assigned_at = excluded.assigned_at`,
      rig,
      role,
      choice.provider,
      choice.model,
      choice.effort ?? null,
      choice.harness ?? null,
      choice.contextCap ?? null,
      choice.compactAt ?? null,
      new Date().toISOString(),
    );
  }

  /**
   * A rig's other agents' models, by role (roles with none are absent). `harness`: the one the
   * owner chose (goal 073); null, what the model needs. Each with its own cap and compaction
   * point (goal 070), when set.
   */
  async byRole(rig: string): Promise<
    Partial<
      Record<
        AgentRole,
        {
          provider: string;
          model: string;
          effort: Effort | null;
          harness: Harness | null;
          contextCap?: number | undefined;
          compactAt?: number | undefined;
        }
      >
    >
  > {
    const rows = (await this.q.all(
      "select role, provider, model, effort, harness, context_cap, compact_at from rig_role_model where rig = ?",
      rig,
    )) as Row[];
    return Object.fromEntries(
      rows.map((r) => [
        String(r.role),
        {
          provider: String(r.provider),
          model: String(r.model),
          effort: EFFORTS.includes(String(r.effort) as Effort)
            ? (String(r.effort) as Effort)
            : null,
          harness: HARNESSES.find((h) => h === r.harness) ?? null,
          ...(Number(r.context_cap) > 0 ? { contextCap: Number(r.context_cap) } : {}),
          ...(Number(r.compact_at) > 0 ? { compactAt: Number(r.compact_at) } : {}),
        },
      ]),
    );
  }

  /** Each rig's provider, model, harness, effort, context window cap and compaction point (goal 070). */
  async byRig(): Promise<
    Record<
      string,
      {
        provider: string;
        model: string;
        harness: Harness;
        effort?: Effort | undefined;
        contextCap?: number | undefined;
        compactAt?: number | undefined;
      }
    >
  > {
    const rows = (await this.q.all(
      "select rig, provider, model, harness, effort, context_cap, compact_at from rig_model",
    )) as Row[];
    return Object.fromEntries(
      rows.map((r) => [
        String(r.rig),
        {
          provider: String(r.provider),
          model: String(r.model),
          harness: harnessOf(r.harness),
          ...(EFFORTS.includes(String(r.effort) as Effort)
            ? { effort: String(r.effort) as Effort }
            : {}),
          ...(Number(r.context_cap) > 0 ? { contextCap: Number(r.context_cap) } : {}),
          ...(Number(r.compact_at) > 0 ? { compactAt: Number(r.compact_at) } : {}),
        },
      ]),
    );
  }

  async forRig(rig: string): Promise<
    | {
        provider: ModelProvider;
        model: string;
        harness: Harness;
        effort?: Effort | undefined;
        contextCap?: number | undefined;
        compactAt?: number | undefined;
      }
    | undefined
  > {
    const c = (await this.byRig())[rig];
    const provider = c ? await this.store.modelProviders.get(c.provider) : undefined;
    return c && provider
      ? {
          provider,
          model: c.model,
          harness: c.harness,
          effort: c.effort,
          contextCap: c.contextCap,
          compactAt: c.compactAt,
        }
      : undefined;
  }
}
