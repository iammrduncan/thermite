/** What happened, one sentence a row, and the charts. */
export const TIMELINE = `/* what happened: one sentence a row */
.tl-row { display: grid; grid-template-columns: 44px 8px minmax(0, 1fr) auto; gap: 10px; align-items: baseline; padding: 8px 14px; border-bottom: 1px solid var(--border); font-size: 13px; }
.tl-row:last-child { border-bottom: 0; }
.tl-t { color: var(--muted-foreground); font-size: 12px; font-variant-numeric: tabular-nums; }
.tl-row .dot { align-self: start; margin-top: 6px; }
.tl-s { min-width: 0; word-break: break-word; } .tl-s a { color: var(--primary); }
.tl-rig { color: var(--muted-foreground); font-size: 12px; white-space: nowrap; }


/* chart */
svg.chart { width: 100%; height: auto; display: block; }
svg.chart text { fill: var(--muted-foreground); font-size: 11px; font-family: var(--font-sans); }
svg.chart .grid { stroke: var(--border); }
svg.chart .line { stroke: var(--primary); fill: none; stroke-width: 2; }
svg.chart .area { fill: var(--primary); opacity: .08; }
svg.chart .pt { fill: var(--card); stroke: var(--primary); stroke-width: 2; }`;
