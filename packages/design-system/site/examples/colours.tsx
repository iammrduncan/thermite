/** Every colour of the theme, by its use. The class is what a part writes. */
const USES: { name: string; use: string; swatch: string }[] = [
  { name: "bg-background", use: "The page, a card", swatch: "bg-background" },
  { name: "bg-sidebar", use: "The sidebar's paper", swatch: "bg-sidebar" },
  { name: "bg-chosen", use: "Chosen, or under the pointer", swatch: "bg-chosen" },
  { name: "border-line", use: "Between rows, around cards", swatch: "bg-line" },
  { name: "border-edge", use: "A control's edge", swatch: "bg-edge" },
  { name: "text-quiet", use: "Labels, times; text is never lighter", swatch: "bg-quiet" },
  { name: "text-soft", use: "Text beside a name", swatch: "bg-soft" },
  { name: "text-foreground", use: "Names, numbers, text", swatch: "bg-foreground" },
  { name: "bg-primary", use: "The one main button", swatch: "bg-primary" },
  { name: "text-flame", use: "Links, what is chosen", swatch: "bg-flame" },
  { name: "bg-flame-tint", use: "Behind what is chosen", swatch: "bg-flame-tint" },
  { name: "text-ember", use: "The mark, a folder: never text", swatch: "bg-ember" },
  { name: "text-good on bg-good-tint", use: "Kept, complete, a gain", swatch: "bg-good" },
  { name: "text-working on bg-working-tint", use: "At work, judging", swatch: "bg-working" },
  { name: "text-needs on bg-needs-tint", use: "It waits for your word", swatch: "bg-needs" },
  { name: "text-wrong on bg-wrong-tint", use: "Failed, broken, a loss", swatch: "bg-wrong" },
  { name: "text-idle on bg-idle-tint", use: "Paused, stopped, no verdict", swatch: "bg-idle" },
];

export default function Colours() {
  return (
    <ul className="grid gap-x-6 gap-y-2 @2xl:grid-cols-2">
      {USES.map((u) => (
        <li key={u.name} className="flex items-center gap-4">
          <span className={`size-9 flex-none rounded-md border ${u.swatch}`} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-mono text-xs">{u.name}</span>
            <span className="truncate text-xs text-quiet">{u.use}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
