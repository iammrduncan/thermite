import { LoaderCircleIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** Loading, as one line: nothing jumps into place around it. */
export function Loading({ what }: { what: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <LoaderCircleIcon className="size-4 animate-spin" /> {what}
    </p>
  );
}

/** A failure in control's own words, beside what failed, with a way out. */
export function Failure({ said, again }: { said: string; again?: () => void }) {
  return (
    <div className="grid gap-2">
      <p role="alert" className="text-sm text-destructive">
        {said}
      </p>
      {again && (
        <Button variant="outline" size="sm" className="justify-self-start" onClick={again}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** "Nothing here", as one sentence that says what to do. */
export function Nothing({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}
