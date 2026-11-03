/**
 * The names agents and their instructions use for Thermite's tools (goal 166): one home, shared
 * by the harness's tools, the supervisor's advisor tools and the roles' texts in src/agents/roles/.
 */

/** How to write a field note from a shell, for the workers' instructions. */
export const NOTE_USAGE = "thermite-trial note --kind KIND [--about TYPE:ID] TEXT";

/** The teachers' tools that read the run's own research, as the supervisor names them (supervisor/advisors/tools/). */
export const RUN_RESEARCH_TOOLS = {
  list: "list_research",
  source: "read_source",
  file: "read_research_file",
  search: "search_research",
} as const;
