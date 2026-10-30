import type { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "../schema/index.ts";
import { PROMPT_TABLE, PROMPT_TURN_COLUMN } from "./prompts.ts";
import { eventRunColumn } from "./runs.ts";
import { TRIAL_PROXY_TOKENS } from "./trials.ts";

/**
 * Every ledger migration, in order: schema.ts's, then the ones since, here, so schema.ts no longer
 * grows (goal 125). A change to the schema is a new entry at the end, never an edit of one that
 * has run.
 */
export const LEDGER_MIGRATIONS: readonly (string | ((db: DatabaseSync) => void))[] = [
  ...MIGRATIONS,
  // 22: the agents' public names (goal 125, T1): the owner's messages to the review panel, and
  // its reads of them, named it `panel`. Events keep their words; core/names.ts reads them under
  // the new ones.
  `
  update agent_message set target = 'review_panel' where target = 'panel';
  update agent_message_read set reader = 'review_panel' where reader = 'panel';
  `,
  // 23: each event's run (goal 170), worked out for the events already recorded.
  eventRunColumn,
  // 24: the whole text of every prompt a run's agents were sent (goal 166).
  PROMPT_TABLE,
  // 25: which turn of its call each prompt was: the later turns are kept too (goal 166).
  PROMPT_TURN_COLUMN,
  // 26: the tokens the model proxy saw of each trial through it, which a run's budget counts.
  TRIAL_PROXY_TOKENS,
];
