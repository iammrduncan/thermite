import type { ReactNode } from "react";
import { SidebarTrigger } from "@/components/ui/sidebar";

/** A screen's top bar: the navigation's button, where the screen is, its title, its actions. */
export function Header({
  title,
  lead,
  children,
}: {
  title: ReactNode;
  lead?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="box-content flex h-14 shrink-0 items-center gap-2 px-3 pt-[env(safe-area-inset-top)]">
      <SidebarTrigger />
      {lead}
      <h1 className="min-w-0 flex-1 truncate font-medium">{title}</h1>
      {children}
    </header>
  );
}

/**
 * A screen's body: one column, as wide as its kind of screen takes. Its parts lay themselves out
 * by the column's own width (container queries), since the navigation takes part of the window.
 */
export function Body({
  width = "read",
  children,
}: {
  width?: "form" | "read";
  children: ReactNode;
}) {
  return (
    <main className="flex-1 overflow-y-auto px-4 py-6">
      <div
        className={`@container mx-auto grid gap-6 ${width === "form" ? "max-w-xl" : "max-w-5xl"}`}
      >
        {children}
      </div>
    </main>
  );
}

/** A section of a screen: its heading, a count, and at most one sentence. */
export function Section({
  title,
  count,
  hint,
  children,
}: {
  title: string;
  count?: number;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-3" aria-label={title}>
      <div className="flex items-baseline gap-2">
        <h2 className="font-medium">{title}</h2>
        {count !== undefined && <span className="text-muted-foreground tabular-nums">{count}</span>}
        {hint && <span className="ml-auto text-xs text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </section>
  );
}
