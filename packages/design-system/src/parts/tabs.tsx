import type { MouseEvent } from "react";
import { cn } from "../lib/utils.ts";

/** One tab: a part of one thing. It leads to an address, or is chosen in place. */
export interface Tab {
  id: string;
  label: string;
  href?: string;
  /** What a pointer's rest says, such as where a tab still opens. */
  title?: string;
}

/** The parts of one thing, as tabs: the chosen one in 600 with a flame line under it. */
export function Tabs({
  label,
  tabs,
  chosen,
  onChoose,
}: {
  label: string;
  tabs: readonly Tab[];
  chosen: string;
  onChoose?: (id: string, event: MouseEvent<HTMLElement>) => void;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-x-6 border-b">
      {tabs.map((t) => {
        const picked = t.id === chosen;
        const looks = cn(
          "inline-flex h-9 items-center border-b-2 text-sm outline-none focus-visible:text-flame",
          picked
            ? "border-flame font-semibold text-foreground"
            : "border-transparent text-quiet hover:text-foreground",
        );
        return t.href !== undefined ? (
          <a
            key={t.id}
            role="tab"
            aria-selected={picked}
            href={t.href}
            title={t.title}
            onClick={(e) => onChoose?.(t.id, e)}
            className={looks}
          >
            {t.label}
          </a>
        ) : (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={picked}
            title={t.title}
            onClick={(e) => onChoose?.(t.id, e)}
            className={looks}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
