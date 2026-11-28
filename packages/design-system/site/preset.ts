import { useEffect, useState } from "react";
import fxbotCss from "../src/theme/presets/fxbot.css?inline";
import thermiteCss from "../src/theme/presets/thermite.css?inline";

export type PresetId = "thermite" | "fxbot";

export const PRESETS: readonly { value: PresetId; label: string }[] = [
  { value: "thermite", label: "Thermite" },
  { value: "fxbot", label: "fxbot" },
] as const;

const STORAGE_KEY = "magnesium.gallery.preset";
const STYLE_ID = "magnesium-preset";
const CSS_BY_PRESET: Record<PresetId, string> = {
  thermite: thermiteCss,
  fxbot: fxbotCss,
};

function parsePreset(raw: string | null): PresetId | null {
  return raw === "thermite" || raw === "fxbot" ? raw : null;
}

/** Resolves initial preset from `?preset=thermite|fxbot`, falling back to localStorage, then thermite. */
export function initialPreset(): PresetId {
  const fromUrl = parsePreset(new URLSearchParams(location.search).get("preset"));
  if (fromUrl) return fromUrl;
  try {
    const saved = parsePreset(localStorage.getItem(STORAGE_KEY));
    if (saved) return saved;
  } catch {
    // Ignore storage read errors.
  }
  return "thermite";
}

/** Applies the exact unmodified preset stylesheet into `<style id="magnesium-preset">`. */
export function applyPreset(preset: PresetId): void {
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.append(style);
  }
  style.textContent = CSS_BY_PRESET[preset];
  document.documentElement.dataset.preset = preset;
  try {
    localStorage.setItem(STORAGE_KEY, preset);
  } catch {
    // Ignore storage write errors.
  }
  const url = new URL(location.href);
  if (url.searchParams.get("preset") !== preset) {
    url.searchParams.set("preset", preset);
    history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }
}

export function usePreset(): [PresetId, (next: PresetId) => void] {
  const [preset, setPresetState] = useState<PresetId>(initialPreset);

  useEffect(() => {
    applyPreset(preset);
  }, [preset]);

  useEffect(() => {
    const sync = () => {
      const fromUrl = parsePreset(new URLSearchParams(location.search).get("preset"));
      if (fromUrl) setPresetState(fromUrl);
    };
    addEventListener("popstate", sync);
    return () => removeEventListener("popstate", sync);
  }, []);

  return [preset, setPresetState];
}
