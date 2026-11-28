import {
  Fold,
  Frame,
  NavLine,
  Nothing,
  Screen,
  Section,
  Segmented,
  TextLink,
} from "@iammrduncan/magnesium/parts";
import { type ComponentType, useEffect, useState } from "react";
import { GalleryMark } from "./demo-brand.tsx";
import { follow, here, to } from "./nav.ts";
import { type Example, PAGES, type Page } from "./pages.ts";
import { PRESETS, type PresetId, usePreset } from "./preset.ts";

/** Each gallery example as both rendered component and raw source string. */
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
  const [preset, setPreset] = usePreset();
  const page = path === "/" ? PAGES[0] : PAGES.find((p) => `/${p.id}` === path);

  const switcher = (
    <Segmented
      label="Theme preset"
      options={PRESETS}
      chosen={preset}
      onChoose={(next: PresetId) => setPreset(next)}
      small
    />
  );

  return (
    <Frame
      brand={<GalleryMark />}
      name="Magnesium"
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
      foot={
        <div className="flex flex-col gap-2 px-2 pt-2">
          <span className="text-xs font-semibold text-quiet">Preset</span>
          {switcher}
        </div>
      }
    >
      {page ? <PageOf page={page} switcher={switcher} /> : <NoPage switcher={switcher} />}
    </Frame>
  );
}

function PageOf({ page, switcher }: { page: Page; switcher: React.ReactNode }) {
  return (
    <Screen title={page.title} sentence={page.sentence} actions={switcher}>
      {page.examples.map((example) => (
        <Shown key={example.file} example={example} />
      ))}
    </Screen>
  );
}

function Shown({ example }: { example: Example }) {
  const Drawn = DRAWN[`./examples/${example.file}.tsx`]?.default;
  const code = CODE[`./examples/${example.file}.tsx`];
  return (
    <Section title={example.title}>
      <p className="max-w-[720px] text-soft">{example.rule}</p>
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

function NoPage({ switcher }: { switcher: React.ReactNode }) {
  return (
    <Screen
      title="Not found"
      sentence="The Magnesium gallery has no page at this address."
      actions={switcher}
    >
      <p>
        <TextLink href={to("/")} onClick={follow}>
          Foundations
        </TextLink>
      </p>
    </Screen>
  );
}
