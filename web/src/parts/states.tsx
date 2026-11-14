import { CircleAlertIcon, LoaderCircleIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Act } from "./act.tsx";
import { Thermy } from "./thermy.tsx";

/** Loading, as one line: nothing jumps into place around it. */
export function Loading({ what }: { what: string }) {
  return (
    <p className="flex items-center gap-2 text-quiet">
      <LoaderCircleIcon className="size-4 animate-spin" /> {what}
    </p>
  );
}

/**
 * Something is wrong now, in control's own words, with one way out: a button that leads to the
 * thing, or tries again.
 */
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

/** A read that failed: what control said, and Try again. */
export function Failure({ said, again }: { said: string; again?: () => void }) {
  return <Wrong said={said}>{again && <Act onClick={again}>Try again</Act>}</Wrong>;
}

/** An empty list: Thermy, one line, and the one button that makes the first thing. */
export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-edge px-6 py-10">
      <Thermy />
      <p className="text-center text-soft">{children}</p>
      {action}
    </div>
  );
}

/** "Nothing here", as one quiet sentence, where an empty list needs no button. */
export function Nothing({ children }: { children: ReactNode }) {
  return <p className="text-quiet">{children}</p>;
}
