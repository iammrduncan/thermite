import { CircleAlertIcon, LoaderCircleIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Act } from "./act.tsx";

/** Single-line loading indicator that prevents layout shift. */
export function Loading({ what }: { what: string }) {
  return (
    <p className="flex items-center gap-2 text-quiet">
      <LoaderCircleIcon className="size-4 animate-spin" /> {what}
    </p>
  );
}

/** Error banner with optional recovery action. */
export function Wrong({ said, children }: { said: string; children?: ReactNode }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-4 rounded-xl border border-wrong-edge bg-wrong-tint p-4 font-semibold text-wrong"
    >
      <CircleAlertIcon className="size-4 flex-none" />
      <span className="min-w-0 flex-1">{said}</span>
      {children}
    </div>
  );
}

/** Failed read banner with an optional Try again button. */
export function Failure({ said, again }: { said: string; again?: () => void }) {
  return <Wrong said={said}>{again && <Act onClick={again}>Try again</Act>}</Wrong>;
}

/** An empty state box: optional artwork, a message, and an optional primary action. */
export function Empty({
  art,
  children,
  action,
}: {
  /** Optional illustration or icon above the message. */
  art?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-edge px-6 py-10">
      {art}
      <p className="text-center text-soft">{children}</p>
      {action}
    </div>
  );
}

/** Quiet single-line empty notice where no call-to-action is needed. */
export function Nothing({ children }: { children: ReactNode }) {
  return <p className="text-quiet">{children}</p>;
}
