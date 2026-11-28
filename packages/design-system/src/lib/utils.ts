export { cn } from "cn";

/**
 * A short description for lists and cards: the first sentence, cut on a word boundary to `max`
 * characters (100 fits two lines on desktop).
 */
export function blurb(text: string | undefined, max = 100): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  const first = /^.*?[.!?](?=\s|$)/.exec(flat)?.[0] ?? flat;
  if (first.length <= max) return first;
  const cut = first.slice(0, max);
  const word = cut.lastIndexOf(" ");
  return `${(word > max / 2 ? cut.slice(0, word) : cut.slice(0, max - 1)).replace(/[\s,;:–—-]+$/, "")}…`;
}
