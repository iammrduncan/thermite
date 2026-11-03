import { z } from "zod";
import type { Route } from "../route.ts";

/**
 * Control's API for the agents' roles and the prompts a run's agents were sent (goal 166; src/
 * control/api/agents.ts answers it): each role's definition, and a run's prompts by its name
 * alone, wherever it ran. The owner's routes, read only.
 */

/** Every role Thermite runs: what each does, its model and programs, and its render function. */
export const AGENT_ROLES = {
  method: "GET",
  path: "/v1/agents",
  answer: z.looseObject({ roles: z.array(z.looseObject({ id: z.string() })) }),
} as const satisfies Route;

/** One role's definition, with its fixed texts whole. */
export const AGENT_ROLE = {
  method: "GET",
  path: "/v1/agents/:role",
  answer: z.looseObject({ id: z.string(), texts: z.array(z.unknown()) }),
} as const satisfies Route;

/** A run's prompts, oldest first: each one's role, program, lane, trial or call, and sections. */
export const RUN_PROMPTS = {
  method: "GET",
  path: "/v1/runs/:run/prompts",
  answer: z.looseObject({ run: z.string(), prompts: z.array(z.looseObject({ id: z.number() })) }),
} as const satisfies Route;

/** One of a run's prompts, by its number: each section with its source and its text. */
export const RUN_PROMPT = {
  method: "GET",
  path: "/v1/runs/:run/prompts/:id",
  answer: z.looseObject({ id: z.number(), sections: z.array(z.unknown()) }),
} as const satisfies Route;
