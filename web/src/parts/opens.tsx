import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { Act } from "./act.tsx";

/** One line of a menu. The red one loses work, and is last. */
export interface MenuLine {
  label: string;
  icon: LucideIcon;
  red?: boolean;
  onChoose: () => void;
}

/** A menu for rare acts: at most 7 lines, the red one last. It opens from the button given. */
export function Menu({ lines, children }: { lines: MenuLine[]; children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-[216px] rounded-md border border-edge px-0 py-2 ring-0"
      >
        {lines.slice(0, 7).map((l) => (
          <DropdownMenuItem
            key={l.label}
            onSelect={l.onChoose}
            className={cn(
              "h-9 gap-2 rounded-none px-4 text-sm [&_svg]:size-4",
              l.red
                ? "text-wrong focus:bg-wrong-tint focus:text-wrong [&_svg]:text-wrong"
                : "[&_svg]:text-quiet",
            )}
          >
            <l.icon />
            {l.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The one dialog: a question where work is lost and cannot come back. A title, at most two
 * sentences, and two buttons: the one that keeps things first, the one that loses work last.
 */
export function Confirm({
  open,
  onOpenChange,
  title,
  text,
  keep,
  lose,
  onLose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  text: string;
  /** The button that keeps things: "Keep it running". */
  keep: string;
  /** The button that loses work: "Close the run". */
  lose: string;
  onLose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        role="alertdialog"
        showCloseButton={false}
        data-screen="dialog"
        className="max-w-[440px] gap-4 rounded-xl border border-edge p-6 shadow-dialog ring-0 sm:max-w-[440px]"
      >
        <DialogTitle className="text-base font-semibold">{title}</DialogTitle>
        <DialogDescription className="text-sm text-soft">{text}</DialogDescription>
        <DialogFooter className="mx-0 mb-0 flex-row justify-end gap-2 border-0 bg-transparent p-0">
          <Act onClick={() => onOpenChange(false)}>{keep}</Act>
          <Act
            look="red"
            onClick={() => {
              onLose();
              onOpenChange(false);
            }}
          >
            {lose}
          </Act>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What was done, in one line, with Undo: for an act that can be undone, in place of a question. */
export function Undo({ children, onUndo }: { children: ReactNode; onUndo: () => void }) {
  return (
    <div
      role="status"
      className="inline-flex h-10 items-center gap-4 rounded-md bg-toast px-4 text-sm text-toast-foreground"
    >
      {children}
      <button
        type="button"
        onClick={onUndo}
        className="rounded-sm font-semibold underline underline-offset-[3px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Undo
      </button>
    </div>
  );
}
