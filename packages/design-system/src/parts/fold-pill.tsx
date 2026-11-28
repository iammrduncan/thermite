import { ChevronRightIcon, LoaderCircleIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "../lib/utils.ts";

/**
 * Compact centered pill that either unfolds inline content or triggers a side-panel action.
 * Ported from fxbot's `Fold` / `PillEntry` pattern without app-specific store coupling.
 */
export function FoldPill({
  label,
  leading,
  busy = false,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  onAction,
  className,
  children,
}: {
  label: ReactNode;
  /** Optional avatars, plugin icon, or status glyph on the left of the pill. */
  leading?: ReactNode;
  busy?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** When provided, clicking invokes this callback instead of expanding inline `children`. */
  onAction?: () => void;
  className?: string;
  children?: ReactNode;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isOpen = controlledOpen ?? uncontrolledOpen;
  const external = Boolean(onAction);

  function toggle() {
    if (onAction) {
      onAction();
      return;
    }
    const next = !isOpen;
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }

  return (
    <div className={cn("grid gap-3", className)}>
      <button
        type="button"
        aria-expanded={external ? undefined : isOpen}
        onClick={toggle}
        className="mx-auto flex max-w-full items-center gap-1.5 rounded-full border bg-muted py-1 pr-3 pl-2 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        {leading}
        {busy && <LoaderCircleIcon className="size-3 shrink-0 animate-spin" />}
        <span className="min-w-0 truncate">{label}</span>
        <ChevronRightIcon
          className={cn("size-3 shrink-0 transition-transform", !external && isOpen && "rotate-90")}
        />
      </button>
      {!external && isOpen && children}
    </div>
  );
}
