import { Act, Menu, type MenuLine, type Tab, Tabs } from "@ds";
import { EllipsisIcon, EyeIcon, PauseIcon, PlayIcon, SendIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A run's top, the same on every screen of a run: its five tabs, and its four buttons with the
 * flame one last. The run's name, its campaign and its state are the screen's own (screen.tsx).
 */

/** The five parts of a run. */
export const RUN_TABS = [
  { id: "summary", label: "Summary" },
  { id: "explore", label: "Explore" },
  { id: "usage", label: "Usage" },
  { id: "results", label: "Results" },
  { id: "setup", label: "Setup" },
] as const;
export type RunTab = (typeof RUN_TABS)[number]["id"];

export function RunTabs({
  chosen,
  where,
  onChoose,
}: {
  chosen: RunTab;
  /** Where a tab leads, and what a pointer's rest says of it; none for a tab chosen in place. */
  where?: (tab: RunTab) => Pick<Tab, "href" | "title">;
  onChoose?: (tab: RunTab) => void;
}) {
  return (
    <Tabs
      label="The run's parts"
      tabs={RUN_TABS.map((t) => ({ ...t, ...where?.(t.id) }))}
      chosen={chosen}
      onChoose={onChoose ? (id) => onChoose(id as RunTab) : undefined}
    />
  );
}

/** What a button of the run's top does: it leads somewhere, or acts in place. */
type Does = { href: string; title?: string; after?: ReactNode } | { onClick: () => void };

/**
 * The run's four buttons: Watch, Pause (Resume on a paused run), More, and the main one, Tell
 * the agents. More is a menu of the run's rare acts, or leads to where they are.
 */
export function RunActs({
  paused = false,
  watch,
  pause,
  more,
  tell,
}: {
  paused?: boolean;
  watch: Does;
  pause: Does;
  more: Does | { lines: MenuLine[] };
  tell: Does;
}) {
  const after = (d: Does) => ("href" in d ? d.after : undefined);
  // What the button itself takes: where it leads, or what it does.
  const does = (d: Does) =>
    "href" in d ? { href: d.href, title: d.title } : { onClick: d.onClick };
  return (
    <>
      <Act icon={EyeIcon} {...does(watch)}>
        Watch{after(watch)}
      </Act>
      <Act icon={paused ? PlayIcon : PauseIcon} {...does(pause)}>
        {paused ? "Resume" : "Pause"}
        {after(pause)}
      </Act>
      {"lines" in more ? (
        <Menu lines={more.lines}>
          <Act icon={EllipsisIcon}>More</Act>
        </Menu>
      ) : (
        <Act icon={EllipsisIcon} {...does(more)}>
          More{after(more)}
        </Act>
      )}
      <Act look="main" icon={SendIcon} {...does(tell)}>
        Tell the agents{after(tell)}
      </Act>
    </>
  );
}
