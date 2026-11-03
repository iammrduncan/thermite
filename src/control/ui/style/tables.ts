/** KPI tiles, tables, and the overview's tallies. */
export const TABLES = `/* KPI tiles */
.kpi { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px; }
.kpi .k { font-size: 11px; color: var(--muted-foreground); text-transform: uppercase; letter-spacing: .05em; font-weight: 600; }
.kpi .v { font-size: 20px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
.kpi .s { font-size: 12px; color: var(--muted-foreground); }
.kpi .v.ok { color: var(--success-foreground); } .kpi .v.bad { color: var(--error-foreground); }

/* tables */
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th { text-align: left; font-weight: 500; font-size: 12px; color: var(--muted-foreground); padding: 8px 12px; border-bottom: 1px solid var(--border); white-space: nowrap; }
td { padding: 8px 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
tr:last-child td { border-bottom: 0; }
tbody tr:hover td { background: var(--muted); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.clip { max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* tallies: the overview's few numbers */
.tallies { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 24px; }
.tally { display: flex; align-items: baseline; gap: 10px; padding: 14px 16px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); color: var(--muted-foreground); font-size: 13px; }
a.tally:hover { text-decoration: none; border-color: color-mix(in srgb, var(--foreground) 25%, transparent); }
.tally b { font-size: 26px; font-weight: 650; letter-spacing: -0.02em; color: var(--foreground); font-variant-numeric: tabular-nums; }
.tally.warn { border-color: color-mix(in srgb, var(--warning) 45%, var(--border)); background: var(--warning-surface); }
.tally.warn b { color: var(--warning-foreground); } .tally.ok b { color: var(--success-foreground); } .tally.bad b { color: var(--error-foreground); }`;
