import { cn } from "@/lib/utils";

/** A campaign's avatar: two letters for its mode, in the mode's colour. */
const MODES: Record<string, { letters: string; cls: string }> = {
  hill_climb: { letters: "HC", cls: "bg-chart-1/15 text-chart-1" },
  goal: { letters: "GL", cls: "bg-chart-4/15 text-chart-4" },
  research: { letters: "RS", cls: "bg-chart-2/15 text-chart-2" },
};

export function ModeAvatar({ mode, className }: { mode: string | null; className?: string }) {
  const m = MODES[mode ?? ""] ?? { letters: "··", cls: "bg-muted text-muted-foreground" };
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-[0.625rem] font-semibold",
        m.cls,
        className,
      )}
    >
      {m.letters}
    </span>
  );
}
