import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/utils.ts";
import { Input } from "../primitives/input.tsx";
import { NativeSelect } from "../primitives/native-select.tsx";
import { Textarea } from "../primitives/textarea.tsx";

/** Help behind a label: an "i" badge whose explanation shows on hover and to screen readers. */
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

/** A form field: a label with its "i" help icon and one control. */
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

/** Shared form control overrides layered on top of stock primitives. */
const FIELD_CONTROL =
  "max-w-[480px] rounded-md border-edge bg-background px-2 text-sm text-foreground placeholder:text-quiet focus-visible:ring-2 focus-visible:ring-ring/40 aria-invalid:border-wrong dark:bg-background";

export function TextInput({ className, ...rest }: ComponentProps<typeof Input>) {
  return <Input className={cn(FIELD_CONTROL, "h-(--control-h)", className)} {...rest} />;
}

export function TextArea({ className, rows = 3, ...rest }: ComponentProps<typeof Textarea>) {
  return (
    <Textarea
      rows={rows}
      className={cn(FIELD_CONTROL, "min-h-0 max-w-[720px] resize-y py-2", className)}
      {...rest}
    />
  );
}

/** A native select wrapped on the stock NativeSelect primitive. */
export function Select({ className, ...rest }: ComponentProps<typeof NativeSelect>) {
  return (
    <NativeSelect
      className={cn(
        "w-full max-w-[480px] [&_select]:h-(--control-h) [&_select]:rounded-md [&_select]:border-edge [&_select]:bg-background [&_select]:px-2 [&_select]:pr-8 [&_select]:aria-invalid:border-wrong dark:[&_select]:bg-background",
        className,
      )}
      {...rest}
    />
  );
}

/**
 * A choice of a few options, all visible: one of them is chosen. The `small` variant is for
 * compact toolbars such as switching between Filters and SQL.
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
            small ? "h-7 px-2 text-xs" : "h-(--control-h) px-4 text-sm",
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

/** A collapsible section closed by default, e.g. Advanced form options or example code. */
export function Fold({ title = "Advanced", children }: { title?: string; children: ReactNode }) {
  return (
    <details className="border-y">
      <summary className="flex min-h-14 cursor-pointer list-none items-center font-semibold outline-none focus-visible:text-brand-accent [&::-webkit-details-marker]:hidden">
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
