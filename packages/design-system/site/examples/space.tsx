const GAPS = [
  { px: 4, bar: "w-1", cls: "gap-1" },
  { px: 8, bar: "w-2", cls: "gap-2" },
  { px: 16, bar: "w-4", cls: "gap-4" },
  { px: 24, bar: "w-6", cls: "gap-6" },
  { px: 40, bar: "w-10", cls: "gap-10" },
];

export default function SpaceAndCorners() {
  return (
    <div className="flex flex-wrap gap-10">
      <ul className="flex flex-col gap-2">
        {GAPS.map((g) => (
          <li key={g.px} className="flex items-center gap-4 text-xs">
            <span className={`h-4 flex-none rounded-sm bg-flame-tint ${g.bar}`} />
            <span className="font-mono">{g.cls}</span>
            <span className="text-quiet">{g.px} px</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-4 text-xs text-quiet">
        <span className="flex h-9 items-center rounded-md border border-edge px-4">
          8 px: a control, a row
        </span>
        <span className="flex h-16 items-center rounded-xl border px-4">
          16 px: a card, a dialog
        </span>
        <span className="flex h-6 items-center rounded-full bg-chosen px-2">round: a chip</span>
      </div>
    </div>
  );
}
