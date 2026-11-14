import { BellIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Something that waits for the owner, as a card in amber, so the eye finds it first: who asks,
 * the question, one quiet line, and its buttons with the flame one last.
 */
export function NeedCard({
  who,
  question,
  note,
  children,
}: {
  who: string;
  question: string;
  note?: string;
  /** The choices: plain ones first, the main one last. */
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-xl border border-needs-edge bg-needs-card p-4">
      <span className="inline-flex size-9 flex-none items-center justify-center rounded-full bg-needs-tint text-needs">
        <BellIcon className="size-4" />
      </span>
      <span className="flex min-w-0 flex-[1_1_320px] flex-col gap-1">
        <span className="text-xs font-semibold text-needs">{who}</span>
        <span className="text-base font-semibold">{question}</span>
        {note && <span className="text-xs text-soft">{note}</span>}
      </span>
      <span className="flex flex-wrap gap-2">{children}</span>
    </div>
  );
}
