import { ArrowUpRightIcon, LogOutIcon, type LucideIcon, MenuIcon } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { Mark } from "../brand/mark.tsx";
import { cn } from "../lib/utils.ts";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  useSidebar,
} from "../ui/sidebar.tsx";
import { TooltipProvider } from "../ui/tooltip.tsx";
import { Dot } from "./chip.tsx";
import { type Tone, toneText } from "./tone.ts";

/**
 * The frame every screen of an app is in: the sidebar at the left, which is a menu under a top
 * bar on a phone, and one screen beside it, which scrolls by itself.
 *
 * The sidebar lists what is fixed first and what grows last, with the app's set-up and the person
 * at its foot. Every line has an icon, and what is chosen is in the flame's tint.
 */
export function Frame({
  name,
  home,
  onHome,
  nav,
  foot,
  notice,
  children,
}: {
  /** The app's name, beside the mark. */
  name: string;
  /** Where the mark and the name lead. */
  home: string;
  onHome?: (event: MouseEvent<HTMLAnchorElement>) => void;
  /** The sidebar's lines. */
  nav: ReactNode;
  /** What is at the sidebar's foot. */
  foot?: ReactNode;
  /** One line over the screen that says something is not as it should be. */
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
                <Mark />
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
          <PhoneBar name={name} />
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

/** A click inside closes the phone's menu, so the screen it leads to is in sight. */
function Closing({ children }: { children: ReactNode }) {
  const { setOpenMobile } = useSidebar();
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: it only hears the clicks of the links inside it
    // biome-ignore lint/a11y/useKeyWithClickEvents: a link's key press arrives here as its click
    <div className="contents" onClick={() => setOpenMobile(false)}>
      {children}
    </div>
  );
}

/** On a phone the sidebar folds into a menu: a bar with its button, the mark and the name. */
function PhoneBar({ name }: { name: string }) {
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
      <Mark />
      <span className="text-base font-semibold tracking-[-0.01em]">{name}</span>
    </div>
  );
}

/** What every line of the sidebar looks like: 36 px high, and the flame's tint when chosen. */
const LINE =
  "flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none hover:bg-chosen focus-visible:ring-2 focus-visible:ring-ring";
const CHOSEN = "bg-flame-tint font-semibold text-flame hover:bg-flame-tint";

/** What leads somewhere: its address, and what happens on a plain click. */
interface Leads {
  href: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  /** What a pointer's rest says. */
  title?: string;
}

/**
 * A line of the sidebar: a place of the app. A place that is elsewhere for now (`out`) is marked
 * with an arrow. `beside` is one small act at the line's right, such as making a new thing.
 */
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
  /** What sits at the line's right: a count. */
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
          <Icon className={cn("size-4", chosen ? "text-flame" : "text-quiet")} />
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
          className="inline-flex size-9 flex-none items-center justify-center rounded-md text-quiet outline-none hover:bg-chosen focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Beside className="size-4" />
        </a>
      </Closing>
    </div>
  );
}

/** The things under a line of the sidebar, such as a place's own list: it grows, so it is last. */
export function NavList({ children }: { children: ReactNode }) {
  return <ul className="ml-[17px] flex flex-col gap-1 border-l pl-2">{children}</ul>;
}

/** One thing of a sidebar's list: a dot for its state, its name, and one word at its right. */
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

/** The person who is signed in, at the sidebar's foot: a press signs them out. */
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
