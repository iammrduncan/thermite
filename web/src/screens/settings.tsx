import type { SessionAnswer } from "@core/api/control/dashboard.ts";
import {
  ActivityIcon,
  ArrowUpRightIcon,
  BookOpenIcon,
  BotIcon,
  GitBranchIcon,
  HardDriveIcon,
  InfoIcon,
  KeyRoundIcon,
  type LucideIcon,
  NetworkIcon,
  PlugIcon,
  ServerIcon,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { follow, to } from "@/nav.ts";
import { CopyId } from "@/parts/copy-id.tsx";
import { Header } from "@/parts/header.tsx";

/**
 * Settings: its tabs are links, each with its own address, in a column beside the content on a
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
    <>
      <Header title="Settings" />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <nav
          aria-label="Settings"
          className="flex shrink-0 gap-1 overflow-x-auto border-b px-3 pb-2 [scrollbar-width:none] lg:w-48 lg:flex-col lg:overflow-visible lg:border-b-0 lg:py-6"
        >
          {TABS.map((t) => (
            <a
              key={t.id}
              ref={t === tab ? current : undefined}
              href={to(t === TABS[0] ? "/settings" : `/settings/${t.id}`)}
              onClick={follow}
              aria-current={t === tab ? "page" : undefined}
              className={buttonVariants({
                variant: "ghost",
                size: "sm",
                className:
                  "shrink-0 justify-start rounded-full text-muted-foreground aria-[current=page]:bg-accent aria-[current=page]:text-foreground lg:rounded-md",
              })}
            >
              <t.icon /> {t.label}
            </a>
          ))}
        </nav>
        <main className="min-w-0 flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto grid max-w-xl gap-5">
            {!tab ? (
              <p className="text-sm text-muted-foreground">Settings has no such tab.</p>
            ) : tab.id === "about" ? (
              <About session={session} signOut={signOut} />
            ) : (
              <Elsewhere tab={tab} />
            )}
          </div>
        </main>
      </div>
    </>
  );
}

/** A tab whose screens are still on the dashboard at /ui: what it holds, and the way there. */
function Elsewhere({ tab }: { tab: Tab }) {
  return (
    <section className="grid gap-3" aria-label={tab.label}>
      <h2 className="font-medium">{tab.label}</h2>
      <p className="text-sm text-muted-foreground">{tab.about}</p>
      <div className="flex items-center gap-3 rounded-xl border p-3 text-sm">
        <span className="min-w-0 flex-1">
          {tab.label} is still on the current dashboard. It moves here in a later step of the
          refresh.
        </span>
        <Button variant="outline" asChild>
          <a href={tab.page}>
            Open it <ArrowUpRightIcon />
          </a>
        </Button>
      </div>
    </section>
  );
}

function About({ session, signOut }: { session: SessionAnswer; signOut: () => void }) {
  return (
    <>
      <section className="grid gap-3" aria-label="This control">
        <h2 className="font-medium">This control</h2>
        <dl className="grid grid-cols-[8rem_1fr] items-center gap-x-3 gap-y-1 rounded-xl border p-3 text-sm">
          <dt className="text-muted-foreground">Version</dt>
          <dd>{session.control.version}</dd>
          <dt className="text-muted-foreground">Commit</dt>
          <dd>
            {session.control.commit ? (
              <CopyId id={session.control.commit} label="the commit" />
            ) : (
              <span className="text-muted-foreground">not given</span>
            )}
          </dd>
        </dl>
      </section>
      <p className="text-sm text-muted-foreground">
        This dashboard is built from open-source packages. Their licences:{" "}
        <a href={to("/licenses.md")} className="underline underline-offset-4">
          the script's
        </a>
        ,{" "}
        <a href={to("/licenses-styles.md")} className="underline underline-offset-4">
          the fonts', styles' and stock components'
        </a>
        .
      </p>
      <section className="grid gap-3" aria-label="This browser">
        <h2 className="font-medium">This browser</h2>
        <div className="flex items-center gap-3 rounded-xl border p-3 text-sm">
          <span className="min-w-0 flex-1">
            Signed in as the owner. A session left unused for {session.session_days} days ends.
          </span>
          <Button variant="outline" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </section>
    </>
  );
}
