import type { LucideIcon } from "lucide-react";
import type { ComponentProps, MouseEvent, ReactNode } from "react";
import { cn } from "../lib/utils.ts";
import { Button } from "../primitives/button.tsx";

/**
 * Composed action buttons on top of the stock Button primitive, scaled by `--control-h`.
 *
 * - main: brand primary, for the primary action on a screen (last in its row).
 * - plain: default secondary button.
 * - red: destructive action where work is lost.
 * - text: inline accent link-styled button (e.g. Undo).
 *
 * With `href` the button renders as an anchor with identical styling.
 */
const LOOK = {
  main: "bg-primary px-4 text-primary-foreground shadow-button hover:bg-primary/90 hover:text-primary-foreground",
  plain: "border-edge bg-background px-4 text-foreground hover:bg-chosen",
  red: "border-wrong-edge bg-background px-4 text-wrong hover:bg-wrong-tint hover:text-wrong",
  text: "px-0 text-brand-accent hover:bg-transparent hover:text-brand-accent hover:underline hover:underline-offset-4",
} as const;

export function Act({
  look = "plain",
  icon: Icon,
  href,
  onClick,
  className,
  children,
  ...rest
}: {
  look?: keyof typeof LOOK;
  icon?: LucideIcon;
  /** Destination URL when rendered as a link. */
  href?: string;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  className?: string;
  children: ReactNode;
} & Pick<ComponentProps<"button">, "type" | "disabled" | "title" | "aria-label">) {
  const looks = cn("h-(--control-h) gap-2 font-semibold", LOOK[look], className);
  const inside = (
    <>
      {Icon && <Icon />}
      {children}
    </>
  );
  if (href !== undefined)
    return (
      <Button variant="ghost" className={looks} asChild>
        <a href={href} onClick={onClick} title={rest.title} aria-label={rest["aria-label"]}>
          {inside}
        </a>
      </Button>
    );
  return (
    <Button variant="ghost" className={looks} onClick={onClick} {...rest}>
      {inside}
    </Button>
  );
}

/** An icon-only button with an accessible label and tooltip. */
export function IconAct({
  icon: Icon,
  label,
  className,
  ...rest
}: { icon: LucideIcon; label: string } & Omit<ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <Button
      variant="ghost"
      aria-label={label}
      title={label}
      className={cn("size-(--control-h) border-edge text-foreground hover:bg-chosen", className)}
      {...rest}
    >
      <Icon />
    </Button>
  );
}

/** An inline text link in the brand accent with a subtle underline. */
export function TextLink({ className, ...rest }: ComponentProps<"a">) {
  return (
    <a
      className={cn(
        "rounded-sm text-brand-accent underline decoration-brand-accent/35 underline-offset-[3px] outline-none hover:decoration-brand-accent focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      {...rest}
    />
  );
}
