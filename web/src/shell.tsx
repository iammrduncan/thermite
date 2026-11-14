import type { HomeAnswer } from "@core/api/control/dashboard.ts";
import { Count, NavAccount, NavItem, NavLine, NavList, Frame as Shell } from "@ds";
import {
  CpuIcon,
  FlaskConicalIcon,
  HouseIcon,
  LibraryIcon,
  PlusIcon,
  SettingsIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { follow, runPath, to } from "@/nav.ts";

/**
 * Thermite's frame: the design system's, with Thermite's places. The sidebar lists what is fixed
 * first and what grows last: Home, Compute, Knowledge, then Campaigns with its campaigns; Setup
 * and the owner are at its foot.
 *
 * A place whose screens are not built here yet opens its page on the dashboard at /ui, and its
 * line is marked with an arrow.
 */

/** What a pointer's rest says of a place that is still on the dashboard at /ui. */
const elsewhere = (place: string) => `${place} opens on the current dashboard`;

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
  const needs = home?.needs.length ?? 0;
  const campaigns = home?.nav.campaigns ?? [];
  return (
    <Shell
      name="Thermite"
      home={to("/")}
      onHome={follow}
      notice={
        alive
          ? undefined
          : "Control is not answering. What you see may be old; the page keeps trying."
      }
      nav={
        <>
          <NavLine
            href={to("/")}
            onClick={follow}
            icon={HouseIcon}
            label="Home"
            chosen={path === "/"}
            end={needs > 0 ? <Count>{needs}</Count> : undefined}
          />
          <NavLine
            href="/ui/rigs"
            icon={CpuIcon}
            label="Compute"
            out
            title={elsewhere("Compute")}
          />
          <NavLine
            href="/ui/knowledge"
            icon={LibraryIcon}
            label="Knowledge"
            out
            title={elsewhere("Knowledge")}
          />
          <NavLine
            href="/ui/campaigns"
            icon={FlaskConicalIcon}
            label="Campaigns"
            out
            title={elsewhere("Campaigns")}
            beside={{
              href: "/ui/campaigns/new",
              icon: PlusIcon,
              label: "New campaign",
              title: elsewhere("New campaign"),
            }}
          />
          {campaigns.length > 0 && (
            <NavList>
              {campaigns.map((k) => (
                // The list is flat; a campaign's group is said under a pointer, until the list
                // of campaigns has its filter. Its line opens its newest run.
                <NavItem
                  key={k.name}
                  href={
                    k.run
                      ? runPath({ campaign: k.name, run: k.run })
                      : `/ui/campaigns/${encodeURIComponent(k.name)}`
                  }
                  onClick={follow}
                  tone={k.state.tone}
                  label={k.name}
                  word={k.state.word}
                  chosen={path.startsWith(`/campaigns/${encodeURIComponent(k.name)}/`)}
                  title={k.folder ? `${k.name}, in ${k.folder}` : undefined}
                />
              ))}
            </NavList>
          )}
        </>
      }
      foot={
        <>
          <NavLine
            href={to("/settings")}
            onClick={follow}
            icon={SettingsIcon}
            label="Setup"
            chosen={path.startsWith("/settings")}
          />
          <NavAccount name="Owner" onSignOut={signOut} />
        </>
      }
    >
      {children}
    </Shell>
  );
}
