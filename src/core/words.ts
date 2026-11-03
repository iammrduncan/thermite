/** A list in words: "goldens, real-file and ops". */
export function listText(xs: string[]): string {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
}

/** Bytes as people read them: "812 B", "4.2 KiB", "38.0 MiB", "1.20 GiB". */
export function sizeWords(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KiB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MiB`;
  return `${(b / 1024 ** 3).toFixed(2)} GiB`;
}

/** A value as text: a string as it is, nothing as "", anything else as String gives it. */
export const str = (v: unknown) =>
  typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);

/** A text cut to `n` characters, the last one an ellipsis when it is cut. */
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
