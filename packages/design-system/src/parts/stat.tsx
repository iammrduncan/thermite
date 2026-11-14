import type { ReactNode } from "react";
import { cn } from "../lib/utils.ts";
import { type Tone, toneBar, toneStroke } from "./tone.ts";

/**
 * A number's history as a line with a soft area under it: no axis and no marks. The line is in
 * the state's colour: green for the number that is the score, grey for one that must only hold.
 */
export function Sparkline({
  values,
  tone = "none",
  height = 40,
  label = "its history",
}: {
  values: number[];
  tone?: Tone;
  height?: 28 | 40;
  label?: string;
}) {
  if (values.length < 2) return null;
  const top = Math.max(...values);
  const low = Math.min(...values);
  // The picture is 200 wide; the line runs between 5 from the top and 3 from the bottom.
  const y = (v: number) =>
    top === low ? height / 2 : height - 3 - ((v - low) / (top - low)) * (height - 8);
  const points = values.map(
    (v, i) => `${((i / (values.length - 1)) * 200).toFixed(1)},${y(v).toFixed(1)}`,
  );
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 200 ${height}`}
      preserveAspectRatio="none"
      className={cn("block w-full", height === 40 ? "h-10" : "h-7", toneStroke[tone])}
    >
      <polygon
        points={`0,${height} ${points.join(" ")} 200,${height}`}
        fillOpacity={0.1}
        stroke="none"
      />
      <polyline
        points={points.join(" ")}
        fill="none"
        strokeWidth={1.6}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** A whole as its parts: one bar, each part as wide as its count, in its state's colour. */
export function ShareBar({
  parts,
  label,
}: {
  parts: { tone: Tone; count: number }[];
  label: string;
}) {
  return (
    <span role="img" aria-label={label} className="flex h-10 items-end">
      <span className="flex h-2 w-full gap-0.5">
        {parts
          .filter((p) => p.count > 0)
          .map((p) => (
            <span
              key={p.tone}
              style={{ flexGrow: p.count }}
              className={cn("min-w-0.5 basis-0 rounded-full", toneBar[p.tone])}
            />
          ))}
      </span>
    </span>
  );
}

/**
 * A number that matters, as a tile: what it is, the number and its unit, how it changed or how
 * it stands, its history, and one quiet line. At most four in a row.
 */
export function Stat({
  label,
  number,
  unit,
  aside,
  history,
  note,
}: {
  label: string;
  number: string;
  unit?: string;
  /** Right of the number: a change with its arrow, or a state's chip. */
  aside?: ReactNode;
  /** A sparkline or a share bar. */
  history?: ReactNode;
  note?: string;
}) {
  return (
    <div className="flex min-w-0 flex-[1_1_200px] flex-col gap-2 rounded-xl border bg-card p-4">
      <span className="text-xs text-quiet">{label}</span>
      <span className="flex flex-wrap items-baseline gap-2">
        <span className="text-sentence tabular-nums">{number}</span>
        {unit && <span className="text-quiet">{unit}</span>}
        <span className="flex-1" />
        {aside}
      </span>
      {history}
      {note && <span className="text-xs text-quiet">{note}</span>}
    </div>
  );
}

/** A row of tiles: they wrap as the screen narrows. */
export function Stats({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-4">{children}</div>;
}
