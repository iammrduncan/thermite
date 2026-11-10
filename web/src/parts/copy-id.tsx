import { CheckIcon, CopyIcon } from "lucide-react";
import { useRef, useState } from "react";

/**
 * Copies a text. A page served over plain HTTP from another machine has no clipboard of the
 * browser's newer kind, so the older way stands in: a text area, selected and copied.
 */
async function copy(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // The browser refused (no permission, or the page lost its focus): the older way is tried.
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
    // No way to copy here: the caller selects the text, to copy by hand.
  }
  area.remove();
  return copied;
}

/** An ID that one click copies: it leads no line, and it is always at hand (goal 094). */
export function CopyId({ id, label }: { id: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const text = useRef<HTMLSpanElement>(null);
  return (
    <button
      type="button"
      title={`Copy ${label}`}
      aria-label={`Copy ${label} ${id}`}
      className="inline-flex max-w-full items-center gap-1 rounded-md px-1 font-mono text-xs text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => {
        void copy(id).then((done) => {
          if (done) {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
            // Where the browser copies nothing, the ID is selected, to copy by hand.
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
