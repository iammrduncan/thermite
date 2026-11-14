import type { Tone } from "@core/api/control/dashboard.ts";
import {
  BookmarkIcon,
  ClockIcon,
  FileTextIcon,
  GaugeIcon,
  SearchIcon,
  UserIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Segmented } from "./field.tsx";
import { toneBar } from "./tone.ts";

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
 */
export function Band({
  slots,
  labels,
  span,
}: {
  slots: BandSlot[];
  /** A word under a slot: a day. */
  labels: { slot: number; text: string }[];
  /** The slots that are looked at: the first and the one after the last. */
  span?: [number, number];
}) {
  const W = 960;
  const step = W / Math.max(1, slots.length);
  const total = (s: BandSlot) => STACK.reduce((n, t) => n + (s[t] ?? 0), 0);
  const unit = 92 / Math.max(1, ...slots.map(total));
  return (
    <svg
      role="img"
      aria-label="Records over time"
      viewBox={`0 0 ${W} 114`}
      className="block h-auto w-full"
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
      {span && (
        <g className="fill-working stroke-working">
          <rect
            x={span[0] * step}
            y={0}
            width={(span[1] - span[0]) * step}
            height={96}
            fillOpacity={0.08}
            stroke="none"
          />
          <line x1={span[0] * step} x2={span[0] * step} y1={0} y2={96} strokeWidth={2} />
          <line x1={span[1] * step - 1} x2={span[1] * step - 1} y1={0} y2={96} strokeWidth={2} />
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
