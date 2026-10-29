import { randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * Names and IDs every part checks the same way (goal 125, T1).
 */

/**
 * A rig's name: what every place a rig runs takes, in a Kubernetes namespace (`thermite-<rig>`),
 * a compose service or a machine's units.
 */
export const RIG_ID = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

/** What a rig's name takes, in words. */
export const RIG_ID_WORDS =
  "a rig's name is 2 to 40 characters of a-z, 0-9 and -, starting and ending with a letter or digit";

/** The same, as a sentence on a page. */
export const RIG_ID_SENTENCE = `A${RIG_ID_WORDS.slice(1)}.`;

/**
 * A campaign's or a run's name (goal 170): up to 64 lowercase letters, digits, - and _, starting
 * with a letter or digit. No dot: a message bus's subject splits on one. A repository's, a kit's
 * and a case's names keep theirs (core/contract.ts's IdSchema).
 */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const NAME_WORDS =
  "lowercase letters, digits, dashes and underscores, at most 64, starting with a letter or a digit";
export const CampaignId = z.string().regex(NAME_PATTERN, `a campaign's name is ${NAME_WORDS}`);
export const RunId = z.string().regex(NAME_PATTERN, `a run's name is ${NAME_WORDS}`);

/**
 * The campaigns of the smoke checks a rig runs when control sets it up: the harness names them
 * with this prefix, control hides them on the Campaigns list by default, and no other campaign may
 * take a name that starts with it.
 */
export const RIG_CHECK_PREFIX = "rig-check-";
export const isRigCheck = (name: string): boolean => name.startsWith(RIG_CHECK_PREFIX);

/**
 * A run's things, each with its own ID that is unique where it is used (goal 170): an attempt
 * (`a-`), a trial (`t-`) and an experiment in the run's queue (`x-`), each minted where it is
 * made, from random bytes.
 */
export const newAttemptId = (): string => `a-${randomBytes(8).toString("hex")}`;

/** A trial's ID: `t-` and 16 hex digits. */
export const TRIAL_ID = /^t-[0-9a-f]{16}$/;
export const newTrialId = (): string => `t-${randomBytes(8).toString("hex")}`;

/** An experiment's ID in a run's queue (goal 064): `x-` and 12 hex digits. */
export const EXPERIMENT_ID = /^x-[0-9a-f]{12}$/;
export const ExperimentId = z.string().regex(EXPERIMENT_ID, "an experiment id (x-...)");
export const newExperimentId = (): string => `x-${randomBytes(6).toString("hex")}`;

/** A pattern's body without its anchors, to match it inside another one. */
export const inner = (pattern: RegExp): string => pattern.source.replace(/^\^|\$$/g, "");

/**
 * The most lanes a rig can run: its harness image has a user for each of lanes 1 to 16
 * (containers/harness/Containerfile; IDS.maxLanes in src/harness/broker/runner.ts). A contract's
 * lanes.count, a rig's workers at a time and the campaign builder refuse more, with this reason.
 */
export const MAX_LANES = 16;
export const MAX_LANES_REASON = `at most ${MAX_LANES}: a rig has users for lanes 1 to ${MAX_LANES} only`;
