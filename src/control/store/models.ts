import type { DatabaseSync } from "node:sqlite";
import {
  EFFORTS,
  type Effort,
  HARNESSES,
  type Harness,
  type ProviderType,
  reaches,
} from "../../core/agents.ts";
import { type Row, StorePart } from "./part.ts";
import type { ModelProvider } from "./providers.ts";

/**
 * Which model each rig's agents use (goal 125, T6): the workers' model, and each other agent's
 * when it has one of its own.
 */

/** A harness from a form or a row; anything else is Pi, the default. */
export const harnessOf = (v: unknown): Harness => HARNESSES.find((h) => h === v) ?? "pi";

export const codexTakes = (type: ProviderType): boolean => reaches("codex", type);

/**
 * A rig's agents other than its workers, each of which may have its own model (goal 074): the
 * planner; the teachers' first model (`teachers`), their second (`second_teacher`: a second
 * teacher) and the model that merges two teachers' advice (`merged_by`); the auditor; the review
 * panel; and a research run's synthesizer and final writer (goal 166), which use the first
 * teacher's model when they have none of their own.
 */
export type AgentRole =
  | "planner"
  | "teachers"
  | "second_teacher"
  | "merged_by"
  | "auditor"
  | "review_panel"
  | "synthesizer"
  | "final_writer";

export const AGENT_ROLES: AgentRole[] = [
  "planner",
  "teachers",
  "second_teacher",
  "merged_by",
  "auditor",
  "review_panel",
  "synthesizer",
  "final_writer",
];

/**
 * The synthesizer's and the final writer's model slots (goal 166), made by the store's migration
 * to schema version 10: the table of the agents' models is made again with them in its check of
 * roles, and keeps every row.
 */
export function synthesizerAndWriterSlots(db: DatabaseSync): void {
  const cols = "rig, role, provider, model, effort, assigned_at, harness, context_cap, compact_at";
  // Written out, not AGENT_ROLES: a migration that has run never changes.
  db.exec(`create table rig_role_model_166 (
  rig text not null,
  role text not null check (role in ('planner', 'teachers', 'second_teacher', 'merged_by',
    'auditor', 'review_panel', 'synthesizer', 'final_writer')),
  provider text not null,
  model text not null,
  effort text,
  assigned_at text not null,
  harness text,
  context_cap integer,
  compact_at integer,
  primary key (rig, role)
)`);
  db.exec(`insert into rig_role_model_166 (${cols}) select ${cols} from rig_role_model`);
  db.exec("drop table rig_role_model");
  db.exec("alter table rig_role_model_166 rename to rig_role_model");
}

export class ModelAssignments extends StorePart {
  /**
   * Gives a rig's agents a harness and a provider's model, or (null) returns them to the rig's own
   * settings. `contextCap`: a cap on the model's context window in tokens (goal 070); none when
   * left out, so a model given again without one loses it. `compactAt`: the compaction point, in
   * percent of the window (goal 070); left out, the harness's default.
   */
  assignRig(
    rig: string,
    choice: {
      provider: string;
      model: string;
      harness?: Harness | undefined;
      effort?: Effort | undefined;
      contextCap?: number | undefined;
      compactAt?: number | undefined;
    } | null,
  ): void {
    if (choice === null) {
      this.db.prepare("delete from rig_model where rig = ?").run(rig);
      return;
    }
    if (!this.store.modelProviders.get(choice.provider))
      throw new Error(`no model provider ${choice.provider}`);
    this.db
      .prepare(
        `insert into rig_model (rig, provider, model, harness, effort, context_cap, compact_at, assigned_at) values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (rig) do update set provider = excluded.provider, model = excluded.model,
           harness = excluded.harness, effort = excluded.effort, context_cap = excluded.context_cap,
           compact_at = excluded.compact_at, assigned_at = excluded.assigned_at`,
      )
      .run(
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
  assignRole(
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
  ): void {
    if (choice === null) {
      this.db.prepare("delete from rig_role_model where rig = ? and role = ?").run(rig, role);
      return;
    }
    if (!this.store.modelProviders.get(choice.provider))
      throw new Error(`no model provider ${choice.provider}`);
    this.db
      .prepare(
        `insert into rig_role_model (rig, role, provider, model, effort, harness, context_cap, compact_at, assigned_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (rig, role) do update set provider = excluded.provider, model = excluded.model,
           effort = excluded.effort, harness = excluded.harness, context_cap = excluded.context_cap,
           compact_at = excluded.compact_at, assigned_at = excluded.assigned_at`,
      )
      .run(
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
  byRole(rig: string): Partial<
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
  > {
    const rows = this.db
      .prepare(
        "select role, provider, model, effort, harness, context_cap, compact_at from rig_role_model where rig = ?",
      )
      .all(rig) as Row[];
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
  byRig(): Record<
    string,
    {
      provider: string;
      model: string;
      harness: Harness;
      effort?: Effort | undefined;
      contextCap?: number | undefined;
      compactAt?: number | undefined;
    }
  > {
    const rows = this.db
      .prepare(
        "select rig, provider, model, harness, effort, context_cap, compact_at from rig_model",
      )
      .all() as Row[];
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

  forRig(rig: string):
    | {
        provider: ModelProvider;
        model: string;
        harness: Harness;
        effort?: Effort | undefined;
        contextCap?: number | undefined;
        compactAt?: number | undefined;
      }
    | undefined {
    const c = this.byRig()[rig];
    const provider = c ? this.store.modelProviders.get(c.provider) : undefined;
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
