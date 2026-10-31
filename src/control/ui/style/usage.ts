/** Model use and cost: a run's top and Stats tab, a campaign's sidebar, Metrics, Model prices. */
export const USAGE = `/* goal 075: model use and cost (a run's top and Stats tab, a campaign's sidebar, Metrics, Model prices) */
#model-use { margin-bottom: 18px; }
/* A campaign's page has model use in its sidebar: its Knowledge block stacks in the main column. */
.run-cols .kbcols { grid-template-columns: minmax(0, 1fr); gap: 12px; }
.ufacts { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1.5fr) repeat(4, minmax(0, 1fr)); gap: 10px; margin: 0 0 6px; }
.ufacts .fact { padding: 10px 12px; min-width: 0; }
.ufacts .fact .v { font-size: 22px; letter-spacing: -.01em; }
.ufacts .fact .v .u { font-size: 12px; font-weight: 500; color: var(--muted-foreground); letter-spacing: 0; }
.ufacts .fact .s { font-variant-numeric: tabular-nums; }
.ufacts .nr, .uside .nr { font-size: 15px; font-weight: 500; font-style: italic; color: var(--muted-foreground); }
.ufacts .s .ii, .uside .s .ii { display: inline-grid; margin-right: 5px; vertical-align: -3px; }
.usplit { display: flex; height: 6px; margin: 8px 0 6px; border-radius: 999px; overflow: hidden; background: var(--border); gap: 1px; }
.usplit i { display: block; height: 100%; min-width: 2px; }
.usplit .c, .ulg i.c { background: var(--primary); }
.usplit .n, .ulg i.n { background: color-mix(in srgb, var(--foreground) 30%, transparent); }
.usplit .r, .ulg i.r { background: repeating-linear-gradient(135deg, var(--muted-foreground) 0 2px, transparent 2px 4px); }
.usplit .o, .ulg i.o { background: var(--violet-foreground); }
.usplit .g, .ulg i.g { background: var(--warning); }
.ulg { display: flex; flex-wrap: wrap; gap: 2px 12px; font-size: 12px; color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
.ulg span { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.ulg b { color: var(--foreground); font-weight: 600; }
.ulg i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; }
.uspark { display: flex; align-items: flex-end; gap: 2px; height: 20px; margin-top: 6px; }
.uspark i { flex: 1; min-width: 1px; border-radius: 1px; background: color-mix(in srgb, var(--primary) 55%, transparent); }
.u-h { margin: 16px 0 6px; font-size: 12.5px; font-weight: 600; }
.utw { overflow-x: auto; }
.ut { font-size: 12.5px; }
.ut th, .ut td { padding: 7px 10px; }
.ut td { vertical-align: top; }
.ut td.num { white-space: nowrap; }
.ut th .lb { font-weight: 500; }
.ut th.num .lb { justify-content: flex-end; }
.ut .u-m { font-weight: 600; }
.ut .us { display: block; margin-top: 1px; font-size: 11.5px; color: var(--muted-foreground); white-space: nowrap; }
.ut .nr { font-size: 11.5px; font-style: italic; color: var(--muted-foreground); white-space: nowrap; }
.ut td .ii { display: inline-grid; margin-right: 5px; vertical-align: -3px; }
.ut tr.grp td { padding: 5px 10px; background: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--muted-foreground); }
.ut tr.u-gpu td { background: color-mix(in srgb, var(--warning) 6%, transparent); }
.ut .ush { display: inline-flex; align-items: center; gap: 8px; }
.ut .ush > i { display: block; width: 48px; height: 5px; border-radius: 999px; background: var(--border); overflow: hidden; }
.ut .ush > i > b { display: block; height: 100%; background: var(--primary); }
.ut .u-ph { display: none; }
.u-head { flex-wrap: wrap; row-gap: 6px; }
.u-per { display: inline-flex; gap: 6px; }
.head .u-per a.fchip { height: 26px; font-size: 12px; color: var(--foreground); }
.head .u-per a.fchip.on { color: var(--background); }
.uside { display: grid; gap: 12px; padding: 12px 14px; }
.uside .k { color: var(--muted-foreground); font-size: 12px; display: flex; gap: 6px; align-items: center; }
.uside .v { font-size: 22px; font-weight: 650; letter-spacing: -.01em; margin-top: 2px; font-variant-numeric: tabular-nums; }
.uside .v .u { font-size: 12px; font-weight: 500; color: var(--muted-foreground); letter-spacing: 0; }
.uside .s { color: var(--muted-foreground); font-size: 12px; margin-top: 2px; font-variant-numeric: tabular-nums; }
.umini { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 14px; padding-top: 12px; border-top: 1px solid var(--border); }
.umini .v { font-size: 17px; }
.umini .s .ii { margin-right: 4px; }
.u-runs { margin-top: 10px; }
.u-runs .ut th, .u-runs .ut td { padding: 7px 10px; }
.u-more { margin-top: 8px; font-size: 12.5px; text-align: right; }
.pr-act { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; margin-top: 10px; }
.pr-act b.ok { color: var(--success-foreground); }
.pr-act b.bad { color: var(--error-foreground); }
/* A run's top (the owner, 2026-10-21: keep it small): one line, then Cost and the tokens. */
.u-clock { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin: 0 0 8px; font-size: 13px; color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
.u-clock > .icon { width: 14px; height: 14px; flex: none; }
.u-two { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); gap: 10px; } .u-two.u-three { grid-template-columns: minmax(0, 2fr) minmax(0, 1.5fr) minmax(0, 2.5fr); }
.u-two .fact, .u-calls.fact { padding: 10px 12px; min-width: 0; }
.u-two .fact .v, .u-calls .v { font-size: 22px; letter-spacing: -.01em; }
.u-two .fact .v .u { font-size: 12px; font-weight: 500; color: var(--muted-foreground); letter-spacing: 0; }
.u-two .fact .s, .u-calls .s { font-variant-numeric: tabular-nums; }
.u-two .nr, .u-calls .nr { font-size: 15px; font-weight: 500; font-style: italic; color: var(--muted-foreground); }
.u-two .s .ii, .u-calls .s .ii { display: inline-grid; margin-right: 5px; vertical-align: -3px; }
.utok { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 10px 18px; }
.utok > div + div { border-left: 1px solid var(--border); padding-left: 16px; }
/* A run's Stats tab: its calls, with a bar for each round. */
.u-calls { display: grid; grid-template-columns: minmax(150px, 220px) minmax(0, 1fr); gap: 10px 24px; align-items: end; }
.u-calls .uspark { height: 64px; margin: 0; gap: 4px; }
.u-axis { display: flex; justify-content: space-between; margin-top: 4px; font-size: 11.5px; color: var(--muted-foreground); }
/* Settings › Providers: Model prices, one table under the providers. */
.mp-t td { vertical-align: middle; }
.mp-t input { width: 76px; height: 28px; padding: 0 8px; text-align: right; font-variant-numeric: tabular-nums; }
.mp-t input.bad { border-color: var(--error); }
@media (max-width: 1300px) { .ufacts { grid-template-columns: repeat(4, minmax(0, 1fr)); } .ufacts .uf-wide { grid-column: span 2; } }
@media (max-width: 700px) {
  .ufacts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ufacts .uf-wide { grid-column: 1 / -1; }
  .u-two, .u-two.u-three, .u-calls { grid-template-columns: minmax(0, 1fr); }
  .utok { grid-template-columns: minmax(0, 1fr); }
  .utok > div + div { border-left: 0; padding-left: 0; }
}
@media (max-width: 600px) {
  .mp-t input { width: 46px; padding: 0 4px; }
  .mp-t .chip { white-space: normal; }
  .ut { font-size: 12px; }
  .ut .u-opt { display: none; }
  .ut .u-ph { display: block; }
  .ut th, .ut td { padding: 6px 4px; }
  .ut th:first-child, .ut td:first-child { padding-left: 8px; }
  .ut th:last-child, .ut td:last-child { padding-right: 8px; }
  .ut th { font-size: 11px; }
  .ut th .lb { gap: 3px; }
  .ut .ii { width: 13px; height: 13px; font-size: 9px; }
  .ut td .ii { margin-right: 3px; }
  .ut .ush > i, .ut .kname .av { display: none; }
  .ut .nr { white-space: normal; }
  .ut td:first-child .us { white-space: normal; }
}`;
