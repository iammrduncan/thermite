import { CheckIcon, CopyIcon } from "lucide-react";
import { useRef, useState } from "react";

/**
 * Copies text to the clipboard. Over plain HTTP (such as a LAN host), `navigator.clipboard` is
 * unavailable, so a hidden read-only textarea with `document.execCommand("copy")` falls back.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Clipboard API refused (missing permission or unfocused document): try execCommand fallback.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.className = "sr-only";
  document.body.append(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    // Copy unavailable: caller selects visible text for manual copy.
  }
  area.remove();
  return copied;
}

/** An ID that one click copies, with plain-HTTP fallback and manual-selection fallback. */
export function CopyId({ id, label }: { id: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const text = useRef<HTMLSpanElement>(null);
  return (
    <button
      type="button"
      title={`Copy ${label}`}
      aria-label={`Copy ${label} ${id}`}
      className="inline-flex max-w-full items-center gap-1 rounded-md px-1 font-mono text-xs text-quiet outline-none hover:bg-chosen hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => {
        void copyText(id).then((done) => {
          if (done) {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } else if (text.current) getSelection()?.selectAllChildren(text.current);
        });
      }}
    >
      <span ref={text} className="truncate">
        {id}
      </span>
      {copied ? (
        <CheckIcon className="size-3 shrink-0" />
      ) : (
        <CopyIcon className="size-3 shrink-0" />
      )}
    </button>
  );
}
