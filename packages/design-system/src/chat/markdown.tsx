import { type ComponentProps, createContext, type MouseEvent, useContext, useMemo } from "react";
import { type Components, defaultComponents, type ExtraProps, Streamdown } from "streamdown";
import { cn } from "../lib/utils.ts";
import { breaks, code } from "./said.ts";

type InternalLinkHandler = (href: string, event: MouseEvent<HTMLAnchorElement>) => void;

const InternalLinkContext = createContext<InternalLinkHandler | null>(null);

function MarkdownLink({
  node,
  href = "",
  onClick,
  className,
  ...props
}: ComponentProps<"a"> & ExtraProps) {
  const onInternalLink = useContext(InternalLinkContext);
  if (!onInternalLink || !/^\/(?!\/|api\/)/.test(href)) {
    return (
      <defaultComponents.a
        node={node}
        href={href}
        onClick={onClick}
        className={className}
        {...props}
      />
    );
  }
  return (
    <a
      {...props}
      href={href}
      target={undefined}
      rel={undefined}
      className={cn("wrap-anywhere font-medium text-primary underline", className)}
      data-streamdown="link"
      onClick={(event) => {
        onClick?.(event);
        onInternalLink(href, event);
      }}
    />
  );
}

export interface MarkdownProps extends ComponentProps<typeof Streamdown> {
  /** Optional handler for internal `/...` links (excluding `/api/...`). */
  onInternalLink?: InternalLinkHandler;
}

/**
 * Streaming-capable Markdown renderer built on `streamdown`, with optional internal-link
 * interception for client-side navigation or side-panel opening.
 */
export function Markdown({ components, onInternalLink, ...props }: MarkdownProps) {
  const mergedComponents = useMemo<Components>(
    () => (onInternalLink ? { a: MarkdownLink, ...components } : (components ?? {})),
    [components, onInternalLink],
  );

  return (
    <InternalLinkContext.Provider value={onInternalLink ?? null}>
      <Streamdown {...props} components={mergedComponents} />
    </InternalLinkContext.Provider>
  );
}

/**
 * Renders user-entered Markdown preserving single line breaks outside fenced code blocks and
 * escaping raw angle-bracket tokens outside autolinks.
 */
export function SaidMarkdown({ text, className }: { text: string; className?: string }) {
  const escaped = useMemo(
    () =>
      text
        .split(code)
        .map((piece, i) =>
          i % 2
            ? piece
            : piece.replace(
                /\\[\s\S]|<(?![a-z][a-z\d+.-]{1,31}:[^\s<>]*>|[^\s<>@]+@[^\s<>@]+>)/gi,
                (m) => (m === "<" ? "&lt;" : m),
              ),
        )
        .join(""),
    [text],
  );
  return (
    <Markdown mode="static" parseIncompleteMarkdown={false} className={className}>
      {breaks(escaped)}
    </Markdown>
  );
}
