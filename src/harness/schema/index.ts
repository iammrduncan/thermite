import type { DatabaseSync } from "node:sqlite";
import { BEFORE_THE_RENAME } from "./before-rename.ts";
import { FIRST_TABLES } from "./first.ts";
import { SINCE_THE_RENAME } from "./since-rename.ts";

/**
 * Ledger migrations. Each entry runs once, in order, inside a transaction.
 * Append-only tables are enforced with triggers, not by convention.
 */
export const MIGRATIONS: readonly (string | ((db: DatabaseSync) => void))[] = [
  // 1: the ledger's first tables (schema/first.ts).
  FIRST_TABLES,
  // 2 to 9 (schema/before-rename.ts).
  ...BEFORE_THE_RENAME,
  // 10 to 21: the owner's names, and the migrations since (schema/since-rename.ts).
  ...SINCE_THE_RENAME,
];
