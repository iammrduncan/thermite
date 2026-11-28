import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useSidebar } from "../primitives/sidebar.tsx";

const DEFAULT_PREFIX = "magnesium.width.";
const widths = new Map<string, number | null>();
const listeners = new Set<() => void>();

function storageKey(name: string, prefix: string): string {
  return `${prefix}${name}`;
}

function readStored(key: string): number | null {
  if (!widths.has(key)) {
    let value: number | null = null;
    try {
      const saved = Number(localStorage.getItem(key));
      if (saved > 0) value = saved;
    } catch {
      // Storage unavailable (private mode or SSR): keep default null width.
    }
    widths.set(key, value);
  }
  return widths.get(key) ?? null;
}

function writeStored(key: string, value: number | null): void {
  widths.set(key, value);
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch {
    // Ignore storage write errors.
  }
  for (const listener of listeners) listener();
}

/** Persists a resizable pane width in pixels per browser, or `null` for the default width. */
export function usePaneWidth(
  name: string,
  storagePrefix = DEFAULT_PREFIX,
): [number | null, (value: number | null) => void] {
  const key = storageKey(name, storagePrefix);
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => readStored(key),
    () => null,
  );
  return [value, (next) => writeStored(key, next)];
}

/** Alias of `usePaneWidth` for drop-in compatibility. */
export const useWidth = usePaneWidth;

export const MAIN_PANE_MIN = 320;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

export interface ResizeGutterProps {
  label: string;
  /** The pane edge the gutter sits on: `"right"` for a left pane, `"left"` for a right pane. */
  edge: "left" | "right";
  width: number | null;
  /** Target element and CSS property mutated directly during pointer drag. */
  target: () => HTMLElement | null;
  property: string;
  css: (px: number) => string;
  /** Current rendered width, min/max bounds, and snap-to-default width in pixels. */
  measure: () => number;
  bounds: () => { min: number; max: number };
  home: () => number;
  keep: (px: number | null) => void;
  /** Optional drag-to-close / click-to-reopen hook. */
  shut?: { shut: boolean; set: (shut: boolean) => void };
}

/**
 * WAI-ARIA window splitter gutter between two panes.
 * Supports pointer drag (17 px coarse touch target via `.gutter`), 8 px default snap,
 * double-click reset, Escape cancel, drag-to-close, and keyboard resize (Arrow/Shift+Arrow/Home/End/Enter).
 */
export function ResizeGutter({
  label,
  edge,
  width,
  target,
  property,
  css,
  measure,
  bounds,
  home,
  keep,
  shut,
}: ResizeGutterProps) {
  const grows = edge === "right" ? 1 : -1;
  const [dragging, setDragging] = useState(false);
  const gone = useRef<(() => void) | null>(null);
  useEffect(() => () => gone.current?.(), []);

  const cursorAt = (px: number, { min, max }: { min: number; max: number }) =>
    px <= min
      ? grows > 0
        ? "e-resize"
        : "w-resize"
      : px >= max
        ? grows > 0
          ? "w-resize"
          : "e-resize"
        : "col-resize";

  const save = (px: number | null) => keep(px === null || px === home() ? null : px);

  function down(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const root = document.documentElement;
    const el = target();
    const drawn = el?.style.getPropertyValue(property) ?? "";
    const undraw = () => {
      if (drawn) el?.style.setProperty(property, drawn);
      else el?.style.removeProperty(property);
    };
    const startX = event.clientX;
    const wasShut = Boolean(shut?.shut);
    const from = wasShut ? 0 : measure();
    const limits = bounds();
    const snap = home();
    let now = from;
    let closed = wasShut;
    let moved = false;
    root.dataset.resizing = "";
    root.style.setProperty("--resize-cursor", cursorAt(from, limits));
    setDragging(true);

    const move = (e: globalThis.PointerEvent) => {
      if (!moved && Math.abs(e.clientX - startX) <= 2) return;
      moved = true;
      const raw = from + (e.clientX - startX) * grows;
      if (shut && raw < limits.min * 0.6) {
        if (!closed) {
          closed = true;
          shut.set(true);
        }
        root.style.setProperty("--resize-cursor", grows > 0 ? "e-resize" : "w-resize");
        return;
      }
      if (closed) {
        closed = false;
        shut?.set(false);
      }
      let px = clamp(Math.round(raw), limits.min, limits.max);
      if (Math.abs(px - snap) <= 8) px = snap;
      now = px;
      el?.style.setProperty(property, css(px));
      root.style.setProperty("--resize-cursor", cursorAt(px, limits));
    };

    const quit = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", cancel);
      removeEventListener("keydown", onEscape, true);
      delete root.dataset.resizing;
      root.style.removeProperty("--resize-cursor");
      gone.current = null;
    };

    const up = () => {
      quit();
      setDragging(false);
      if (!moved) {
        if (wasShut) shut?.set(false);
        return;
      }
      undraw();
      if (!closed) save(now);
    };

    const cancel = () => {
      quit();
      setDragging(false);
      undraw();
      if (closed !== wasShut) shut?.set(wasShut);
    };

    const onEscape = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
    };

    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", cancel);
    addEventListener("keydown", onEscape, true);
    gone.current = quit;
  }

  function key(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (shut) shut.set(!shut.shut);
      else save(null);
      return;
    }
    const limits = bounds();
    const step = event.shiftKey ? 64 : 16;
    const from = shut?.shut ? 0 : measure();
    const next =
      event.key === "ArrowRight"
        ? from + step * grows
        : event.key === "ArrowLeft"
          ? from - step * grows
          : event.key === "Home"
            ? limits.min
            : event.key === "End"
              ? limits.max
              : null;
    if (next === null) return;
    event.preventDefault();
    if (shut?.shut) shut.set(false);
    save(clamp(next, limits.min, limits.max));
  }

  const limits = bounds();
  return (
    // biome-ignore lint/a11y/useSemanticElements: interactive WAI-ARIA vertical window splitter requires a focusable separator div
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={shut?.shut ? 0 : Math.round(width ?? home())}
      aria-valuemin={shut ? 0 : limits.min}
      aria-valuemax={Math.max(limits.min, limits.max)}
      tabIndex={0}
      className="gutter"
      data-edge={edge}
      data-dragging={dragging || undefined}
      onPointerDown={down}
      onPointerEnter={(e) => {
        e.currentTarget.style.cursor = shut?.shut
          ? grows > 0
            ? "e-resize"
            : "w-resize"
          : cursorAt(measure(), bounds());
      }}
      onDoubleClick={() => save(null)}
      onKeyDown={key}
    />
  );
}

