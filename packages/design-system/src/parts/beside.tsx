import { type ReactNode, useRef } from "react";
import { useIsMobile } from "../hooks/use-mobile.ts";
import { cn } from "../lib/utils.ts";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "../primitives/sheet.tsx";
import { PaneGutter, usePaneWidth } from "./resize.tsx";
import { BesideFrame } from "./screen-header.tsx";

/**
 * Secondary inspection panel rendered beside the main screen on desktop (with a draggable
 * `PaneGutter`) and as a full-screen `Sheet` on mobile.
 */
export function BesidePanel({
  open = true,
  label = "Detail panel",
  description = "Secondary panel",
  storageKey = "beside",
  storagePrefix,
  minWidth = 320,
  maxWidth,
  defaultWidth = "clamp(22rem, 50%, 50rem)",
  onFull,
  onClose,
  className,
  children,
}: {
  open?: boolean;
  label?: string;
  description?: string;
  storageKey?: string;
  storagePrefix?: string;
  minWidth?: number;
  maxWidth?: number;
  defaultWidth?: string;
  onFull?: () => void;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  const mobile = useIsMobile();
  const aside = useRef<HTMLElement>(null);
  const [width, setWidth] = usePaneWidth(storageKey, storagePrefix);

  if (!open) return null;

  const body = (
    <BesideFrame.Provider value={{ full: onFull, close: onClose }}>
      <div data-beside className="flex min-h-0 flex-1 flex-col">
        {children}
      </div>
    </BesideFrame.Provider>
  );

  if (mobile) {
    return (
      <Sheet open onOpenChange={(next) => !next && onClose()}>
        <SheetContent
          side="right"
          showCloseButton={false}
          className="w-full gap-0 p-0 sm:max-w-none"
        >
          <SheetTitle className="sr-only">{label}</SheetTitle>
          <SheetDescription className="sr-only">{description}</SheetDescription>
          {body}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <aside
      ref={aside}
      aria-label={label}
      className={cn(
        "relative flex max-w-[calc(100%-20rem)] shrink-0 flex-col border-l bg-background print:w-full! print:max-w-none print:border-0",
        className,
      )}
      style={{ width: width ?? defaultWidth }}
    >
      <PaneGutter
        pane={aside}
        label={`Resize ${label}`}
        min={minWidth}
        max={maxWidth}
        home={(row) => Math.min(Math.max(352, row / 2), maxWidth ?? 800)}
        width={width}
        setWidth={setWidth}
        close={onClose}
      />
      {body}
    </aside>
  );
}

/**
 * Container keeping the primary view mounted while a `BesidePanel` opens or closes beside it.
 */
export function BesideHost({
  panel,
  className,
  children,
}: {
  panel?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex min-h-0 flex-1", className)}>
      <div data-chat className="flex min-w-0 flex-1 flex-col">
        {children}
      </div>
      {panel}
    </div>
  );
}
