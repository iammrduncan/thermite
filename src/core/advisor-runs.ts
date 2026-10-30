import { z } from "zod";
import { joinPath } from "./paths.ts";

/**
 * Advisor programs as users of their own: the contract between the supervisor and the small root
 * helper that runs each advisor program (Claude Code, OpenCode, the Codex CLI, a `cli` advisor's
 * command) as an advisor user, never as the supervisor's own user. One JSON object per line each
 * way, over a Unix socket that only root and the supervisor's group may open
 * (src/common/run-as/).
 *
 * A run gets only what its request carries: its prompt (stdin), its environment (its model
 * route's address and the call's own credentials) and its folder, which the helper hands to the
 * run's user for the run. The supervisor's tokens, keys, seeds and state stay with the
 * supervisor's user.
 */

/**
 * The advisor users: uid and gid `base + n`, n from 1 to `count`. The helper gives each run a user
 * no other run has while it runs, so that the run's end can kill every process of its user.
 */
export const ADVISOR_USERS = { base: 10080, count: 8 } as const;

/**
 * Where the helper serves (root's folder for it, which only the supervisor's group may enter), and
 * the settings it gives the supervisor it starts: its socket, and its root, the folder in which
 * the supervisor makes each run's folder. The supervisor image's entry and, in the one-container
 * rig image, the broker serve it; without THERMITE_ADVISOR_SOCKET the supervisor runs its
 * advisors' programs as its own user, and says so.
 */
export const ADVISOR_RUNS_SOCKET = "/run/thermite-advisors/runs.sock";
export const ADVISOR_RUNS_ENV = {
  socket: "THERMITE_ADVISOR_SOCKET",
  root: "THERMITE_ADVISOR_RUNS_DIR",
} as const;

/**
 * The runs' root: `thermite-advisors` beside the supervisor's state folder, out of it (its state is
 * closed to the advisor users), on the container's own disk: /var/lib/thermite-advisors in the
 * supervisor image, /var/lib/thermite-rig/thermite-advisors in the one-container rig image.
 */
export const advisorRunsDir = (supervisorHome: string): string =>
  joinPath(supervisorHome, "..", "thermite-advisors");

/** The most a run's request and answer carry: its stdin and environment, and its output kept. */
export const ADVISOR_RUN_LIMITS = {
  /** A request's line, its stdin and its environment included. */
  requestBytes: 16 * 1024 * 1024,
  stdinBytes: 8 * 1024 * 1024,
  envBytes: 64 * 1024,
  /** The tail of stdout kept, in characters (an advisor's JSON events and its answer). */
  stdoutChars: 4_000_000,
  stderrChars: 20_000,
  /** A run's time, when its request gives one: one day at most. */
  timeoutMs: 24 * 60 * 60 * 1000,
  /**
   * The most entries of a run's folder given back to the caller once the run has ended; the rest
   * stay its user's until the folder is removed.
   */
  handBackEntries: 100_000,
} as const;

const Id = z.number().int().nonnegative();
/** A run's folder: an absolute path, which the helper checks is one of its root's children. */
const Folder = z.string().startsWith("/").max(4096);

export const AdvisorRunRequest = z.discriminatedUnion("op", [
  z.object({
    id: Id,
    op: z.literal("run"),
    dir: Folder,
    /**
     * The program, then its arguments. An argument may be empty, as Claude Code's `--tools ""`
     * and `--setting-sources ""` are; the program's name may not.
     */
    argv: z
      .array(z.string().max(64 * 1024))
      .min(1)
      .max(256)
      .refine((a) => (a[0] ?? "") !== "", "the program's name is empty"),
    env: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string())
      .refine(
        (e) => JSON.stringify(e).length <= ADVISOR_RUN_LIMITS.envBytes,
        "the environment is too large",
      ),
    stdin: z.string().max(ADVISOR_RUN_LIMITS.stdinBytes),
    /** Written to the program's file descriptor 3, then closed (Claude Code's sign-in token). */
    token: z
      .string()
      .max(64 * 1024)
      .optional(),
    /** None: the run ends with its program. */
    timeoutMs: z.number().int().positive().max(ADVISOR_RUN_LIMITS.timeoutMs).optional(),
  }),
  /** The folder of a run that ended, removed with all its run's user left in it. */
  z.object({ id: Id, op: z.literal("remove"), dir: Folder }),
]);
export type AdvisorRunRequest = z.infer<typeof AdvisorRunRequest>;

/** How a run ended: its user (n of ADVISOR_USERS), its exit, and its output's tails. */
export const AdvisorRunOutcome = z.object({
  user: z.number().int().min(0).max(ADVISOR_USERS.count),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
});
export type AdvisorRunOutcome = z.infer<typeof AdvisorRunOutcome>;

export type AdvisorRunAnswer =
  | { id: number; ok: true; result: AdvisorRunOutcome | null }
  | { id: number; ok: false; error: string };