/** Alias of `ResizeGutter`. */
export const Gutter = ResizeGutter;

export const sidebarWidth = (px: number | null) => (px === null ? "16rem" : `min(${px}px, 35vw)`);

/** Resizable gutter attached to the desktop sidebar's right edge (200–480 px, drag-to-close). */
export function SidebarGutter({
  storagePrefix = DEFAULT_PREFIX,
  storageKey: name = "sidebar",
}: {
  storagePrefix?: string;
  storageKey?: string;
} = {}) {
  const { open, setOpen, isMobile } = useSidebar();
  const [width, setWidth] = usePaneWidth(name, storagePrefix);
  if (isMobile) return null;
  return (
    <ResizeGutter
      label="Resize the sidebar"
      edge="right"
      width={width}
      target={() => document.querySelector<HTMLElement>('[data-slot="sidebar-wrapper"]')}
      property="--sidebar-width"
      css={sidebarWidth}
      measure={() =>
        document.querySelector('[data-slot="sidebar-container"]')?.getBoundingClientRect().width ??
        256
      }
      bounds={() => ({ min: 200, max: Math.min(480, Math.round(innerWidth * 0.35)) })}
      home={() => 256}
      keep={setWidth}
      shut={{ shut: !open, set: (isShut) => setOpen(!isShut) }}
    />
  );
}

/** Resizable gutter for a right-hand detail or beside pane. */
export function PaneGutter({
  pane,
  label,
  min,
  max,
  mainMin = MAIN_PANE_MIN,
  home,
  width,
  setWidth,
  close,
}: {
  pane: RefObject<HTMLElement | null>;
  label: string;
  min: number;
  max?: number;
  /** Minimum width preserved for the primary pane beside this aside. */
  mainMin?: number;
  home: (row: number) => number;
  width: number | null;
  setWidth: (px: number | null) => void;
  close?: () => void;
}) {
  const row = () => pane.current?.parentElement?.clientWidth ?? innerWidth;
  return (
    <ResizeGutter
      label={label}
      edge="left"
      width={width}
      target={() => pane.current}
      property="width"
      css={(px) => `${px}px`}
      measure={() => pane.current?.getBoundingClientRect().width ?? home(row())}
      bounds={() => ({ min, max: Math.min(max ?? Number.POSITIVE_INFINITY, row() - mainMin) })}
      home={() => Math.round(home(row()))}
      keep={setWidth}
      shut={close ? { shut: false, set: (isShut) => isShut && close() } : undefined}
    />
  );
}
