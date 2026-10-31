/**
 * Cards, text tones, avatars, labels, pills and chips, and the controls: buttons, fields, tabs,
 * segments and menus.
 */
export const SURFACES = `/* ---------------------------------------------------------------- surfaces */
.card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; }
.card.tight { padding: 10px 12px; }
.card.flat { padding: 0; overflow: hidden; }
.card + .card { margin-top: 12px; }
.card.hl { border-color: color-mix(in srgb, var(--foreground) 55%, transparent); }
.card.warn { background: var(--warning-surface); border-color: color-mix(in srgb, var(--warning) 40%, transparent); }
.card.bad { background: var(--error-surface); border-color: color-mix(in srgb, var(--error) 35%, transparent); }
.card-head { display: flex; align-items: center; gap: 10px; }
.card-head .title { font-weight: 600; }
.card-head .sub { color: var(--muted-foreground); font-size: 12px; }
.card-head .right { margin-left: auto; display: flex; gap: 8px; align-items: center; }
.divider { height: 1px; background: var(--border); margin: 12px 0; }
.muted { color: var(--muted-foreground); } .small { font-size: 12px; } .xs { font-size: 11px; }
.ok { color: var(--success-foreground); } .warn { color: var(--warning-foreground); } .bad { color: var(--error-foreground); } .info { color: var(--info-foreground); } .violet { color: var(--violet-foreground); }
.nowrap { white-space: nowrap; } .grow { flex: 1; min-width: 0; }
.row { display: flex; align-items: center; gap: 8px; } .row.wrap { flex-wrap: wrap; }
.empty { color: var(--muted-foreground); font-size: 13px; padding: 18px 0; text-align: center; }
.note { color: var(--muted-foreground); font-size: 12px; margin-top: 10px; }

/* avatars: two letters on a coloured square, like Magnesium's profile chips */
.av { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 5px; color: #fff; font-size: 10px; font-weight: 700; flex: none; letter-spacing: -.02em; }
.av.lg { width: 32px; height: 32px; border-radius: 8px; font-size: 12px; }
.av.c0 { background: #c2410c; } .av.c1 { background: #0e7490; } .av.c2 { background: #4d7c0f; } .av.c3 { background: #be185d; }
.av.c4 { background: #475569; } .av.c5 { background: #6d28d9; } .av.c6 { background: #b45309; } .av.c7 { background: #1d4ed8; }
.iconbox { display: inline-grid; place-items: center; width: 34px; height: 34px; border-radius: 8px; background: var(--accent); color: var(--muted-foreground); flex: none; }

/* labels and pills */
.label { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 500; white-space: nowrap; }
.pill { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 500; border: 1px solid var(--border); white-space: nowrap; }
.pill.ok { color: var(--success-foreground); background: var(--success-surface); border-color: transparent; }
.pill.warn { color: var(--warning-foreground); background: var(--warning-surface); border-color: transparent; }
.pill.bad { color: var(--error-foreground); background: var(--error-surface); border-color: transparent; }
.pill.info { color: var(--info-foreground); background: var(--primary-surface); border-color: transparent; }
.chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 6px; background: var(--accent); font-size: 11px; font-weight: 500; color: var(--accent-foreground); white-space: nowrap; }
.chip.ok { background: var(--success-surface); color: var(--success-foreground); }
.chip.warn { background: var(--warning-surface); color: var(--warning-foreground); }
.chip.bad { background: var(--error-surface); color: var(--error-foreground); }
.chip.info { background: var(--primary-surface); color: var(--info-foreground); }
.chip.violet { background: color-mix(in srgb, var(--violet-foreground) 12%, transparent); color: var(--violet-foreground); }

/* controls */
.btn, button, input, select, textarea { font: inherit; color: inherit; }
.btn, button { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border-radius: var(--control-radius); border: 1px solid var(--input); background: var(--card); cursor: pointer; font-size: 13px; font-weight: 500; white-space: nowrap; }
.btn:hover, button:hover { background: var(--accent); text-decoration: none; }
.btn.primary, button.primary { background: var(--primary); border-color: var(--primary); color: var(--primary-foreground); }
.btn.primary:hover, button.primary:hover { background: color-mix(in srgb, var(--primary) 90%, var(--background)); }
.btn.danger, button.danger { color: var(--error-foreground); border-color: color-mix(in srgb, var(--error) 40%, transparent); }
.btn.sm, button.sm { height: 26px; padding: 0 9px; font-size: 12px; }
.btn.ghost, button.ghost { border-color: transparent; background: transparent; }
input, select, textarea { height: 32px; padding: 0 10px; border-radius: var(--control-radius); border: 1px solid var(--input); background: var(--card); font-size: 13px; }
textarea { height: auto; padding: 8px 10px; resize: vertical; line-height: 1.45; }
input:focus, select:focus, textarea:focus, button:focus-visible, .btn:focus-visible { outline: 2px solid color-mix(in srgb, var(--primary) 45%, transparent); outline-offset: 1px; }
form.inline { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 0; }
.tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); margin: 4px 0 16px; overflow-x: auto; }
.tabs a { display: inline-flex; align-items: center; gap: 7px; padding: 8px 12px; font-size: 13px; font-weight: 500; color: var(--muted-foreground); border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap; }
.tabs a:hover { color: var(--foreground); text-decoration: none; }
.tabs a.on { color: var(--foreground); border-bottom-color: var(--primary); }
.tabs a .sub { font-weight: 400; font-size: 12px; color: var(--muted-foreground); }
.goalcell { text-align: center; font-weight: 600; }
tr.on td { background: var(--primary-surface); }
.seg a span { padding: 0; }
.seg a .dot { display: inline-block; margin-left: 4px; vertical-align: middle; }
.seg { display: inline-flex; padding: 2px; border-radius: var(--control-radius); background: var(--accent); gap: 2px; }
.seg a, .seg span { padding: 3px 10px; border-radius: 6px; font-size: 12px; font-weight: 500; color: var(--muted-foreground); }
.seg .on { background: #18181b; color: #fff; }
@media (prefers-color-scheme: dark) { .seg .on { background: #f5f5f5; color: #0a0a0a; } }
details.menu { position: relative; }
details.menu > summary { list-style: none; }
details.menu > summary::-webkit-details-marker { display: none; }
details.menu[open] > .menu-body { position: absolute; right: 0; top: 38px; z-index: 20; width: 320px; background: var(--popover); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; box-shadow: 0 12px 32px rgb(0 0 0 / 12%); display: flex; flex-direction: column; gap: 10px; }`;
