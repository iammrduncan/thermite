import type { Tone } from "@core/api/control/dashboard.ts";

/**
 * A state's colours (the brand guide's states): good, working, needs you, wrong, and "none",
 * which says nothing. A state always has a word or a shape beside its colour. The class names are
 * written out whole, since Tailwind reads them from the source.
 */

/** The state's colour as text, an icon or an arrow. */
export const toneText: Record<Tone, string> = {
  good: "text-good",
  needs: "text-needs",
  wrong: "text-wrong",
  working: "text-working",
  none: "text-quiet",
};

/** A chip: the state's tint behind its colour. */
export const toneChip: Record<Tone, string> = {
  good: "bg-good-tint text-good",
  needs: "bg-needs-tint text-needs",
  wrong: "bg-wrong-tint text-wrong",
  working: "bg-working-tint text-working",
  none: "bg-idle-tint text-idle",
};

/** The dot inside a chip. */
export const toneChipDot: Record<Tone, string> = {
  good: "bg-good",
  needs: "bg-needs",
  wrong: "bg-wrong",
  working: "bg-working",
  none: "bg-idle-dot",
};

/** A dot alone, a bar's part, a line of a picture. */
export const toneMark: Record<Tone, string> = {
  good: "bg-good",
  needs: "bg-needs",
  wrong: "bg-wrong",
  working: "bg-working",
  none: "bg-idle-mark",
};

/** The same, for a line or an area drawn in a picture. */
export const toneStroke: Record<Tone, string> = {
  good: "stroke-good fill-good",
  needs: "stroke-needs fill-needs",
  wrong: "stroke-wrong fill-wrong",
  working: "stroke-working fill-working",
  none: "stroke-idle fill-idle",
};

/** A part of a bar or of a band of records: "says nothing" is paler there than a dot alone. */
export const toneBar: Record<Tone, string> = {
  good: "bg-good fill-good",
  needs: "bg-needs fill-needs",
  wrong: "bg-wrong fill-wrong",
  working: "bg-working fill-working",
  none: "bg-idle-bar fill-idle-bar",
};
