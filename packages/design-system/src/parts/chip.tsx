import type { ReactNode } from "react";
import { cn } from "../lib/utils.ts";
import { type State, type Tone, toneChip, toneChipDot, toneMark } from "./tone.ts";

/** A state as a chip: a dot and control's word for it, in the state's colour on its tint. */
export function Chip({ state, className }: { state: State; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 flex-none items-center gap-1.5 rounded-full px-2 text-xs font-semibold whitespace-nowrap",
        toneChip[state.tone],
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full", toneChipDot[state.tone])} />
      {state.word}
    </span>
  );
}

/** A dot alone, where a word has no room. With a label, it says its state to a screen reader. */
export function Dot({
  tone,
  label,
  className,
}: {
  tone: Tone;
  label?: string;
  className?: string;
}) {
  const looks = cn("inline-block size-2 flex-none rounded-full", toneMark[tone], className);
  return label ? (
    <span role="img" aria-label={label} className={looks} />
  ) : (
    <span aria-hidden="true" className={looks} />
  );
}

/** A count that waits for the owner. */
export function Count({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-5 min-w-5 flex-none items-center justify-center rounded-full bg-needs-tint px-1 text-xs font-semibold text-needs tabular-nums">
      {children}
    </span>
  );
}

/** A picture's legend: a dot, its word, and how many. */
export function Legend({ items }: { items: { tone: Tone; word: string; count?: number }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-soft">
      {items.map((i) => (
        <li key={i.word} className="inline-flex items-center gap-2">
          <Dot tone={i.tone} />
          {i.word}
          {i.count !== undefined && <span className="text-quiet tabular-nums">{i.count}</span>}
        </li>
      ))}
    </ul>
  );
}
