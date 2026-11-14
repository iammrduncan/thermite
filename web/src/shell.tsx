import type { HomeAnswer, NavCampaign } from "@core/api/control/dashboard.ts";
import {
  ArrowUpRightIcon,
  CpuIcon,
  FlaskConicalIcon,
  HouseIcon,
  LibraryIcon,
  LogOutIcon,
  type LucideIcon,
  MenuIcon,
  PlusIcon,
  SettingsIcon,
} from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  useSidebar,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { follow, to } from "@/nav.ts";
import { Count, Dot } from "@/parts/chip.tsx";
import { Mark } from "@/parts/mark.tsx";
import { runPath } from "@/parts/rows.tsx";
import { toneText } from "@/parts/tone.ts";

/**
 * The frame every screen is in, from the brand guide's navigation: the sidebar at the left (a
 * menu on a phone, under a top bar) and one screen beside it, which scrolls by itself.
 *
 * The sidebar lists what is fixed first and what grows last: Home, Compute, Knowledge, then
 * Campaigns with its campaigns; Setup and the owner are at its foot. Every line has an icon, and
 * what is chosen is in the flame's tint. A place whose screens are not built here yet opens its
 * page on the dashboard at /ui, and its line is marked with an arrow.
 */
export function Frame({
  home,
  path,
  alive,
  signOut,
  children,
}: {
  /** Home's answer, which holds what the navigation shows; none while it is read. */
  home: HomeAnswer | undefined;
  /** The open screen's own path. */
  path: string;
  /** Whether control's stream of changes is alive. */
  alive: boolean;
  signOut: () => void;
  children: ReactNode;
}) {
  return (
    <TooltipProvider>
      <SidebarProvider>
        <Navigation home={home} path={path} signOut={signOut} />
        <SidebarInset className="h-dvh overflow-hidden pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] md:peer-data-[state=expanded]:pl-0">
          <PhoneBar />
          {!alive && (
            <p role="status" className="bg-needs-tint px-4 py-2 text-xs font-semibold text-needs">
              Control is not answering. What you see may be old; the page keeps trying.
            </p>
          )}
          {children}
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

/** On a phone the sidebar folds into a menu: a bar with its button, the mark and the name. */
function PhoneBar() {
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
      <span className="text-base font-semibold tracking-[-0.01em]">Thermite</span>
    </div>
  );
}

/** What every line of the sidebar looks like: 36 px high, and the flame's tint when chosen. */
const LINE =
  "flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none hover:bg-chosen focus-visible:ring-2 focus-visible:ring-ring";
const CHOSEN = "bg-flame-tint font-semibold text-flame hover:bg-flame-tint";

/** A line of the sidebar: a screen of the app, or a page still at /ui (marked with an arrow). */
function Place({
  href,
  icon: Icon,
  label,
  active = false,
  end,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  active?: boolean;
  /** What sits at the line's right: a count. */
  end?: ReactNode;
}) {
  const { setOpenMobile } = useSidebar();
  const out = href.startsWith("/ui");
  return (
    <a
      href={href}
      onClick={(e) => {
        setOpenMobile(false);
        follow(e);
      }}
      aria-current={active ? "page" : undefined}
      title={out ? `${label} opens on the current dashboard` : undefined}
      className={cn(LINE, active && CHOSEN)}
    >
      <span className="inline-flex w-5 flex-none justify-center">
        <Icon className={cn("size-4", active ? "text-flame" : "text-quiet")} />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {end}
      {out && <ArrowUpRightIcon className="size-3.5 flex-none text-quiet" />}
    </a>
  );
}

/**
 * A campaign in the sidebar: a dot for its state, its name, and its state's word. The list is
 * flat; a campaign's group is said under a pointer, until the list of campaigns has its filter.
 */
function CampaignLine({ campaign: k, path }: { campaign: NavCampaign; path: string }) {
  const { setOpenMobile } = useSidebar();
  const href = k.run
    ? runPath({ campaign: k.name, run: k.run })
    : `/ui/campaigns/${encodeURIComponent(k.name)}`;
  const active = path.startsWith(`/campaigns/${encodeURIComponent(k.name)}/`);
  return (
    <li>
      <a
        href={href}
        onClick={(e: MouseEvent<HTMLAnchorElement>) => {
          setOpenMobile(false);
          follow(e);
        }}
        aria-current={active ? "page" : undefined}
        title={k.folder ? `${k.name}, in ${k.folder}` : undefined}
        className={cn(LINE, "text-soft", active && CHOSEN)}
      >
        <span className="inline-flex w-5 flex-none justify-center">
          <Dot tone={k.state.tone} />
        </span>
        <span className="min-w-0 flex-1 truncate">{k.name}</span>
        <span className={cn("flex-none text-xs font-semibold", toneText[k.state.tone])}>
          {k.state.word}
        </span>
      </a>
    </li>
  );
}

function Navigation({
  home,
  path,
  signOut,
}: {
  home: HomeAnswer | undefined;
  path: string;
  signOut: () => void;
}) {
  const { setOpenMobile } = useSidebar();
  const needs = home?.needs.length ?? 0;
  const campaigns = home?.nav.campaigns ?? [];
  return (
    <Sidebar>
      <SidebarHeader className="px-2 pt-4 pb-2">
        <a
          href={to("/")}
          onClick={(e) => {
            setOpenMobile(false);
            follow(e);
          }}
          className="flex items-center gap-2 rounded-md px-2 text-base font-semibold tracking-[-0.01em] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Mark />
          Thermite
        </a>
      </SidebarHeader>
      <SidebarContent className="px-2 py-2">
        <nav aria-label="Main" className="flex flex-col gap-1">
          <Place
            href={to("/")}
            icon={HouseIcon}
            label="Home"
            active={path === "/"}
            end={needs > 0 ? <Count>{needs}</Count> : undefined}
          />
          <Place href="/ui/rigs" icon={CpuIcon} label="Compute" />
          <Place href="/ui/knowledge" icon={LibraryIcon} label="Knowledge" />
          <div className="flex items-center gap-1">
            <span className="min-w-0 flex-1">
              <Place href="/ui/campaigns" icon={FlaskConicalIcon} label="Campaigns" />
            </span>
            <a
              href="/ui/campaigns/new"
              aria-label="New campaign"
              title="New campaign opens on the current dashboard"
              className="inline-flex size-9 flex-none items-center justify-center rounded-md text-quiet outline-none hover:bg-chosen focus-visible:ring-2 focus-visible:ring-ring"
            >
              <PlusIcon className="size-4" />
            </a>
          </div>
          {campaigns.length > 0 && (
            <ul className="ml-[17px] flex flex-col gap-1 border-l pl-2">
              {campaigns.map((k) => (
                <CampaignLine key={k.name} campaign={k} path={path} />
              ))}
            </ul>
          )}
        </nav>
      </SidebarContent>
      <SidebarFooter className="gap-1 px-2 pt-2 pb-4">
        <Place
          href={to("/settings")}
          icon={SettingsIcon}
          label="Setup"
          active={path.startsWith("/settings")}
        />
        <button type="button" onClick={signOut} title="Sign out" className={LINE}>
          <span className="inline-flex w-5 flex-none justify-center">
            <span className="inline-flex size-5 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">
              O
            </span>
          </span>
          <span className="min-w-0 flex-1 truncate">Owner</span>
          <LogOutIcon aria-label="Sign out" className="size-4 flex-none text-quiet" />
        </button>
      </SidebarFooter>
    </Sidebar>
  );
}
