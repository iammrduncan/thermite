import { cn } from "@/lib/utils";

/**
 * A change of a number: an arrow and its words. It is green when it is better and red when it is
 * worse, whatever its direction; control says which.
 */
export function Change({
  direction,
  better,
  children,
  className,
}: {
  direction: "up" | "down";
  better: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-sm font-semibold whitespace-nowrap",
        better ? "text-good" : "text-wrong",
        className,
      )}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="size-3 flex-none"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={direction === "up" ? "M12 19V5M5 12l7-7 7 7" : "M12 5v14M19 12l-7 7-7-7"} />
      </svg>
      {children}
    </span>
  );
}
