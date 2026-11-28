import { CheckIcon, ChevronsUpDownIcon, LoaderCircleIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { cn } from "../lib/utils.ts";
import { Button } from "../primitives/button.tsx";
import { Input } from "../primitives/input.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../primitives/popover.tsx";
import type { ProviderModel } from "./types.ts";

/** Formats known model capabilities into a short metadata line (context window, tools, vision). */
export function aboutModel(m: ProviderModel): string {
  const tokens = m.contextWindow
    ? m.contextWindow >= 1_000_000
      ? `${+(m.contextWindow / 1_000_000).toFixed(1)}M`
      : `${Math.round(m.contextWindow / 1000)}K`
    : "";
  return [tokens && `${tokens} context`, m.supportsToolUse && "tools", m.supportsVision && "images"]
    .filter(Boolean)
    .join(" · ");
}

/**
 * API-agnostic searchable model picker with keyboard navigation and typed-ID fallback so users can
 * select a listed model or enter any unlisted model ID directly.
 */
export function ModelCombobox({
  id: givenId,
  models,
  loading = false,
  error = "",
  value,
  onChange,
  onOpen,
  onRetry,
  disabled = false,
  placeholder = "Pick a model",
  className,
}: {
  id?: string;
  models: readonly ProviderModel[] | null;
  loading?: boolean;
  error?: string;
  value: string;
  onChange: (modelId: string) => void;
  onOpen?: () => void;
  onRetry?: () => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const autoId = useId();
  const id = givenId ?? autoId;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  const typed = query.trim();
  const q = typed.toLowerCase();
  const available = models ?? [];
  const shown = available.filter(
    (m) => !q || m.id.toLowerCase().includes(q) || m.name?.toLowerCase().includes(q),
  );
  const options: ProviderModel[] = [
    ...shown,
    ...(typed && !available.some((m) => m.id === typed)
      ? [{ id: typed, name: "Use this id" }]
      : []),
  ];
  const optionId = (i: number) => `models-${id}-${i}`;

  function toggle(next: boolean) {
    setOpen(next);
    if (!next) return;
    setQuery("");
    setActive(
      Math.max(
        0,
        available.findIndex((m) => m.id === value),
      ),
    );
    onOpen?.();
  }

  function pick(model: string) {
    onChange(model);
    setOpen(false);
  }

  useEffect(() => {
    if (open) {
      document.getElementById(`models-${id}-${active}`)?.scrollIntoView({ block: "nearest" });
    }
  }, [open, id, active]);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) =>
        Math.min(
          Math.max(i + (event.key === "ArrowDown" ? 1 : -1), 0),
          Math.max(options.length - 1, 0),
        ),
      );
    } else if (event.key === "Enter") {
      const target = options[active];
      if (!target) return;
      event.preventDefault();
      pick(target.id);
    }
  }

  return (
    <div className={cn("grid gap-1", className)}>
      <Popover open={open} onOpenChange={toggle}>
        <PopoverTrigger asChild disabled={disabled}>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="h-(--control-h) w-full justify-between px-3 font-normal"
          >
            <span className={cn("truncate", !value && "text-muted-foreground")}>
              {value || placeholder}
            </span>
            <ChevronsUpDownIcon className="text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-(--radix-popover-trigger-width) min-w-64 gap-0 p-0"
        >
          <Input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls={`models-${id}`}
            aria-activedescendant={options[active] ? optionId(active) : undefined}
            aria-label="Search models, or type a model id"
            placeholder="Search, or type a model id"
            className="rounded-b-none border-0 border-b shadow-none focus-visible:ring-0"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <div
            ref={list}
            id={`models-${id}`}
            role="listbox"
            className="max-h-72 overflow-y-auto p-1"
          >
            {(loading || (models === null && !error)) && (
              <p className="flex items-center gap-2 p-2 text-muted-foreground">
                <LoaderCircleIcon className="size-4 animate-spin" /> Loading models
              </p>
            )}
            {!loading && models !== null && options.length === 0 && (
              <p className="p-2 text-muted-foreground">This provider lists no models.</p>
            )}
            {options.map((m, i) => {
              const detail = [m.name && m.name !== m.id ? m.name : "", aboutModel(m)]
                .filter(Boolean)
                .join(" · ");
              return (
                // biome-ignore lint/a11y/useFocusableInteractive: focus remains on the combobox input via aria-activedescendant
                // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection handled by combobox input
                <div
                  key={m.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={m.id === value}
                  className={cn(
                    "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5",
                    i === active && "bg-accent text-accent-foreground",
                  )}
                  onMouseMove={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(m.id)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{m.id}</span>
                    {detail && (
                      <span className="block truncate text-xs text-muted-foreground">{detail}</span>
                    )}
                  </span>
                  {m.id === value && <CheckIcon className="size-4 shrink-0" />}
                </div>
              );
            })}
          </div>
          {(error || value) && (
            <div className="flex items-center gap-2 border-t p-1.5">
              {error && (
                <span className="min-w-0 flex-1 px-1 text-xs text-destructive">{error}</span>
              )}
              {error && onRetry && (
                <Button type="button" size="xs" variant="ghost" onClick={onRetry}>
                  Try again
                </Button>
              )}
              {value && (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => pick("")}
                >
                  Clear
                </Button>
              )}
            </div>
          )}
        </PopoverContent>
      </Popover>
      {error && !open && <span className="text-xs font-normal text-destructive">{error}</span>}
    </div>
  );
}
