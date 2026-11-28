import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils.ts";

/** One line of a tree: an expandable folder or a file. */
export interface TreeItem {
  id: string;
  name: string;
  /** Depth level: 1 at the top. */
  level: 1 | 2 | 3;
  /** Folder open/closed state; undefined for files. */
  open?: boolean;
  /** Optional item count label. */
  count?: string;
}

/** Indentation per depth level (16 px step). */
const INDENT = { 1: "pl-2", 2: "pl-6", 3: "pl-10" } as const;

/** A tree of folders and files, highlighting the active row in the brand accent tint. */
export function Tree({
  label,
  items,
  chosen,
  onChoose,
}: {
  label: string;
  items: TreeItem[];
  chosen?: string;
  onChoose: (id: string) => void;
}) {
  return (
    <div className="rounded-xl border bg-card p-2">
      <div role="tree" aria-label={label} className="flex flex-col">
        {items.map((item) => {
          const folder = item.open !== undefined;
          const picked = item.id === chosen;
          const Folder = item.open ? FolderOpenIcon : FolderIcon;
          const Chevron = item.open ? ChevronDownIcon : ChevronRightIcon;
          return (
            <button
              key={item.id}
              type="button"
              role="treeitem"
              aria-level={item.level}
              aria-expanded={folder ? item.open : undefined}
              aria-selected={picked}
              onClick={() => onChoose(item.id)}
              className={cn(
                "flex h-8 items-center gap-2 rounded-md pr-2 text-left outline-none hover:bg-chosen focus-visible:ring-2 focus-visible:ring-ring",
                INDENT[item.level],
                picked &&
                  "bg-brand-accent-tint font-semibold text-brand-accent hover:bg-brand-accent-tint",
              )}
            >
              {folder ? (
                <Chevron className="size-3.5 flex-none text-quiet" />
              ) : (
                <span className="w-3.5 flex-none" />
              )}
              {folder ? (
                <Folder
                  className={cn(
                    "size-4 flex-none",
                    picked ? "text-brand-accent" : "text-brand-mark",
                  )}
                />
              ) : (
                <FileTextIcon
                  className={cn("size-4 flex-none", picked ? "text-brand-accent" : "text-quiet")}
                />
              )}
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              {item.count && (
                <span className="text-xs font-normal text-quiet tabular-nums">{item.count}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Two-column responsive split: an aside beside main content that stacks on narrow screens. */
export function Split({
  aside,
  wide = false,
  children,
}: {
  aside: ReactNode;
  /** Slightly wider aside column for hierarchical trees. */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start gap-6">
      <aside
        className={cn(
          "min-w-0",
          wide ? "max-w-[360px] flex-[1_1_280px]" : "max-w-[320px] flex-[1_1_240px]",
        )}
      >
        {aside}
      </aside>
      <div className="flex min-w-0 flex-[999_1_480px] flex-col gap-4">{children}</div>
    </div>
  );
}
