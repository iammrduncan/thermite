import type { StateWord } from "@core/api/control/dashboard.ts";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { toneBadge } from "./tone.ts";

/** A state as one badge: control's word for it, in its colour. The one look a state has. */
export function StatusBadge({ state, className }: { state: StateWord; className?: string }) {
  return (
    <Badge variant="secondary" className={cn(toneBadge[state.tone], className)}>
      {state.word}
    </Badge>
  );
}
