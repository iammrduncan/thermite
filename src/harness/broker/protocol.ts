import { z } from "zod";
import { RoleSchema, RunRequest } from "./runner.ts";

/**
 * The broker's socket protocol: one JSON object per line in each direction. Only the
 * controller's user (and root) can open the socket; the broker still validates every request.
 */

export const BrokerRequest = z.discriminatedUnion("op", [
  z.object({ id: z.number().int(), op: z.literal("run"), req: RunRequest }),
  z.object({
    id: z.number().int(),
    op: z.literal("runPair"),
    driver: RunRequest,
    candidate: RunRequest,
  }),
  z.object({
    id: z.number().int(),
    op: z.literal("handOver"),
    path: z.string(),
    role: RoleSchema,
    harnessReads: z.boolean().optional(),
  }),
  z.object({ id: z.number().int(), op: z.literal("reclaim"), path: z.string() }),
  z.object({ id: z.number().int(), op: z.literal("remove"), path: z.string() }),
  z.object({
    id: z.number().int(),
    op: z.literal("killRole"),
    role: RoleSchema,
    gpu: z.boolean().optional(),
  }),
]);
export type BrokerRequest = z.infer<typeof BrokerRequest>;

export type BrokerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };
