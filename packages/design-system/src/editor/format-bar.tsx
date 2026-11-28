import {
  BoldIcon,
  CaseSensitiveIcon,
  CodeIcon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  SquareCodeIcon,
  StrikethroughIcon,
  TextQuoteIcon,
} from "lucide-react";
import type { EditorView } from "prosemirror-view";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { InputGroupButton } from "../primitives/input-group.tsx";
import * as formatting from "./formatting.ts";

const DEFAULT_STORAGE_KEY = "magnesium.formatBar";
const openStates = new Map<string, boolean>();
const listeners = new Set<() => void>();

function readOpen(storageKey: string): boolean {
  if (!openStates.has(storageKey)) {
    let initial = false;
    try {
      initial = localStorage.getItem(storageKey) === "1";
    } catch {
      initial = false;
    }
    openStates.set(storageKey, initial);
  }
  return openStates.get(storageKey) ?? false;
}

function writeOpen(storageKey: string, next: boolean): void {
  openStates.set(storageKey, next);
  try {
    if (next) localStorage.setItem(storageKey, "1");
    else localStorage.removeItem(storageKey);
  } catch {
    // Ignore storage write errors.
  }
  for (const listener of listeners) listener();
}

function useFormatBarOpen(storageKey: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => readOpen(storageKey),
    () => false,
  );
}

const isMac = typeof navigator !== "undefined" && /Mac|iP(hone|[oa]d)/.test(navigator.platform);

function shortcutLabel(keys: string): string {
  const parts = keys.split("-");
  const last = (parts.pop() ?? "").toUpperCase();
  const names: Record<string, string> = isMac
    ? { Mod: "⌘", Alt: "⌥", Shift: "⇧" }
    : { Mod: "Ctrl+", Alt: "Alt+", Shift: "Shift+" };
  return parts.map((part) => names[part] ?? part).join("") + last;
}

const BUTTONS = [
  { name: "strong", label: "Bold", keys: "Mod-b", Icon: BoldIcon },
  { name: "em", label: "Italic", keys: "Mod-i", Icon: ItalicIcon },
  { name: "strike", label: "Strikethrough", keys: "Mod-Shift-x", Icon: StrikethroughIcon },
  { name: "code", label: "Code", keys: "Mod-Shift-c", Icon: CodeIcon },
  { name: "link", label: "Link", keys: "Mod-Shift-u", Icon: LinkIcon },
  { name: "blockquote", label: "Quote", keys: "Mod-Shift-9", Icon: TextQuoteIcon },
  { name: "code_block", label: "Code block", keys: "Mod-Alt-Shift-c", Icon: SquareCodeIcon },
  { name: "bullet_list", label: "Bulleted list", keys: "Mod-Shift-8", Icon: ListIcon },
  { name: "ordered_list", label: "Numbered list", keys: "Mod-Shift-7", Icon: ListOrderedIcon },
] as const;

/** Toggle button (`Aa`) showing or hiding the adjacent `FormatBar`. */
export function FormatButton({
  className,
  storageKey = DEFAULT_STORAGE_KEY,
}: {
  className?: string;
  storageKey?: string;
}) {
  const shown = useFormatBarOpen(storageKey);
  return (
    <InputGroupButton
      size="icon-sm"
      className={`rounded-full ${className ?? ""}`}
      aria-label="Formatting"
      title="Formatting"
      aria-pressed={shown}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => writeOpen(storageKey, !shown)}
    >
      <CaseSensitiveIcon />
    </InputGroupButton>
  );
}

/** Formatting toolbar attached to a ProseMirror `Editor` view or container element. */
export function FormatBar({
  view: given,
  within,
  className,
  storageKey = DEFAULT_STORAGE_KEY,
}: {
  view?: EditorView | null;
  within?: { current: Element | null };
  className?: string;
  storageKey?: string;
}) {
  const shown = useFormatBarOpen(storageKey);
  useSyncExternalStore(formatting.watch, formatting.seen, formatting.seen);
  const view = given ?? formatting.viewIn(within?.current) ?? null;
  const [address, setAddress] = useState<string | null>(null);
  const [wrong, setWrong] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const dom = view?.dom;
    if (!dom || !view) return;
    const ask = () => {
      writeOpen(storageKey, true);
      setWrong(false);
      setAddress(formatting.linkAt(view.state));
    };
    dom.addEventListener("fx-format-link", ask);
    return () => dom.removeEventListener("fx-format-link", ask);
  }, [view, storageKey]);

  const asking = address !== null;
  useEffect(() => {
    if (asking) field.current?.focus();
  }, [asking]);

  if (!shown || !view) return null;
  const run = formatting.commands(view.state.schema);
  const done = () => {
    setAddress(null);
    view.focus();
  };
  const applyLink = () => {
    const typed = (address ?? "").trim();
    const href =
      !typed || /^(https?:\/\/|mailto:)/i.test(typed)
        ? typed
        : /^[a-z][\w+.-]*:/i.test(typed)
          ? null
          : `https://${typed}`;
    if (href === null) {
      setWrong(true);
      return;
    }
    formatting.setLink(view, href);
    setAddress(null);
  };

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className={`flex w-full flex-wrap items-center gap-0.5 ${className ?? ""}`}
    >
      {BUTTONS.map(({ name, label, keys, Icon }) => (
        <InputGroupButton
          key={name}
          size="icon-sm"
          className="rounded-full aria-pressed:bg-accent aria-pressed:text-accent-foreground"
          aria-label={label}
          title={`${label} (${shortcutLabel(keys)})`}
          aria-pressed={formatting.active(view.state, name)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (name === "link") {
              setWrong(false);
              setAddress(formatting.linkAt(view.state));
              return;
            }
            const cmd = run[name];
            cmd?.(view.state, view.dispatch, view);
            view.focus();
          }}
        >
          <Icon />
        </InputGroupButton>
      ))}
      {asking && (
        <span className="flex min-w-48 flex-1 items-center gap-1 px-1">
          <input
            ref={field}
            type="text"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Link address"
            aria-invalid={wrong || undefined}
            placeholder="https://… or mailto:…"
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              setWrong(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyLink();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                done();
              }
            }}
            className="h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring aria-invalid:border-destructive"
          />
          <InputGroupButton size="sm" className="rounded-full" onClick={applyLink}>
            {address?.trim() ? "Link" : "Remove"}
          </InputGroupButton>
        </span>
      )}
    </div>
  );
}
