import { useCallback, useState } from "react";

/**
 * The navigation's two variants, to compare while one is chosen (goal 243): Library, Usage and
 * Logs as rows with words, or as icons at the foot. This browser keeps the one picked; `?nav=`
 * in an address picks one too.
 */
export type NavVariant = "rows" | "foot";

const KEY = "thermite-nav";
const read = (): NavVariant => {
  const asked = new URLSearchParams(location.search).get("nav");
  if (asked === "rows" || asked === "foot") localStorage.setItem(KEY, asked);
  return localStorage.getItem(KEY) === "foot" ? "foot" : "rows";
};

export function useNavVariant(): [NavVariant, (v: NavVariant) => void] {
  const [variant, set] = useState<NavVariant>(read);
  const pick = useCallback((v: NavVariant) => {
    localStorage.setItem(KEY, v);
    set(v);
  }, []);
  return [variant, pick];
}
