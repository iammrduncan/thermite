import { Fold, Frame, NavLine, Nothing, Screen, Section, TextLink } from "@ds";
import { type ComponentType, useEffect, useState } from "react";
import { follow, here, to } from "./nav.ts";
import { type Example, PAGES, type Page } from "./pages.ts";

/**
 * The design system's site: a page for each group of parts. Each example is shown as it draws,
 * with its rule, and with its code as an app would write it. The site is made of the parts it
 * shows.
 */

/** Each example, as it draws and as its source. */
const DRAWN = import.meta.glob<{ default: ComponentType }>("./examples/*.tsx", { eager: true });
const CODE = import.meta.glob<string>("./examples/*.tsx", {
  eager: true,
  query: "?raw",
  import: "default",
});

function usePath(): string {
  const [path, setPath] = useState(here);
  useEffect(() => {
    const moved = () => setPath(here());
    addEventListener("popstate", moved);
    return () => removeEventListener("popstate", moved);
  }, []);
  return path;
}

export function Site() {
  const path = usePath();
  const page = path === "/" ? PAGES[0] : PAGES.find((p) => `/${p.id}` === path);
  return (
    <Frame
      name="Design system"
      home={to("/")}
      onHome={follow}
      nav={PAGES.map((p, i) => (
        <NavLine
          key={p.id}
          href={to(i === 0 ? "/" : `/${p.id}`)}
          onClick={follow}
          icon={p.icon}
          label={p.title}
          chosen={p.id === page?.id}
        />
      ))}
    >
      {page ? <PageOf page={page} /> : <NoPage />}
    </Frame>
  );
}

function PageOf({ page }: { page: Page }) {
  return (
    <Screen title={page.title} sentence={page.sentence}>
      {page.examples.map((example) => (
        <Shown key={example.file} example={example} />
      ))}
    </Screen>
  );
}

/** One example: its rule, the part as it draws, and its code. */
function Shown({ example }: { example: Example }) {
  const Drawn = DRAWN[`./examples/${example.file}.tsx`]?.default;
  const code = CODE[`./examples/${example.file}.tsx`];
  return (
    <Section title={example.title}>
      <p className="max-w-[720px] text-soft">{example.rule}</p>
      {/* A part that fills a whole page is shown at a fixed height here. */}
      <div data-example={example.file} className="@container py-2 [&>main]:min-h-[420px]">
        {Drawn ? <Drawn /> : <Nothing>This example is missing.</Nothing>}
      </div>
      {code && (
        <Fold title="Its code">
          <pre className="overflow-x-auto rounded-md bg-sidebar p-4 font-mono text-xs text-foreground">
            {code}
          </pre>
        </Fold>
      )}
    </Section>
  );
}

function NoPage() {
  return (
    <Screen title="Not found" sentence="The design system has no page at this address.">
      <p>
        <TextLink href={to("/")} onClick={follow}>
          Foundations
        </TextLink>
      </p>
    </Screen>
  );
}
