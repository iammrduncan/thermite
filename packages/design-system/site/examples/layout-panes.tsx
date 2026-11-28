import {
  Act,
  BesideHost,
  BesidePanel,
  FoldPill,
  PluginIcon,
  ResponsiveDialog,
  ScreenHeader,
  type SettingsNavItem,
  SettingsShell,
} from "@iammrduncan/magnesium/parts";
import { Button, Switch } from "@iammrduncan/magnesium/primitives";
import { KeyRoundIcon, PuzzleIcon, SlidersHorizontalIcon } from "lucide-react";
import { useState } from "react";

const SETTINGS_ITEMS: SettingsNavItem[] = [
  { id: "general", label: "General", icon: SlidersHorizontalIcon },
  { id: "providers", label: "Providers", icon: KeyRoundIcon },
  { id: "plugins", label: "Plugins", icon: PuzzleIcon },
  { id: "git-sync", label: "Git sync", iconKey: "com.usethermite/git-sync" },
];

export default function LayoutAndPanes() {
  const [besideOpen, setBesideOpen] = useState(
    () => typeof window === "undefined" || window.innerWidth >= 768,
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [tab, setTab] = useState("general");
  const [autoSync, setAutoSync] = useState(true);

  return (
    <div className="grid gap-6">
      <div className="flex h-64 overflow-hidden rounded-xl border bg-background">
        <BesideHost
          panel={
            besideOpen ? (
              <BesidePanel
                label="Candidate inspector"
                storageKey="gallery-beside"
                minWidth={220}
                defaultWidth="280px"
                onClose={() => setBesideOpen(false)}
              >
                <ScreenHeader
                  title="Candidate #42"
                  showSidebarTrigger={false}
                  className="border-b"
                />
                <div className="grid gap-2 overflow-y-auto p-3 text-xs text-soft">
                  <p>Drag the left edge gutter to resize or double-click to reset.</p>
                  <p className="font-mono text-foreground">+6.4% tok/s · p = 0.002</p>
                </div>
              </BesidePanel>
            ) : null
          }
        >
          <ScreenHeader title="Main workspace" showSidebarTrigger={false} className="border-b">
            {!besideOpen && (
              <Button size="sm" variant="outline" onClick={() => setBesideOpen(true)}>
                Open inspector
              </Button>
            )}
          </ScreenHeader>
          <div className="grid gap-3 p-4 text-sm text-soft">
            <p>
              Primary view stays mounted while <code className="font-mono">BesidePanel</code> opens,
              resizes, or switches to a mobile sheet.
            </p>
            <FoldPill
              label="3 advisor notes folded · planner, auditor"
              leading={<PluginIcon iconKey="com.usethermite/live-publish" size={18} />}
            >
              <p className="mx-auto max-w-prose text-xs text-soft">
                Unfolded pill content: avoided warp divergence on tile sizes above 64.
              </p>
            </FoldPill>
          </div>
        </BesideHost>
      </div>

      <div className="overflow-hidden rounded-xl border bg-background">
        <SettingsShell
          items={SETTINGS_ITEMS}
          activeId={tab}
          onSelect={(id) => setTab(id)}
          header={<ScreenHeader title="Settings" showSidebarTrigger={false} className="border-b" />}
        >
          <div className="grid gap-3">
            <h3 className="font-semibold text-foreground">
              {SETTINGS_ITEMS.find((i) => i.id === tab)?.label}
            </h3>
            <div className="flex items-center justify-between gap-3 text-sm">
              <label htmlFor="settings-autosync">Auto-push promoted champions</label>
              <Switch id="settings-autosync" checked={autoSync} onCheckedChange={setAutoSync} />
            </div>
            <div>
              <Act onClick={() => setDialogOpen(true)}>Open ResponsiveDialog</Act>
            </div>
          </div>
        </SettingsShell>
      </div>

      <ResponsiveDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title="Adaptive dialog"
        description="Centered dialog on desktop; full-height dvh sheet on phones."
      >
        <p className="text-sm text-soft">
          This container matches fxbot's Sheetish pattern for provider setup and mobile pairing.
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <Act look="main" onClick={() => setDialogOpen(false)}>
            Done
          </Act>
        </div>
      </ResponsiveDialog>
    </div>
  );
}
