import type { NumberSpec } from "../common/settings.ts";

/**
 * The command line's number settings (goal 125, T4), as control's, the harness's and the
 * supervisor's are kept: the docs check holds the settings page to them.
 */
export const CLI_NUMBERS = {
  controlPort: {
    name: "THERMITE_CONTROL_PORT",
    rule: { integer: true, min: 1, max: 65535 },
    fallback: 8800,
  },
} satisfies Record<string, NumberSpec>;
