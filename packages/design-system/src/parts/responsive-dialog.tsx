import type { ReactNode } from "react";
import { cn } from "../lib/utils.ts";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../primitives/dialog.tsx";

/**
 * Centered dialog on desktop (`sm:max-w-2xl`, `max-h-[90dvh]`) that expands into a full-viewport
 * `dvh` sheet on narrow phones with top safe-area padding (`Sheetish` pattern).
 */
export function ResponsiveDialog({
  open,
  onOpenChange,
  title,
  description,
  showCloseButton = true,
  className,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  showCloseButton?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={showCloseButton}
        className={cn(
          "max-h-[90dvh] overflow-y-auto sm:max-w-2xl max-sm:h-dvh max-sm:max-h-dvh max-sm:max-w-full max-sm:content-start max-sm:rounded-none max-sm:pt-[max(1rem,env(safe-area-inset-top))]",
          className,
        )}
      >
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
        {children}
      </DialogContent>
    </Dialog>
  );
}
