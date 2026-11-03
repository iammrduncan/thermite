import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { type ModelConfig, reasoningFromEnv } from "../../../agents/model/index.ts";
import { HARNESSES, type Harness } from "../../../core/agents.ts";
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

/** The file in the state folder where the rig records the route control set for its agents. */
export const ROUTE_FILE = "model-route.json";

/** Where the planner's own route is recorded, beside the agents' route `file`. */
export const plannerRouteFile = (file: string): string => file.replace(/\.json$/, "-planner.json");

/**
 * What the state folder keeps of a route control set: which route it is, never its key. The key
 * lives in memory only; parsed, a file an older harness wrote loses its key.
 */
const RouteRecord = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  version: z.number().int().min(1),
  revision: z.string().regex(/^[0-9a-f]{8,64}$/),
  harness: z.enum(HARNESSES).optional(),
  base_url: z
    .string()
    .url()
    .max(500)
    .refine((u) => /^https?:\/\//.test(u), "an http or https URL"),
  model: z.string().min(1).max(200),
  key_hint: z.string().max(16),
});
type RouteRecord = z.infer<typeof RouteRecord>;

const recordOf = (r: ControlRoute): RouteRecord => ({
  name: r.name,
  version: r.version,
  revision: r.revision,
  harness: r.harness ?? "pi",
  base_url: r.base_url,
  model: r.model,
  key_hint: r.key_hint,
});

/** Written 0600 and renamed into place, so a crash leaves the old one. */
function writeRecord(file: string, r: RouteRecord): void {
  writeFileSync(`${file}.tmp`, JSON.stringify(r), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/**
 * A route's record from its file. One that holds a key, as an older harness wrote it, is written
 * again without it; a broken one is dropped (the supervisor hands the route again).
 */
function readRecord(file: string): RouteRecord | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const r = RouteRecord.parse(raw);
    if ("api_key" in raw) writeRecord(file, r);
    return r;
  } catch {
    rmSync(file, { force: true });
    return undefined;
  }
}

/**
 * Where the agents' model route comes from: the route control set for this rig, or else the rig's
 * own settings (its environment). Every plan and trial takes the route current when it starts.
 * The route, key and all, is held in memory only; the state folder records which route it is, in
 * a file only root (the harness's controller) reads. After a restart the harness awaits the routes
 * it recorded: the supervisor hands them again (it looks every THERMITE_MODEL_ROUTE_POLL_SECONDS,
 * 30 by default), and until then no plan or trial starts, on the rig's own settings or any other.
 */
export class ModelSource {
  private route: ControlRoute | undefined;
  private plannerRoute: ControlRoute | undefined;
  /** The routes recorded before this start, awaited from the supervisor. */
  private awaited:
    | { route?: RouteRecord | undefined; planner?: RouteRecord | undefined }
    | undefined;
  private readonly file: string;
  private readonly fromEnv: ModelConfig | undefined;

  constructor(file: string, fromEnv: ModelConfig | undefined) {
    this.file = file;
    this.fromEnv = fromEnv;
    const route = readRecord(file);
    const planner = readRecord(plannerRouteFile(file));
    if (route || planner) this.awaited = { route, planner };
  }

  /** Whether the harness awaits the routes it had before it started, from the supervisor. */
  awaiting(): boolean {
    return this.awaited !== undefined;
  }

  /**
   * Whether these routes are the ones awaited since the harness started: handed again, as they
   * were before, not new.
   */
  handedAgain(route: ControlRoute | null, planner?: ControlRoute | null): boolean {
    const a = this.awaited;
    if (!a) return false;
    const same = (x: ControlRoute | null | undefined, y: RouteRecord | undefined) =>
      (x?.revision ?? null) === (y?.revision ?? null);
    return same(route, a.route) && (planner === undefined || same(planner, a.planner));
  }

  current(): ModelConfig | undefined {
    if (this.awaited) return undefined;
    const r = this.route;
    if (!r) return this.fromEnv;
    return this.configOf(r, () => this.route);
  }

  /** The planner's own route, when control gave the planner a model; else the workers'. */
  planner(): ModelConfig | undefined {
    const r = this.plannerRoute;
    return r && !this.awaited ? this.configOf(r, () => this.plannerRoute) : undefined;
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

  /** Takes or (null) clears the planner's own route; recorded like the workers' route. */
  setPlanner(route: ControlRoute | null): void {
    const file = plannerRouteFile(this.file);
    if (!route) {
      rmSync(file, { force: true });
      this.plannerRoute = undefined;
      return;
    }
    const r = ControlRoute.parse(route);
    writeRecord(file, recordOf(r));
    this.plannerRoute = r;
  }

  info(): ModelInfo {
    const r = this.route ?? (this.awaited ? this.awaited.route : undefined);
    if (r)
      return {
        source: "control",
        name: r.name,
        version: r.version,
        // Awaited: no revision, until the supervisor hands the route again.
        ...(this.route ? { revision: r.revision } : {}),
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

  /** Takes control's route: held in memory, and recorded without its key. */
  set(route: ControlRoute): void {
    const r = ControlRoute.parse(route);
    writeRecord(this.file, recordOf(r));
    this.route = r;
    this.awaited = undefined;
  }

  /** Back to the rig's own settings. */
  clear(): void {
    rmSync(this.file, { force: true });
    this.route = undefined;
    this.awaited = undefined;
  }
}
