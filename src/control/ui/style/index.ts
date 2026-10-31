import { BARS } from "./bars.ts";
import { BASE } from "./base.ts";
import { DECISIONS } from "./decisions.ts";
import { FORMS } from "./forms.ts";
import { KNOWLEDGE } from "./knowledge.ts";
import { LAYOUT } from "./layout.ts";
import { LISTS } from "./lists.ts";
import { LIVE } from "./live.ts";
import { PANELS } from "./panels.ts";
import { PLANNER } from "./planner.ts";
import { RIG } from "./rig.ts";
import { RUNPOD } from "./runpod.ts";
import { RUNS } from "./runs.ts";
import { SESSION } from "./session.ts";
import { SHELL } from "./shell.ts";
import { SURFACES } from "./surfaces.ts";
import { TABLES } from "./tables.ts";
import { TIMELINE } from "./timeline.ts";
import { USAGE } from "./usage.ts";

/**
 * The dashboard's stylesheet. It follows Magnesium's design (the owner's agent UI, built on
 * T3 Code's tokens): a quiet zinc palette, an indigo primary, system fonts, 10 px card radius,
 * dense 11-12 px metadata, emerald / amber / red status colours, and a near-black dark theme
 * with hairline borders.
 *
 * Each part of the sheet is a module in style/. They join here in the cascade's order, so a later
 * rule wins over an earlier one of the same weight: keep a rule in its part, and a part in its
 * place.
 */
export const STYLE = `
${BASE}

${SHELL}

${LAYOUT}

${SURFACES}

${BARS}

${TABLES}

${DECISIONS}

${RUNS}

${RIG}

${TIMELINE}

${SESSION}
${FORMS}
${LISTS}
${PANELS}
${LIVE}
${PLANNER}
${KNOWLEDGE}
${RUNPOD}
${USAGE}
`;
