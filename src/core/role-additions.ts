import { z } from "zod";

/**
 * The owner's additions to a role for one campaign (goal 166, the owner's decision 1): text the
 * campaign's owner adds to a role's own instructions, without a change to Thermite's code. They
 * live in the contract, as `role_additions`, one entry for each role, so they are signed into
 * each assignment and versioned with the contract. An addition only adds: the role's text stays
 * whole, comes first, and wins where the two differ. Per role, never per kit.
 */

/**
 * The roles a campaign of each mode runs, by their ids in src/agents/roles/: the ones an addition
 * may name. The model check and compaction take none: they belong to no campaign.
 */
export const ADDITION_ROLES = {
  code: ["worker", "planner", "teacher", "merged-by", "auditor", "reviewer"],
  research: [
    "research-worker",
    "research-planner",
    "research-teacher",
    "research-merged-by",
    "research-reviewer",
    "synthesizer",
    "final-writer",
  ],
} as const;

/** Every role an addition may name, whatever the mode. */
export const ALL_ADDITION_ROLES = [...ADDITION_ROLES.code, ...ADDITION_ROLES.research] as const;
export type AdditionRole = (typeof ALL_ADDITION_ROLES)[number];

/** The most characters of one addition: it goes whole into every prompt of its role. */
export const ROLE_ADDITION_MAX_CHARS = 20_000;

/** The contract's field: the role's id, and its addition. */
export const RoleAdditions = z.partialRecord(
  z.enum(ALL_ADDITION_ROLES),
  z
    .string()
    .trim()
    .min(1, "an addition is not empty: leave the role out instead")
    .max(
      ROLE_ADDITION_MAX_CHARS,
      `an addition has at most ${ROLE_ADDITION_MAX_CHARS.toLocaleString("en-US")} characters`,
    ),
);
export type RoleAdditions = z.infer<typeof RoleAdditions>;

/**
 * The additions a request or a form gives, as the contract keeps them: each text trimmed, and an
 * empty one left out. Undefined when none is left.
 */
export function requestedAdditions(
  given: Record<string, string> | undefined,
): RoleAdditions | undefined {
  const kept = Object.entries(given ?? {})
    .map(([role, text]) => [role, text.trim()] as const)
    .filter(([, text]) => text !== "");
  return kept.length ? (Object.fromEntries(kept) as RoleAdditions) : undefined;
}

/** The roles a campaign of a mode runs, an addition may name. */
export const additionRolesOf = (mode: string): readonly AdditionRole[] =>
  mode === "research" ? ADDITION_ROLES.research : ADDITION_ROLES.code;

/** Why each role named is one a campaign of this mode never runs, in words; empty when none is. */
export function additionRefusals(mode: string, additions: RoleAdditions | undefined): string[] {
  const runs = additionRolesOf(mode);
  return Object.keys(additions ?? {})
    .filter((role) => !(runs as readonly string[]).includes(role))
    .map(
      (role) =>
        `a ${mode.replace("_", " ")} campaign runs no ${role}: its roles are ${runs.join(", ")}`,
    );
}

/** One role's addition as a run's prompt takes it: its text, and the contract's version. */
export interface OwnerAddition {
  text: string;
  version: number;
}

/** A role's addition in a contract, with the contract's version; undefined when it has none. */
export function additionOf(
  contract: { version: number; role_additions?: RoleAdditions | undefined } | undefined,
  role: string,
): OwnerAddition | undefined {
  const text = contract?.role_additions?.[role as AdditionRole];
  return text ? { text, version: contract.version } : undefined;
}

/** A contract's additions as the advisors' list of runs carries them; null: it has none. */
export function additionsOf(
  contract: { version: number; role_additions?: RoleAdditions | undefined } | undefined,
): { version: number; roles: Record<string, string> } | null {
  const roles = contract?.role_additions;
  return contract && roles && Object.keys(roles).length
    ? { version: contract.version, roles: roles as Record<string, string> }
    : null;
}

/** A run's additions as the advisors' list of runs carries them (additionsOf). */
export type RunAdditions = ReturnType<typeof additionsOf> | undefined;

/** One role's addition in a run's additions; undefined when it has none. */
export function additionIn(row: RunAdditions, role: string): OwnerAddition | undefined {
  const text = row?.roles[role];
  return row && text ? { text, version: row.version } : undefined;
}
