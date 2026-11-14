import type { SessionAnswer } from "@core/api/control/dashboard.ts";
import { Act, CopyId, Facts, Screen, Section, TextLink } from "@ds";
import {
  ActivityIcon,
  ArrowUpRightIcon,
  BarChart3Icon,
  BookOpenIcon,
  BotIcon,
  GitBranchIcon,
  HardDriveIcon,
  InfoIcon,
  KeyRoundIcon,
  type LucideIcon,
  NetworkIcon,
  PlugIcon,
  RadioIcon,
  ScrollTextIcon,
  ServerIcon,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { follow, to } from "@/nav.ts";

/**
 * Setup (Settings until the refresh): its parts are links, each with its own address, in a column beside the content on a
 * wide window and in a row above it on a narrow one (the frame of fxbot's Settings). A tab whose
 * screens are not built here yet says where they are today.
 */

interface Tab {
  id: string;
  label: string;
  icon: LucideIcon;
  /** What the tab holds, in one sentence. */
  about: string;
  /** Its page on the dashboard at /ui, until it is built here; none for a tab that is. */
  page?: string;
}

const TABS: Tab[] = [
  {
    id: "providers",
    label: "Providers",
    icon: KeyRoundIcon,
    about: "The logins for models: accounts you sign in to, keys, and your own model servers.",
    page: "/ui/settings",
  },
  {
    id: "git",
    label: "Git access",
    icon: GitBranchIcon,
    about: "The logins for private repositories.",
    page: "/ui/settings",
  },
  {
    id: "machines",
    label: "Machines",
    icon: ServerIcon,
    about: "Where rigs run: computers, clusters and GPU clouds.",
    page: "/ui/settings/machines",
  },
  {
    id: "mcp",
    label: "MCP servers",
    icon: PlugIcon,
    about: "The tool servers that a campaign's agents may use.",
    page: "/ui/settings/mcp",
  },
  {
    id: "network",
    label: "Network",
    icon: NetworkIcon,
    about: "The private addresses that rigs on a cluster may reach.",
    page: "/ui/settings/reach",
  },
  {
    id: "kb",
    label: "Knowledge base",
    icon: BookOpenIcon,
    about: "The knowledge base's limits.",
    page: "/ui/settings/kb",
  },
  {
    id: "storage",
    label: "Storage",
    icon: HardDriveIcon,
    about: "What control keeps, what takes space, and the retention policies.",
    page: "/ui/settings/space",
  },
  {
    id: "agents",
    label: "Agents",
    icon: BotIcon,
    about: "Each agent role, what it does and the texts it is given.",
    page: "/ui/agents",
  },
  {
    id: "system",
    label: "System",
    icon: ActivityIcon,
    about: "The message bus, control's health and each rig's parts.",
    page: "/ui/metrics?tab=control",
  },
  {
    id: "usage",
    label: "Usage",
    icon: BarChart3Icon,
    about: "What the agents' models used, by run, by agent and by model.",
    page: "/ui/metrics",
  },
  {
    id: "logs",
    label: "Logs",
    icon: ScrollTextIcon,
    about: "Who changed what on control, and what control refused.",
    page: "/ui/audit",
  },
  {
    id: "live",
    label: "Live",
    icon: RadioIcon,
    about: "What every run's agents and judge do now.",
    page: "/ui/live",
  },
  {
    id: "about",
    label: "About",
    icon: InfoIcon,
    about: "This control, and this browser's session.",
  },
];

export function Settings({
  tab: id,
  session,
  signOut,
}: {
  tab: string | undefined;
  session: SessionAnswer;
  signOut: () => void;
}) {
  const tab = TABS.find((t) => t.id === (id ?? TABS[0]?.id));
  const current = useRef<HTMLAnchorElement>(null);
  // On a narrow window the tabs are one row that scrolls: the open one is brought into view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs again when the tab changes
  useEffect(() => {
    // In braces: a browser may return a promise from scrollIntoView, which is no cleanup.
    current.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [id]);
  return (
    <Screen title="Setup" sentence={tab?.about}>
      <div className="flex flex-col gap-6 lg:flex-row">
        <nav
          aria-label="Setup"
          className="flex shrink-0 gap-1 overflow-x-auto [scrollbar-width:none] lg:w-48 lg:flex-col lg:overflow-visible"
        >
          {TABS.map((t) => (
            <a
              key={t.id}
              ref={t === tab ? current : undefined}
              href={to(t === TABS[0] ? "/settings" : `/settings/${t.id}`)}
              onClick={follow}
              aria-current={t === tab ? "page" : undefined}
              className={`flex h-9 shrink-0 items-center gap-2 rounded-md px-2 text-sm outline-none hover:bg-chosen focus-visible:ring-2 focus-visible:ring-ring ${t === tab ? "bg-flame-tint font-semibold text-flame hover:bg-flame-tint" : ""}`}
            >
              <t.icon className={t === tab ? "size-4 text-flame" : "size-4 text-quiet"} /> {t.label}
            </a>
          ))}
        </nav>
        <div className="flex min-w-0 max-w-[720px] flex-1 flex-col gap-6">
          {!tab ? (
            <p className="text-quiet">Setup has no such part.</p>
          ) : tab.id === "about" ? (
            <About session={session} signOut={signOut} />
          ) : (
            <Elsewhere tab={tab} />
          )}
        </div>
      </div>
    </Screen>
  );
}

/** A part whose screens are still on the dashboard at /ui: the way there. */
function Elsewhere({ tab }: { tab: Tab }) {
  return (
    <Section title={tab.label}>
      <div className="flex flex-wrap items-center gap-4 rounded-xl border p-4">
        <span className="min-w-0 flex-1 text-soft">
          {tab.label} is still on the current dashboard. It moves here in a later step of the
          refresh.
        </span>
        <Act href={tab.page ?? "/ui"}>
          Open it <ArrowUpRightIcon className="text-quiet" />
        </Act>
      </div>
    </Section>
  );
}

function About({ session, signOut }: { session: SessionAnswer; signOut: () => void }) {
  return (
    <>
      <Section title="This control">
        <Facts
          facts={[
            { label: "Version", value: session.control.version },
            {
              label: "Commit",
              value: session.control.commit ? (
                <CopyId id={session.control.commit} label="the commit" />
              ) : (
                <span className="text-quiet">not given</span>
              ),
            },
          ]}
        />
        <p className="text-soft">
          This dashboard is built from open-source packages. Their licences:{" "}
          <TextLink href={to("/licenses.md")}>the script's</TextLink>,{" "}
          <TextLink href={to("/licenses-styles.md")}>
            the fonts', styles' and stock components'
          </TextLink>
          .
        </p>
      </Section>
      <Section title="This browser">
        <div className="flex flex-wrap items-center gap-4 rounded-xl border p-4">
          <span className="min-w-0 flex-1 text-soft">
            Signed in as the owner. A session left unused for {session.session_days} days ends.
          </span>
          <Act onClick={signOut}>Sign out</Act>
        </div>
      </Section>
    </>
  );
}
