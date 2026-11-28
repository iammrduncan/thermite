import { Maximize2Icon, XIcon } from "lucide-react";
import { createContext, type ReactNode, useContext } from "react";
import { cn } from "../lib/utils.ts";
import { Button } from "../primitives/button.tsx";
import { SidebarTrigger } from "../primitives/sidebar.tsx";

export interface BesideFrameActions {
  full?: () => void;
  close: () => void;
}

/**
 * Context provided while a view renders inside `BesidePanel`: `ScreenHeader` hides its sidebar
 * toggle and offers full-screen and close buttons instead.
 */
export const BesideFrame = createContext<BesideFrameActions | null>(null);

/** Top bar for full-height app screens and beside panels. */
export function ScreenHeader({
  title,
  lead,
  showSidebarTrigger = true,
  className,
  children,
}: {
  title: ReactNode;
  lead?: ReactNode;
  showSidebarTrigger?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const beside = useContext(BesideFrame);
  return (
    <header
      className={cn(
        "box-content flex h-14 shrink-0 items-center gap-2 px-3 pt-[env(safe-area-inset-top)]",
        className,
      )}
    >
      {!beside && showSidebarTrigger && <SidebarTrigger />}
      {lead}
      <h1 className="min-w-0 flex-1 truncate font-medium">{title}</h1>
      {children}
      {beside && (
        <>
          {beside.full && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Open full screen"
              title="Open full screen"
              onClick={beside.full}
            >
              <Maximize2Icon />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close"
            title="Close"
            onClick={beside.close}
          >
            <XIcon />
          </Button>
        </>
      )}
    </header>
  );
}
