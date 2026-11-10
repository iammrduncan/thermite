import type { Tone } from "@core/api/control/dashboard.ts";
import { cn } from "@/lib/utils";
import { toneText } from "./tone.ts";

/** One figure and what it counts. A row of them opens a screen that is read at a glance. */
export function Tile({
  figure,
  label,
  tone = "none",
}: {
  figure: string;
  label: string;
  tone?: Tone;
}) {
  return (
    <div className="grid gap-0.5 rounded-xl border p-3">
      <span className={cn("text-2xl font-medium tabular-nums", tone !== "none" && toneText[tone])}>
        {figure}
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

/** A row of tiles: two across in a narrow column, four in a wider one. */
export function Tiles({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 @xl:grid-cols-4">{children}</div>;
}
