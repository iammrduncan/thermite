import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { type ModelConfig, reasoningFromEnv } from "../../../agents/model/index.ts";
import type { Harness } from "../../../core/agents.ts";
import { ControlRoute } from "../../../core/api/model-route.ts";

/** A model route as control hands it to the rig (its contract: core/api/model-route.ts). */
export { ControlRoute };

/** Which route the agents use, as the rig reports it (never the key). */
export interface ModelInfo {
  source: "control" | "environment" | "none";
  name?: string | undefined;
  version?: number | undefined;
  revision?: string | undefined;
  /** The harness the agents run in. */
  harness?: Harness | undefined;
  model?: string | undefined;
  base_url?: string | undefined;
  key_hint?: string | undefined;
}

/** The file in the state folder where the rig keeps the route control set for its agents. */
export const ROUTE_FILE = "model-route.json";

/** Where the planner's own route is kept, beside the agents' route `file`. */
export const plannerRouteFile = (file: string): string => file.replace(/\.json$/, "-planner.json");

/**
 * Where the agents' model route comes from: the route control set for this rig, kept in a file
 * only root (the harness's controller) reads, or else the rig's own settings (its environment).
 * Every plan and trial takes the route current when it starts.
 */
export class ModelSource {
  private route: ControlRoute | undefined;
  private plannerRoute: ControlRoute | undefined;
  private readonly file: string;
  private readonly fromEnv: ModelConfig | undefined;

  constructor(file: string, fromEnv: ModelConfig | undefined) {
    this.file = file;
    this.fromEnv = fromEnv;
    if (existsSync(file)) {
      try {
        this.route = ControlRoute.parse(JSON.parse(readFileSync(file, "utf8")));
      } catch {
        // A broken file is dropped: the supervisor hands the route again on its next round.
        rmSync(file, { force: true });
      }
    }
    const plannerFile = plannerRouteFile(file);
    if (existsSync(plannerFile)) {
      try {
        this.plannerRoute = ControlRoute.parse(JSON.parse(readFileSync(plannerFile, "utf8")));
      } catch {
        rmSync(plannerFile, { force: true });
      }
    }
  }

  current(): ModelConfig | undefined {
    const r = this.route;
    if (!r) return this.fromEnv;
    return this.configOf(r, () => this.route);
  }

  /** The planner's own route, when control gave the planner a model; else the workers'. */
  planner(): ModelConfig | undefined {
    const r = this.plannerRoute;
    return r ? this.configOf(r, () => this.plannerRoute) : undefined;
  }

  /**
   * A route as the agents' configuration. A ChatGPT sign-in's token is renewed under the same
   * route: a call reads the newest one, so a long trial or plan outlives the hour of its first.
   */
  private configOf(r: ControlRoute, now: () => ControlRoute | undefined): ModelConfig {
    const type = r.type ?? "openai";
    return {
      api: type === "openai" ? undefined : type,
      harness: r.harness === "pi" ? undefined : r.harness,
      provider: r.name,
      baseUrl: r.base_url.replace(/\/$/, ""),
      model: r.model,
      apiKey: r.api_key,
      contextWindow: r.context_window,
      ...(r.compact_at !== undefined ? { compactAt: r.compact_at } : {}),
      // The model's maximum output from the provider's list; 0: none sent (goal 079).
      maxTokens: r.max_tokens,
      reasoning: reasoningFromEnv(r.reasoning ?? undefined),
      effort: r.effort ?? undefined,
      ...(type === "chatgpt"
        ? {
            keyNow: () => {
              const n = now();
              return n && n.name === r.name && n.type === "chatgpt" ? n.api_key : r.api_key;
            },
          }
        : {}),
    };
  }

  /** The planner's route's revision (none: the planner follows the workers' route). */
  plannerRevision(): string | null {
    return this.plannerRoute?.revision ?? null;
  }

  /** Takes or (null) clears the planner's own route; kept like the workers' route. */
  setPlanner(route: ControlRoute | null): void {
    const file = plannerRouteFile(this.file);
    if (!route) {
      rmSync(file, { force: true });
      this.plannerRoute = undefined;
      return;
    }
    const r = ControlRoute.parse(route);
    writeFileSync(`${file}.tmp`, JSON.stringify(r), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    this.plannerRoute = r;
  }

  info(): ModelInfo {
    const r = this.route;
    if (r)
      return {
        source: "control",
        name: r.name,
        version: r.version,
        revision: r.revision,
        harness: r.harness ?? "pi",
        model: r.model,
        base_url: r.base_url,
        key_hint: r.key_hint,
      };
    return this.fromEnv
      ? {
          source: "environment",
          model: this.fromEnv.model,
          base_url: this.fromEnv.baseUrl,
          harness: this.fromEnv.harness ?? "pi",
        }
      : { source: "none" };
  }

  /** Takes control's route; written 0600 and renamed into place, so a crash leaves the old one. */
  set(route: ControlRoute): void {
    const r = ControlRoute.parse(route);
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(r), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.route = r;
  }

  /** Back to the rig's own settings. */
  clear(): void {
    rmSync(this.file, { force: true });
    this.route = undefined;
  }
}
