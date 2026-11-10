import type { Tone } from "@core/api/control/dashboard.ts";

/**
 * The four colours of a state, and grey: the only colours a screen takes its meaning from
 * (docs/plan/ui-refresh-guide.md, the rules for screens). The class names are written out whole,
 * since Tailwind reads them from the source.
 */
export const toneText: Record<Tone, string> = {
  good: "text-good",
  needs: "text-needs",
  wrong: "text-wrong",
  working: "text-working",
  none: "text-muted-foreground",
};

export const toneBadge: Record<Tone, string> = {
  good: "bg-good/10 text-good",
  needs: "bg-needs/10 text-needs",
  wrong: "bg-wrong/10 text-wrong",
  working: "bg-working/10 text-working",
  none: "bg-muted text-muted-foreground",
};

export const toneDot: Record<Tone, string> = {
  good: "bg-good",
  needs: "bg-needs",
  wrong: "bg-wrong",
  working: "bg-working",
  none: "bg-muted-foreground/40",
};
