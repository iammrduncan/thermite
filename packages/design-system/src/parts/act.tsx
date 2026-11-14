import type { LucideIcon } from "lucide-react";
import type { ComponentProps, MouseEvent, ReactNode } from "react";
import { cn } from "../lib/utils.ts";
import { Button } from "../ui/button.tsx";

/**
 * The brand's buttons, on the stock button: 36 px high, the words in 600.
 *
 * - main: the flame, for the one thing most people came to do. One on a screen, last in its row.
 * - plain: everything else.
 * - red: work is lost.
 * - text: words alone, in the flame, for Undo and the like.
 *
 * With `href` the button is a link that looks the same.
 */
const LOOK = {
  main: "bg-primary px-4 text-primary-foreground shadow-button hover:bg-primary/90 hover:text-primary-foreground",
  plain: "border-edge bg-background px-4 text-foreground hover:bg-chosen",
  red: "border-wrong-edge bg-background px-4 text-wrong hover:bg-wrong-tint hover:text-wrong",
  text: "px-0 text-flame hover:bg-transparent hover:text-flame hover:underline hover:underline-offset-4",
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
  /** Where the button leads, when it is a link. */
  href?: string;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  className?: string;
  children: ReactNode;
} & Pick<ComponentProps<"button">, "type" | "disabled" | "title" | "aria-label">) {
  const looks = cn("gap-2 font-semibold", LOOK[look], className);
  const inside = (
    <>
      {Icon && <Icon />}
      {children}
    </>
  );
  if (href !== undefined)
    return (
      <Button variant="ghost" size="lg" className={looks} asChild>
        <a href={href} onClick={onClick} title={rest.title} aria-label={rest["aria-label"]}>
          {inside}
        </a>
      </Button>
    );
  return (
    <Button variant="ghost" size="lg" className={looks} onClick={onClick} {...rest}>
      {inside}
    </Button>
  );
}

/** A button that is an icon alone: it says what it does to a screen reader and under a pointer. */
export function IconAct({
  icon: Icon,
  label,
  className,
  ...rest
}: { icon: LucideIcon; label: string } & Omit<ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <Button
      variant="ghost"
      size="icon-lg"
      aria-label={label}
      title={label}
      className={cn("border-edge text-foreground hover:bg-chosen", className)}
      {...rest}
    >
      <Icon />
    </Button>
  );
}

/** A link in running text: the flame, with a quiet underline. */
export function TextLink({ className, ...rest }: ComponentProps<"a">) {
  return (
    <a
      className={cn(
        "rounded-sm text-flame underline decoration-flame/35 underline-offset-[3px] outline-none hover:decoration-flame focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      {...rest}
    />
  );
}
