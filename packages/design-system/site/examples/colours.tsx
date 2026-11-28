/** Semantic tokens mapped in `src/theme/base.css` and customized per preset. */
const USES: { name: string; use: string; swatch: string }[] = [
  { name: "bg-background", use: "Page canvas and default surface", swatch: "bg-background" },
  { name: "bg-sidebar", use: "Sidebar paper and recessed container", swatch: "bg-sidebar" },
  { name: "bg-chosen", use: "Selected or hovered neutral row", swatch: "bg-chosen" },
  { name: "border-line", use: "Row dividers and card borders", swatch: "bg-line" },
  { name: "border-edge", use: "Control borders", swatch: "bg-edge" },
  { name: "text-quiet", use: "Secondary labels and timestamps", swatch: "bg-quiet" },
  { name: "text-soft", use: "Body copy beside headings", swatch: "bg-soft" },
  { name: "text-foreground", use: "Primary text and numbers", swatch: "bg-foreground" },
  { name: "bg-primary", use: "Primary call-to-action button", swatch: "bg-primary" },
  {
    name: "text-brand-accent",
    use: "Links, active tab rule, active nav",
    swatch: "bg-brand-accent",
  },
  {
    name: "bg-brand-accent-tint",
    use: "Active nav and tree highlight tint",
    swatch: "bg-brand-accent-tint",
  },
  {
    name: "text-brand-mark",
    use: "Folder and emblem accent (never text)",
    swatch: "bg-brand-mark",
  },
  { name: "text-good on bg-good-tint", use: "Kept, complete, improvement", swatch: "bg-good" },
  { name: "text-working on bg-working-tint", use: "In progress, judging", swatch: "bg-working" },
  { name: "text-needs on bg-needs-tint", use: "Waiting for owner decision", swatch: "bg-needs" },
  { name: "text-wrong on bg-wrong-tint", use: "Failed, invalid, regression", swatch: "bg-wrong" },
  { name: "text-idle on bg-idle-tint", use: "Paused, stopped, neutral", swatch: "bg-idle" },
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
