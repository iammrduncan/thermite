import { PlugIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProviderCatalogEntry } from "./types.ts";

let logosLoaded: Promise<Record<string, string>> | undefined;

function useProviderLogos(): Record<string, string> | null {
  const [logos, setLogos] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    let active = true;
    logosLoaded ??= import("./logos.ts").then((m) => m.logos);
    void logosLoaded.then(
      (map) => {
        if (active) setLogos(map);
      },
      () => {
        if (active) setLogos({});
      },
    );
    return () => {
      active = false;
    };
  }, []);
  return logos;
}

/**
 * Renders a provider's brand logo inside a light neutral badge (in both light and dark themes so
 * monochrome and colored marks read consistently). The 183-SVG bundle (`./logos.ts`) is fetched
 * lazily via dynamic `import()` on first mount.
 */
export function ProviderMark({
  entry,
  size = 32,
}: {
  entry: Pick<ProviderCatalogEntry, "id" | "name" | "modelsDev">;
  size?: number;
}) {
  const logos = useProviderLogos();
  const fallbackKey = Array.isArray(entry.modelsDev)
    ? entry.modelsDev[0]
    : typeof entry.modelsDev === "string"
      ? entry.modelsDev
      : undefined;
  const normalizedId = entry.id.replace(/-/g, "");
  const logo =
    logos?.[entry.id] ??
    logos?.[normalizedId] ??
    (fallbackKey ? (logos?.[fallbackKey] ?? logos?.[fallbackKey.replace(/-/g, "")]) : undefined);

  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: size * 0.45 }}
      className="grid shrink-0 place-items-center rounded-[24%] bg-muted font-semibold text-neutral-900 dark:bg-neutral-100"
    >
      {!logos ? null : logo ? (
        <img
          alt=""
          src={`data:image/svg+xml;utf8,${encodeURIComponent(logo)}`}
          style={{ width: size * 0.6, height: size * 0.6 }}
          className="object-contain"
        />
      ) : entry.id === "custom" ? (
        <PlugIcon style={{ width: size * 0.55, height: size * 0.55 }} />
      ) : (
        entry.name.charAt(0).toUpperCase()
      )}
    </span>
  );
}
