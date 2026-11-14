import {
  BookmarkIcon,
  ClockIcon,
  FileTextIcon,
  GaugeIcon,
  SearchIcon,
  UserIcon,
} from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";
import { cn } from "../lib/utils.ts";
import { Segmented } from "./field.tsx";
import { type Tone, toneBar } from "./tone.ts";

/**
 * The explorer's parts: the one place that is this dense. The fields with how many values each
 * has, the saved views, the records over time, and dense rows (lists.tsx, `Grid` with `dense`).
 */

/** A field's icon, by the kind of thing it holds. */
const KIND = {
  time: ClockIcon,
  values: BookmarkIcon,
  who: UserIcon,
  number: GaugeIcon,
  text: FileTextIcon,
} as const;

export interface ExplorerField {
  name: string;
  kind: keyof typeof KIND;
  /** How many values it has among the records found. */
  count: number;
  /** Its most common values, shown when the field is open. */
  values?: { value: string; count: number }[];
}

/** The fields beside the results: the ones shown as columns, then the others; one may be open. */
export function Fields({
  shown,
  others,
  open,
  onOpen,
}: {
  shown: ExplorerField[];
  others: ExplorerField[];
  /** The open field's name. */
  open?: string;
  onOpen: (name: string) => void;
}) {
  const group = (title: string, fields: ExplorerField[], column: boolean) => (
    <>
      <span className="flex h-7 items-center px-2 text-xs font-semibold text-quiet">
        {title}
        <span className="flex-1" />
        <span className="font-normal tabular-nums">{fields.length}</span>
      </span>
      {fields.map((f) => {
        const Icon = KIND[f.kind];
        const most = Math.max(1, ...(f.values ?? []).map((v) => v.count));
        return (
          <div key={f.name} className="flex flex-col">
            <button
              type="button"
              aria-expanded={f.values ? f.name === open : undefined}
              onClick={() => onOpen(f.name)}
              className="flex h-7 items-center gap-2 rounded-md px-2 text-left text-xs outline-none hover:bg-chosen focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon className={cn("size-3.5 flex-none", column ? "text-flame" : "text-quiet")} />
              <span className="min-w-0 flex-1 truncate font-mono">{f.name}</span>
              <span className="text-quiet tabular-nums">{f.count}</span>
            </button>
            {f.name === open && f.values && (
              <ul className="mb-2 flex flex-col rounded-md bg-sidebar p-2">
                {f.values.map((v) => (
                  <li
                    key={v.value}
                    className="grid h-6 grid-cols-[minmax(0,1fr)_32px_24px] items-center gap-2 text-xs"
                  >
                    <span className="truncate">{v.value}</span>
                    <span className="h-1.5 rounded-full bg-chosen">
                      <span
                        style={{ width: `${Math.round((v.count / most) * 100)}%` }}
                        className="block h-1.5 rounded-full bg-idle-mark"
                      />
                    </span>
                    <span className="text-right text-quiet tabular-nums">{v.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </>
  );
  return (
    <div className="flex flex-col rounded-xl border bg-card p-2">
      <span className="mb-2 flex h-8 items-center gap-2 rounded-md bg-sidebar px-2 text-xs text-quiet">
        <SearchIcon className="size-3.5" /> Find a field
      </span>
      {group("Shown as columns", shown, true)}
      <span className="h-2" />
      {group("Other fields", others, false)}
    </div>
  );
}

/** How a query is written. */
const HOW = [
  { value: "filters", label: "Filters" },
  { value: "sql", label: "SQL" },
] as const;
export type QueryHow = (typeof HOW)[number]["value"];

/** The saved views of a tool, quieter than tabs, and the switch between filters and SQL. */
export function Views({
  views,
  chosen,
  onChoose,
  onSave,
  how,
  onHow,
}: {
  views: string[];
  chosen: string;
  onChoose: (view: string) => void;
  onSave: () => void;
  how: QueryHow;
  onHow: (how: QueryHow) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="pr-1 text-xs text-quiet">Views</span>
      {views.map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={v === chosen}
          onClick={() => onChoose(v)}
          className={cn(
            "inline-flex h-7 items-center rounded-md px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
            v === chosen ? "bg-chosen font-semibold text-foreground" : "text-quiet hover:bg-chosen",
          )}
        >
          {v}
        </button>
      ))}
      <button
        type="button"
        onClick={onSave}
        className="rounded-sm px-2 text-xs text-quiet underline underline-offset-[3px] outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        Save view
      </button>
      <span className="flex-1" />
      <Segmented
        label="How the query is written"
        options={HOW}
        chosen={how}
        onChoose={onHow}
        small
      />
    </div>
  );
}

/** One slot of time in the band: how many records of each outcome it holds. */
export type BandSlot = Partial<Record<Tone, number>>;

/** The order a slot's records are stacked in, from the baseline up. */
const STACK: Tone[] = ["good", "none", "wrong", "needs", "working"];

/**
 * The records over time, stacked by outcome, with the time that is looked at shaded. It is as
 * wide as the screen gives it.
 *
 * With `onSpan`, the time is picked on the band itself: a drag across it picks the slots it
 * crosses, the arrow keys move the picked time by a slot (with Shift, its end), and Escape looks
 * at all of it again.
 */
export function Band({
  slots,
  labels,
  span,
  onSpan,
}: {
  slots: BandSlot[];
  /** A word under a slot: a day. */
  labels: { slot: number; text: string }[];
  /** The slots that are looked at: the first and the one after the last. */
  span?: [number, number];
  /** Takes the time a person picks; none when they look at all of it again. */
  onSpan?: (span: [number, number] | undefined) => void;
}) {
  const W = 960;
  const count = Math.max(1, slots.length);
  const step = W / count;
  const total = (s: BandSlot) => STACK.reduce((n, t) => n + (s[t] ?? 0), 0);
  const unit = 92 / Math.max(1, ...slots.map(total));
  const picture = useRef<SVGSVGElement>(null);
  // The slot a drag began on, and the one it is over now.
  const [drag, setDrag] = useState<[number, number]>();
  const slotAt = (x: number) => {
    const box = picture.current?.getBoundingClientRect();
    if (!box?.width) return 0;
    return Math.min(count - 1, Math.max(0, Math.floor(((x - box.left) / box.width) * count)));
  };
  const shown: [number, number] | undefined = drag
    ? [Math.min(...drag), Math.max(...drag) + 1]
    : span;
  const keys = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!onSpan) return;
    if (event.key === "Escape") return onSpan(undefined);
    const by = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (!by) return;
    event.preventDefault();
    const [from, to] = span ?? [count - 1, count];
    // With Shift the end moves alone; without, the whole time moves and keeps its length.
    const next: [number, number] = event.shiftKey
      ? [from, Math.min(count, Math.max(from + 1, to + by))]
      : [from + by, to + by];
    if (next[0] >= 0 && next[1] <= count) onSpan(next);
  };
  return (
    <svg
      ref={picture}
      role="img"
      aria-label={
        onSpan ? "Records over time. Drag across it to pick a time." : "Records over time"
      }
      viewBox={`0 0 ${W} 114`}
      // The picture takes the keys that move the picked time.
      tabIndex={onSpan ? 0 : undefined}
      onKeyDown={keys}
      onPointerDown={(event) => {
        if (!onSpan || event.button) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const at = slotAt(event.clientX);
        setDrag([at, at]);
      }}
      onPointerMove={(event) => {
        if (drag) setDrag([drag[0], slotAt(event.clientX)]);
      }}
      onPointerUp={() => {
        if (!drag) return;
        onSpan?.([Math.min(...drag), Math.max(...drag) + 1]);
        setDrag(undefined);
      }}
      onPointerCancel={() => setDrag(undefined)}
      className={cn(
        "block h-auto w-full rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
        onSpan && "cursor-crosshair touch-none select-none",
      )}
    >
      <line x1={0} x2={W} y1={96} y2={96} className="stroke-line" />
      {slots.map((s, i) => {
        let y = 96;
        return STACK.filter((t) => s[t]).map((t) => {
          const h = (s[t] ?? 0) * unit;
          y -= h;
          return (
            <rect
              // biome-ignore lint/suspicious/noArrayIndexKey: a slot is its place in time
              key={`${i}:${t}`}
              x={i * step}
              y={y}
              width={step - 2}
              height={h}
              className={toneBar[t]}
            />
          );
        });
      })}
      {shown && (
        <g data-span={`${shown[0]}-${shown[1]}`} className="fill-working stroke-working">
          <rect
            x={shown[0] * step}
            y={0}
            width={(shown[1] - shown[0]) * step}
            height={96}
            fillOpacity={0.08}
            stroke="none"
          />
          <line x1={shown[0] * step} x2={shown[0] * step} y1={0} y2={96} strokeWidth={2} />
          <line x1={shown[1] * step - 1} x2={shown[1] * step - 1} y1={0} y2={96} strokeWidth={2} />
        </g>
      )}
      {labels.map((l) => (
        <text key={l.slot} x={l.slot * step} y={110} className="fill-quiet text-xs">
          {l.text}
        </text>
      ))}
    </svg>
  );
}
