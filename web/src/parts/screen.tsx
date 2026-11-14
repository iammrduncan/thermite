import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A kind of screen, which sets the budget of its first view (the browser check holds each screen
 * to its kind's: scripts/acceptance/lib/browser-budget.mjs).
 */
type ScreenKind = "home" | "list" | "detail" | "form" | "dialog" | "explore" | "tool";

/** A step of where a screen is: the thing it belongs to, as a link. */
interface Crumb {
  label: string;
  href: string;
  title?: string;
  onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void;
}

/**
 * A screen: where it is, its name, its state, its buttons with the flame one last, its tabs,
 * then its one sentence, the largest text on it. Under that, its blocks in one column.
 *
 * The top is frame: the budget counts only what is under it.
 */
export function Screen({
  kind,
  title,
  crumbs = [],
  state,
  actions,
  tabs,
  sentence,
  children,
}: {
  /** None for a screen not yet built from its board: it has no budget. */
  kind?: ScreenKind;
  /** The screen's own name, last in where it is. */
  title: ReactNode;
  crumbs?: Crumb[];
  /** The thing's state, as a chip beside its name. */
  state?: ReactNode;
  /** At most three buttons and the main one, which is last. */
  actions?: ReactNode;
  tabs?: ReactNode;
  /** The state of the thing in one sentence of at most 20 words. */
  sentence?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="flex-1 overflow-y-auto p-4 md:px-10 md:pt-6 md:pb-26">
      <div className="@container mx-auto flex max-w-[960px] flex-col gap-4 md:gap-10">
        <header className="flex flex-col gap-4">
          <div className="flex min-h-9 flex-wrap items-center gap-2">
            {crumbs.map((c) => (
              <span key={c.href} className="contents text-quiet">
                <a
                  href={c.href}
                  title={c.title}
                  onClick={c.onClick}
                  className="rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {c.label}
                </a>
                <span aria-hidden="true">/</span>
              </span>
            ))}
            <h1 className="min-w-0 truncate font-semibold">{title}</h1>
            {state}
            <span className="flex-1" />
            {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
          </div>
          {tabs}
          {sentence && <p className="max-w-[720px] text-sentence">{sentence}</p>}
        </header>
        <div data-screen={kind} className="flex flex-col gap-4 md:gap-10">
          {children}
        </div>
      </div>
    </main>
  );
}

/** A block of a screen: its title in 16 px, a count, and what it holds. */
export function Section({
  title,
  count,
  hint,
  className,
  children,
}: {
  title: string;
  count?: number;
  /** One quiet word at the block's right, such as "newest first". */
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("flex flex-col gap-2 md:gap-4", className)} aria-label={title}>
      <div className="flex items-baseline gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {count !== undefined && <span className="text-quiet tabular-nums">{count}</span>}
        {hint && <span className="ml-auto text-xs text-quiet">{hint}</span>}
      </div>
      {children}
    </section>
  );
}
