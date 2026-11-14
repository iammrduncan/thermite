import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils.ts";

/** One line of a tree: a folder, open or closed, or a file. */
export interface TreeItem {
  id: string;
  name: string;
  /** How deep it is: 1 at the top. */
  level: 1 | 2 | 3;
  /** A folder that is open or closed; a file when not given. */
  open?: boolean;
  /** How many things it holds. */
  count?: string;
}

/** The space before a line, by its level: 16 px a level. */
const INDENT = { 1: "pl-2", 2: "pl-6", 3: "pl-10" } as const;

/**
 * A tree of folders and files, as the knowledge base is: a collection for each campaign, its
 * runs, their writers, the items. Every line has an icon; what is chosen is in the flame's tint.
 */
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
                picked && "bg-flame-tint font-semibold text-flame hover:bg-flame-tint",
              )}
            >
              {folder ? (
                <Chevron className="size-3.5 flex-none text-quiet" />
              ) : (
                <span className="w-3.5 flex-none" />
              )}
              {folder ? (
                <Folder className={cn("size-4 flex-none", picked ? "text-flame" : "text-ember")} />
              ) : (
                <FileTextIcon
                  className={cn("size-4 flex-none", picked ? "text-flame" : "text-quiet")}
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

/**
 * The split of a tool: a list or a tree beside what is picked in it. Only a tool has two
 * columns; on a narrow screen what is picked goes under the list.
 */
export function Split({
  aside,
  wide = false,
  children,
}: {
  aside: ReactNode;
  /** The tree's split: its aside is a little wider than the explorer's. */
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
