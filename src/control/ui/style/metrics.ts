/**
 * Metrics' system tabs (goal 179): the tiles, the stacked bars and their legends, the small
 * charts, the live switch, rows that warn, and the stream inspector's filter, pager and data.
 */
export const METRICS = `/* the tabs' row: the tabs, and the live switch at its end */
.sys-tabsrow { display: flex; flex-wrap: wrap; align-items: center; gap: 0 12px; }
.sys-tabsrow .tabs { flex: 1 1 320px; min-width: 0; }
.sys-tabsrow .sys-live { margin: 0 0 16px auto; }

/* tiles and bars */
.sys-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; margin-bottom: 4px; }
.sys-tiles .fact { min-width: 0; }
.sys-spark { display: block; width: 100%; height: 32px; margin-top: 6px; color: var(--primary); }
.sys-split { display: flex; height: 8px; border-radius: 999px; overflow: hidden; background: var(--border); gap: 1px; }
.sys-split i { display: block; height: 100%; min-width: 2px; }
.sys-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 8px; font-size: 12px; color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
.sys-legend span { display: inline-flex; align-items: center; gap: 5px; }
.sys-legend b { color: var(--foreground); font-weight: 600; }
.sys-legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; }
.sys-split .s1, .sys-legend .s1 { background: var(--primary); }
.sys-split .s2, .sys-legend .s2 { background: var(--success); }
.sys-split .s3, .sys-legend .s3 { background: var(--warning); }
.sys-split .s4, .sys-legend .s4 { background: var(--violet-foreground); }
.sys-split .s5, .sys-legend .s5 { background: color-mix(in srgb, var(--primary) 45%, var(--card)); }
.sys-split .s6, .sys-legend .s6 { background: var(--error); }
.sys-barcell { min-width: 120px; } .sys-barcell .bar { margin-bottom: 2px; }
tr.sys-group th { padding-top: 14px; font-size: 12.5px; font-weight: 600; color: var(--foreground); background: var(--muted); }
[data-part="sys"] td.num, .sys-msgs td.num { white-space: nowrap; }
.sys-gap { margin: 10px 0 0; } .sys-pad { margin: 0; padding: 8px 12px; }
.sys-note { margin-bottom: 12px; }

/* rows */
tr.sys-warnrow td:first-child { box-shadow: inset 3px 0 0 var(--warning); }
tr.sys-click td a { color: inherit; }
.sys-conn summary { cursor: pointer; list-style: none; } .sys-conn summary::-webkit-details-marker { display: none; }
.sys-conn summary::before { content: "▸ "; color: var(--muted-foreground); } .sys-conn[open] summary::before { content: "▾ "; }
.sys-conn > div { margin-top: 6px; display: grid; gap: 4px; max-width: 640px; white-space: normal; }
.sys-conn code { word-break: break-all; }
.sys-rigs td { vertical-align: top; }

/* the live switch */
.sys-live { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--muted-foreground); }
.sys-pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--success); animation: sys-pulse 1.6s infinite; }
.sys-live.paused .sys-pulse { background: var(--muted-foreground); animation: none; }
@keyframes sys-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
@media (prefers-reduced-motion: reduce) { .sys-pulse { animation: none; } }

/* the stream inspector */
.sys-filter { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: end; }
.sys-filter label { display: grid; gap: 4px; font-size: 12px; color: var(--muted-foreground); }
.sys-filter input[name="subject"] { width: min(420px, 80vw); }
.sys-filter input[name="before"] { width: 140px; }
.sys-pager { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 12px 0; }
.sys-subj { word-break: break-all; }
.sys-preview { max-width: 460px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sys-preview code { font-size: 11.5px; }
.sys-data { margin: 0; max-height: 70vh; overflow: auto; font-size: 12px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }`;
