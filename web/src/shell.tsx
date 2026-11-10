import type { HomeAnswer, NavCampaign } from "@core/api/control/dashboard.ts";
import {
  ArrowUpRightIcon,
  BarChart3Icon,
  FolderIcon,
  HomeIcon,
  LibraryIcon,
  type LucideIcon,
  PlusIcon,
  RadioIcon,
  ScrollTextIcon,
  ServerIcon,
  SettingsIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarProvider,
  useSidebar,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { follow, to } from "@/nav.ts";
import { ModeAvatar } from "@/parts/mode-avatar.tsx";
import { runPath } from "@/parts/rows.tsx";
import { toneDot, toneText } from "@/parts/tone.ts";

/**
 * The frame every screen is in: the navigation at the left (a sheet on a phone) and one screen
 * beside it. Each screen draws its own top bar and scrolls by itself. A place whose screens are
 * not built here yet opens its page on the dashboard at /ui, and its row is marked with an arrow
 * (docs/plan/ui-refresh-guide.md, section 9).
 */

/**
 * Library, Usage and Logs: icons at the navigation's foot, beside Settings, each with its name
 * for a pointer that rests on it and for a screen reader (the owner's choice of 2026-11-10, from
 * two variants; fxbot has its records there too). They are still pages of the dashboard at /ui.
 */
const RECORDS: { label: string; icon: LucideIcon; page: string }[] = [
  { label: "Library", icon: LibraryIcon, page: "/ui/knowledge" },
  { label: "Usage", icon: BarChart3Icon, page: "/ui/metrics" },
  { label: "Logs", icon: ScrollTextIcon, page: "/ui/audit" },
];

export function Frame({
  home,
  path,
  alive,
  children,
}: {
  /** Home's answer, which holds what the navigation shows; none while it is read. */
  home: HomeAnswer | undefined;
  /** The open screen's own path. */
  path: string;
  /** Whether control's stream of changes is alive. */
  alive: boolean;
  children: ReactNode;
}) {
  return (
    <TooltipProvider>
      <SidebarProvider>
        <Navigation home={home} path={path} />
        <SidebarInset className="h-dvh overflow-hidden pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] md:peer-data-[state=expanded]:pl-0">
          {!alive && (
            <p role="status" className="bg-needs/10 px-4 py-1.5 text-xs text-needs">
              Control is not answering. What you see may be old; the page keeps trying.
            </p>
          )}
          {children}
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

/** A row of the navigation: a screen of the app, or a page still at /ui (marked with an arrow). */
function Place({
  href,
  icon: Icon,
  label,
  active = false,
  badge,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  active?: boolean;
  badge?: ReactNode;
}) {
  const { setOpenMobile } = useSidebar();
  const out = href.startsWith("/ui");
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active}>
        <a
          href={href}
          onClick={(e) => {
            setOpenMobile(false);
            follow(e);
          }}
          aria-current={active ? "page" : undefined}
          title={out ? `${label} opens on the current dashboard` : undefined}
        >
          <Icon />
          <span>{label}</span>
          {out && <ArrowUpRightIcon className="ml-auto size-3.5 text-muted-foreground" />}
        </a>
      </SidebarMenuButton>
      {badge !== undefined && <SidebarMenuBadge>{badge}</SidebarMenuBadge>}
    </SidebarMenuItem>
  );
}

/** A campaign in the navigation: its row opens its newest run. */
function CampaignRow({ campaign: k, path }: { campaign: NavCampaign; path: string }) {
  const { setOpenMobile } = useSidebar();
  const href = k.run
    ? runPath({ campaign: k.name, run: k.run })
    : `/ui/campaigns/${encodeURIComponent(k.name)}`;
  const active = path.startsWith(`/campaigns/${encodeURIComponent(k.name)}/`);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active}>
        <a
          href={href}
          onClick={(e) => {
            setOpenMobile(false);
            follow(e);
          }}
          aria-current={active ? "page" : undefined}
        >
          <ModeAvatar mode={k.mode} className="size-5" />
          <span className="truncate">{k.name}</span>
          <span className={`ml-auto text-xs ${toneText[k.state.tone]}`}>{k.state.word}</span>
        </a>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function Navigation({ home, path }: { home: HomeAnswer | undefined; path: string }) {
  const { setOpenMobile } = useSidebar();
  const needs = home?.needs ?? [];
  const campaigns = home?.nav.campaigns ?? [];
  const folders = home?.nav.folders ?? [];
  const groups = [
    ...folders
      .map((name) => ({ name, list: campaigns.filter((k) => k.folder === name) }))
      .filter((g) => g.list.length > 0),
    { name: "", list: campaigns.filter((k) => !k.folder) },
  ];
  const offline = home?.counts.offline ?? 0;
  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1">
          <span
            aria-hidden="true"
            className="inline-flex size-6 items-center justify-center rounded-md bg-primary text-[0.625rem] font-semibold text-primary-foreground"
          >
            Th
          </span>
          <span className="font-medium">Thermite</span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <Place
                href={to("/")}
                icon={HomeIcon}
                label="Home"
                active={path === "/"}
                badge={
                  needs.length ? <span className={toneText.needs}>{needs.length}</span> : undefined
                }
              />
              <Place href="/ui/live" icon={RadioIcon} label="Live" />
              <Place
                href="/ui/rigs"
                icon={ServerIcon}
                label={offline ? `Rigs · ${offline} offline` : "Rigs"}
              />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {needs.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>Needs you</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {needs.slice(0, 5).map((n) => (
                  <SidebarMenuItem key={n.key}>
                    <SidebarMenuButton asChild className="h-auto items-start py-1.5">
                      <a href={n.page} title={n.headline}>
                        <span
                          className={`mt-1.5 size-1.5 shrink-0 rounded-full ${toneDot[n.tone]}`}
                        />
                        <span className="grid min-w-0">
                          <span className="truncate">
                            {n.where.run
                              ? `${n.where.campaign ?? ""} › ${n.where.run}`
                              : (n.where.rig ?? n.label)}
                          </span>
                          <span className="truncate text-xs text-muted-foreground">
                            {n.where.run || n.where.rig ? n.label : n.headline}
                            {n.where.lane ? ` · ${n.where.lane}` : ""}
                          </span>
                        </span>
                      </a>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
                {needs.length > 5 && (
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild>
                      <a
                        href={to("/")}
                        onClick={(e) => {
                          setOpenMobile(false);
                          follow(e);
                        }}
                        className="text-muted-foreground"
                      >
                        All {needs.length}
                      </a>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
        <SidebarGroup>
          <SidebarGroupLabel>Campaigns</SidebarGroupLabel>
          <SidebarGroupAction asChild title="New campaign">
            <a href="/ui/campaigns/new" aria-label="New campaign">
              <PlusIcon />
            </a>
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              {campaigns.length === 0 && (
                <li className="px-2 py-1 text-xs text-muted-foreground">
                  {home ? "No campaign yet." : ""}
                </li>
              )}
              {groups.map((g) =>
                g.name ? (
                  <SidebarMenuItem key={g.name}>
                    <span className="flex h-8 items-center gap-2 px-2 text-muted-foreground">
                      <FolderIcon className="size-4 shrink-0" />
                      <span className="truncate">{g.name}</span>
                    </span>
                    <SidebarMenuSub className="mr-0 pr-0">
                      {g.list.map((k) => (
                        <CampaignRow key={k.name} campaign={k} path={path} />
                      ))}
                    </SidebarMenuSub>
                  </SidebarMenuItem>
                ) : (
                  g.list.map((k) => <CampaignRow key={k.name} campaign={k} path={path} />)
                ),
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <div className="flex items-center gap-1">
          <SidebarMenu className="min-w-0 flex-1">
            <Place
              href={to("/settings")}
              icon={SettingsIcon}
              label="Settings"
              active={path.startsWith("/settings")}
            />
          </SidebarMenu>
          {RECORDS.map((r) => (
            <Tooltip key={r.label}>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" asChild>
                  <a href={r.page} aria-label={r.label}>
                    <r.icon />
                  </a>
                </Button>
              </TooltipTrigger>
              <TooltipContent>{r.label}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
