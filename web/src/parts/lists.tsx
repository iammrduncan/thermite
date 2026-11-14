import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Up to four things, as rows with no table: a name with one line under it, its history and its
 * state in the middle, its one number at the end.
 */
export function Things({ children }: { children: ReactNode }) {
  return <ul className="flex flex-col border-b">{children}</ul>;
}

export function Thing({
  name,
  sub,
  children,
  end,
}: {
  /** The thing's name: a link to it. */
  name: ReactNode;
  sub?: string;
  /** The middle: a sparkline, a chip. */
  children?: ReactNode;
  end?: ReactNode;
}) {
  return (
    <li className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 border-t py-2">
      <span className="flex min-w-0 flex-[0_0_100%] flex-col gap-1 @2xl:flex-[0_0_320px]">
        <span className="truncate font-semibold">{name}</span>
        {sub && <span className="truncate text-xs text-quiet">{sub}</span>}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-4 text-soft">{children}</span>
      <span className="flex items-center gap-4">{end}</span>
    </li>
  );
}

/** What a thing is, as at most six facts: a label and its value. */
export function Facts({ facts }: { facts: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid max-w-[720px] grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-4 gap-y-2">
      {facts.map((f) => (
        <div key={f.label} className="contents">
          <dt className="text-quiet">{f.label}</dt>
          <dd className="min-w-0">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Text a person may copy: an id, a field, a query. */
export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs">{children}</span>;
}

/**
 * A table, from five rows: a name with one line under it, then at most four more columns, one
 * line in a cell. It scrolls sideways when the screen is narrower than it.
 */
export function Grid({
  label,
  columns,
  heads,
  rows,
  foot,
  dense = false,
}: {
  label: string;
  /** The columns' widths, as a grid's tracks: "minmax(0,1fr) 112px 96px 96px". */
  columns: string;
  heads: string[];
  rows: { key: string; cells: ReactNode[] }[];
  foot?: ReactNode;
  /** The explorer's rows: 36 px high, with heads in 600. */
  dense?: boolean;
}) {
  const grid = { gridTemplateColumns: columns };
  return (
    <div className="overflow-x-auto">
      <table aria-label={label} className={cn("block", dense ? "min-w-[560px]" : "min-w-[640px]")}>
        <thead className="block">
          <tr
            style={grid}
            className={cn(
              "grid items-center text-xs text-quiet",
              dense ? "h-8 gap-3 font-semibold" : "gap-4 py-2",
            )}
          >
            {heads.map((h, i) => (
              <th
                // biome-ignore lint/suspicious/noArrayIndexKey: a head may be empty, and the columns never move
                key={i}
                scope="col"
                className={cn("truncate p-0 text-left", dense ? "font-semibold" : "font-normal")}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="block">
          {rows.map((r) => (
            <tr
              key={r.key}
              style={grid}
              className={cn(
                "grid items-center border-t",
                dense ? "h-9 gap-3" : "min-h-10 gap-4 py-2",
              )}
            >
              {r.cells.map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a row's cells are its columns, in order
                <td key={i} className="min-w-0 truncate p-0">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {foot && (
          <tfoot className="block">
            <tr className="block">
              <td
                className={cn(
                  "block border-t p-0 text-xs text-quiet",
                  dense ? "flex h-9 items-center" : "py-2",
                )}
              >
                {foot}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** A table's first cell: the name, and one line under it. */
export function Named({ name, sub }: { name: ReactNode; sub?: string }) {
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="truncate font-semibold">{name}</span>
      {sub && <span className="truncate text-xs font-normal text-quiet">{sub}</span>}
    </span>
  );
}
