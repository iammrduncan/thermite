import { ArrowUpRightIcon, LogOutIcon, type LucideIcon, MenuIcon } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { cn } from "../lib/utils.ts";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  useSidebar,
} from "../primitives/sidebar.tsx";
import { TooltipProvider } from "../primitives/tooltip.tsx";
import { Dot } from "./chip.tsx";
import { type Tone, toneText } from "./tone.ts";

/**
 * The frame every screen of an app sits in: a sidebar on desktop (collapsing into a menu drawer
 * under a top bar on mobile) and a scrolling screen beside it.
 *
 * Brand assets are injected via the optional `brand` prop so the design system stays product-neutral.
 */
export function Frame({
  brand,
  name,
  home,
  onHome,
  nav,
  foot,
  notice,
  children,
}: {
  /** Optional product mark rendered beside the app's name in the sidebar and mobile bar. */
  brand?: ReactNode;
  /** The app's name beside the mark. */
  name: string;
  /** Where the mark and name link to. */
  home: string;
  onHome?: (event: MouseEvent<HTMLAnchorElement>) => void;
  /** The sidebar navigation lines. */
  nav: ReactNode;
  /** Optional footer slot at the bottom of the sidebar. */
  foot?: ReactNode;
  /** Optional status banner above the screen. */
  notice?: string;
  children: ReactNode;
}) {
  return (
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar>
          <SidebarHeader className="px-2 pt-4 pb-2">
            <Closing>
              <a
                href={home}
                onClick={onHome}
                className="flex items-center gap-2 rounded-md px-2 text-base font-semibold tracking-[-0.01em] outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {brand}
                {name}
              </a>
            </Closing>
          </SidebarHeader>
          <SidebarContent className="px-2 py-2">
            <nav aria-label="Main" className="flex flex-col gap-1">
              {nav}
            </nav>
          </SidebarContent>
          {foot && <SidebarFooter className="gap-1 px-2 pt-2 pb-4">{foot}</SidebarFooter>}
        </Sidebar>
        <SidebarInset className="h-dvh overflow-hidden pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] md:peer-data-[state=expanded]:pl-0">
          <PhoneBar brand={brand} name={name} />
          {notice && (
            <p role="status" className="bg-needs-tint px-4 py-2 text-xs font-semibold text-needs">
              {notice}
            </p>
          )}
          {children}
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

/** A click inside closes the mobile drawer so the destination screen is immediately visible. */
function Closing({ children }: { children: ReactNode }) {
  const { setOpenMobile } = useSidebar();
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: listens only to clicks bubbling from links inside
    // biome-ignore lint/a11y/useKeyWithClickEvents: link key presses fire click events
    <div className="contents" onClick={() => setOpenMobile(false)}>
      {children}
    </div>
  );
}

/** On mobile the sidebar collapses into a menu drawer under a top bar. */
function PhoneBar({ brand, name }: { brand?: ReactNode; name: string }) {
  const { toggleSidebar } = useSidebar();
  return (
    <div className="box-content flex h-14 flex-none items-center gap-2 border-b bg-sidebar px-4 pt-[env(safe-area-inset-top)] md:hidden">
      <button
        type="button"
        data-sidebar="trigger"
        aria-label="Menu"
        onClick={toggleSidebar}
        className="inline-flex size-9 items-center justify-center rounded-md outline-none hover:bg-chosen focus-visible:ring-2 focus-visible:ring-ring"
      >
        <MenuIcon className="size-5" />
      </button>
      {brand}
      <span className="text-base font-semibold tracking-[-0.01em]">{name}</span>
    </div>
  );
}

/** Standard sidebar line styling, highlighted in the brand accent tint when active. */
const LINE =
  "flex h-(--control-h) w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none hover:bg-chosen focus-visible:ring-2 focus-visible:ring-ring";
const CHOSEN = "bg-brand-accent-tint font-semibold text-brand-accent hover:bg-brand-accent-tint";

interface Leads {
  href: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  title?: string;
}

/** A primary navigation item in the sidebar, with optional trailing badge or secondary icon link. */
export function NavLine({
  icon: Icon,
  label,
  chosen = false,
  out = false,
  end,
  beside,
  ...leads
}: Leads & {
  icon: LucideIcon;
  label: string;
  chosen?: boolean;
  out?: boolean;
  end?: ReactNode;
  beside?: Leads & { icon: LucideIcon; label: string };
}) {
  const line = (
    <Closing>
      <a
        {...leads}
        aria-current={chosen ? "page" : undefined}
        className={cn(LINE, chosen && CHOSEN)}
      >
        <span className="inline-flex w-5 flex-none justify-center">
          <Icon className={cn("size-4", chosen ? "text-brand-accent" : "text-quiet")} />
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {end}
        {out && <ArrowUpRightIcon className="size-3.5 flex-none text-quiet" />}
      </a>
    </Closing>
  );
  if (!beside) return line;
  const { icon: Beside, label: what, ...where } = beside;
  return (
    <div className="flex items-center gap-1">
      <span className="min-w-0 flex-1">{line}</span>
      <Closing>
        <a
          href={where.href}
          onClick={where.onClick}
          title={where.title}
          aria-label={what}
          className="inline-flex size-(--control-h) flex-none items-center justify-center rounded-md text-quiet outline-none hover:bg-chosen focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Beside className="size-4" />
        </a>
      </Closing>
    </div>
  );
}

/** Nested list under a sidebar section. */
export function NavList({ children }: { children: ReactNode }) {
  return <ul className="ml-[17px] flex flex-col gap-1 border-l pl-2">{children}</ul>;
}

/** One item in a sidebar list: a status dot, its label, and an optional trailing word. */
export function NavItem({
  tone,
  label,
  word,
  chosen = false,
  ...leads
}: Leads & { tone: Tone; label: string; word?: string; chosen?: boolean }) {
  return (
    <li>
      <Closing>
        <a
          {...leads}
          aria-current={chosen ? "page" : undefined}
          className={cn(LINE, "text-soft", chosen && CHOSEN)}
        >
          <span className="inline-flex w-5 flex-none justify-center">
            <Dot tone={tone} />
          </span>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {word && (
            <span className={cn("flex-none text-xs font-semibold", toneText[tone])}>{word}</span>
          )}
        </a>
      </Closing>
    </li>
  );
}

/** Signed-in account button at the bottom of the sidebar. */
export function NavAccount({ name, onSignOut }: { name: string; onSignOut: () => void }) {
  return (
    <button type="button" onClick={onSignOut} title="Sign out" className={LINE}>
      <span className="inline-flex w-5 flex-none justify-center">
        <span className="inline-flex size-5 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">
          {name.slice(0, 1).toUpperCase()}
        </span>
      </span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <LogOutIcon aria-label="Sign out" className="size-4 flex-none text-quiet" />
    </button>
  );
}
