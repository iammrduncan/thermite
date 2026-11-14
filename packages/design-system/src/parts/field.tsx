import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/utils.ts";

/** The help behind a label: an "i" whose words show under a pointer and to a screen reader. */
export function Info({ children }: { children: string }) {
  return (
    <span
      role="img"
      title={children}
      aria-label={children}
      className="inline-flex size-4 flex-none cursor-help items-center justify-center rounded-full border border-edge text-xs text-quiet"
    >
      i
    </span>
  );
}

/**
 * One thing a form asks: a label with its "i", and one control with an example in it. No hint
 * sits under a field.
 */
export function Field({
  label,
  help,
  htmlFor,
  children,
}: {
  label: string;
  help: string;
  /** The control's id, so the label names it. */
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="flex items-center gap-2">
        <label htmlFor={htmlFor} className="font-semibold">
          {label}
        </label>
        <Info>{help}</Info>
      </span>
      {children}
    </div>
  );
}

/** What every control of a form looks like: 36 px high, the edge around it. */
const CONTROL =
  "box-border w-full max-w-[480px] rounded-md border border-edge bg-background px-2 text-sm text-foreground outline-none placeholder:text-quiet focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 aria-invalid:border-wrong";

export function TextInput({ className, ...rest }: ComponentProps<"input">) {
  return <input className={cn(CONTROL, "h-9", className)} {...rest} />;
}

export function TextArea({ className, rows = 3, ...rest }: ComponentProps<"textarea">) {
  return (
    <textarea
      rows={rows}
      className={cn(CONTROL, "max-w-[720px] resize-y py-2", className)}
      {...rest}
    />
  );
}

/** A choice of many: the browser's own list. */
export function Select({ className, ...rest }: ComponentProps<"select">) {
  return <select className={cn(CONTROL, "h-9", className)} {...rest} />;
}

/**
 * A choice of a few, all in sight: one of them is chosen. The small one is for a tool's switch,
 * such as how a query is written.
 */
export function Segmented<T extends string>({
  label,
  options,
  chosen,
  onChoose,
  small = false,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  chosen: T;
  onChoose: (value: T) => void;
  small?: boolean;
}) {
  return (
    <span
      role="radiogroup"
      aria-label={label}
      className="inline-flex self-start overflow-hidden rounded-md border border-edge"
    >
      {options.map((o, i) => (
        // biome-ignore lint/a11y/useSemanticElements: one control in the look of a segmented switch
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === chosen}
          onClick={() => onChoose(o.value)}
          className={cn(
            "inline-flex items-center outline-none focus-visible:bg-chosen",
            small ? "h-7 px-2 text-xs" : "h-9 px-4 text-sm",
            i > 0 && "border-l border-edge",
            o.value === chosen
              ? "bg-chosen font-semibold text-foreground"
              : "text-soft hover:bg-chosen",
          )}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

/** What a form leaves out of its first part: closed when you arrive, its defaults said in words. */
export function Fold({ title = "Advanced", children }: { title?: string; children: ReactNode }) {
  return (
    <details className="border-y">
      <summary className="flex min-h-14 cursor-pointer list-none items-center font-semibold outline-none focus-visible:text-flame [&::-webkit-details-marker]:hidden">
        {title}
      </summary>
      <div className="flex flex-col gap-4 pb-6 text-soft">{children}</div>
    </details>
  );
}

/** Settings that belong together: a title, one line on what they are for, then the settings. */
export function Group({
  title,
  about,
  children,
}: {
  title: string;
  about: string;
  children: ReactNode;
}) {
  return (
    <fieldset className="flex flex-col gap-4 border-t pt-6 first:border-t-0 first:pt-0">
      <legend className="contents">
        <span className="flex flex-col gap-1">
          <span className="font-semibold text-foreground">{title}</span>
          <span className="text-soft">{about}</span>
        </span>
      </legend>
      <div className="flex flex-col gap-6">{children}</div>
    </fieldset>
  );
}
