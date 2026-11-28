import { type ComponentType, type MouseEvent, type ReactNode, useEffect, useRef } from "react";
import { cn } from "../lib/utils.ts";
import { buttonVariants } from "../primitives/button.tsx";
import { PluginIcon } from "./plugin-icon.tsx";

export interface SettingsNavItem {
  id: string;
  label: string;
  href?: string;
  icon?: ComponentType<{ className?: string }>;
  /** Optional procedural plugin icon key rendered when `icon` is omitted. */
  iconKey?: string;
  /** Optional custom icon node. */
  iconNode?: ReactNode;
}

/**
 * Responsive settings layout: horizontally scrollable pill strip on mobile (`< lg`) with
 * auto-scroll to the active tab, transitioning to a 192 px (`w-48`) vertical rail on desktop.
 */
export function SettingsShell({
  label = "Settings",
  items,
  activeId,
  onSelect,
  header,
  error,
  className,
  children,
}: {
  label?: string;
  items: readonly SettingsNavItem[];
  activeId: string;
  onSelect?: (id: string, event: MouseEvent<HTMLElement>) => void;
  header?: ReactNode;
  error?: string;
  className?: string;
  children: ReactNode;
}) {
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!activeId && items.length === 0) return;
    void nav.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, items.length]);

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {header}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <nav
          ref={nav}
          aria-label={label}
          className="flex shrink-0 gap-1 overflow-x-auto border-b px-3 py-2 [scrollbar-width:none] lg:w-48 lg:flex-col lg:overflow-visible lg:border-b-0 lg:py-6"
        >
          {items.map((item) => {
            const Icon = item.icon;
            const active = item.id === activeId;
            const classes = buttonVariants({
              variant: "ghost",
              size: "sm",
              className:
                "shrink-0 justify-start rounded-full text-muted-foreground aria-[current=page]:bg-brand-accent-tint aria-[current=page]:font-semibold aria-[current=page]:text-brand-accent lg:rounded-md",
            });
            const body = (
              <>
                {Icon ? (
                  <Icon className="size-4 shrink-0" />
                ) : item.iconNode ? (
                  item.iconNode
                ) : (
                  item.iconKey && <PluginIcon iconKey={item.iconKey} size={16} />
                )}
                <span className="truncate">{item.label}</span>
              </>
            );
            return item.href !== undefined ? (
              <a
                key={item.id}
                href={item.href}
                aria-current={active ? "page" : undefined}
                onClick={(e) => onSelect?.(item.id, e)}
                className={classes}
              >
                {body}
              </a>
            ) : (
              <button
                key={item.id}
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={(e) => onSelect?.(item.id, e)}
                className={classes}
              >
                {body}
              </button>
            );
          })}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto grid max-w-xl gap-5">
            {error && (
              <p
                role="alert"
                className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </p>
            )}
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
