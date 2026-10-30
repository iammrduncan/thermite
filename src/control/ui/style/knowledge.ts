/** Journals, a campaign's collection, and the knowledge explorer. */
export const KNOWLEDGE = `/* Journals and the knowledge base (goal 065) */
.jcols { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 20px; align-items: start; }
@media (max-width: 1100px) { .jcols { grid-template-columns: minmax(0, 1fr); } }
.jside { display: grid; gap: 14px; }
.jnote { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; display: grid; gap: 6px; margin-bottom: 8px; }
.jnote[hidden] { display: none; }
.jhead { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 12.5px; color: var(--muted-foreground); }
.jtext { font-size: 13.5px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.jctx { font-size: 12px; color: var(--muted-foreground); overflow-wrap: anywhere; }
.jk { font: 700 10.5px var(--font-mono); text-transform: uppercase; letter-spacing: .03em; padding: 2px 7px; border-radius: 5px; background: var(--accent); color: var(--muted-foreground); }
.jk.obs { background: var(--primary-surface); color: var(--info-foreground); } .jk.dec { background: var(--success-surface); color: var(--success-foreground); }
.jk.sur { background: var(--warning-surface); color: var(--warning-foreground); } .jk.que { background: color-mix(in srgb, #7c3aed 12%, transparent); color: var(--violet-foreground); } .jk.les { background: var(--accent); color: var(--foreground); }
.jsearch { height: 28px; padding: 0 11px; border-radius: 999px; border: 1px solid var(--input); background: var(--card); font-size: 12.5px; margin-left: auto; width: 220px; max-width: 100%; }
.qsel { height: 28px; padding: 0 8px; border-radius: 999px; border: 1px solid var(--input); background: var(--card); font-size: 12.5px; width: auto; max-width: 100%; }
.qsel[data-qd] { margin-left: auto; }
.jstat { display: grid; grid-template-columns: 1fr auto; gap: 4px 10px; font-size: 12.5px; }
.jstat b { text-align: right; font-variant-numeric: tabular-nums; }
.jsnote { display: grid; gap: 3px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 12.5px; overflow-wrap: anywhere; }
details.jmore { display: grid; gap: 6px; } details.jmore > summary { cursor: pointer; color: var(--info-foreground); }
.kbcard { padding: 12px 14px; display: grid; gap: 8px; }
.kbbtns { display: flex; gap: 6px; }
.kbreads { margin-bottom: 10px; }
.readrow { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 13px; }
.readrow:last-child { border-bottom: 0; }
.kbadd { display: flex; gap: 8px; align-items: end; flex-wrap: wrap; }
.kbadd .sfd { width: 300px; max-width: 100%; }
.past { display: grid; gap: 6px; }
.past .pastrow { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; gap: 8px; align-items: start; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--card); font-size: 12.5px; cursor: pointer; }
.past .pastrow:has(input:checked) { border-color: var(--primary); background: var(--primary-surface); }
.past .pastrow input { margin: 2px 0 0; height: auto; width: auto; }
/* The knowledge explorer (goal 176): the toolbar, the tree, and the open folder's contents */
.kx { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
.kx [hidden] { display: none !important; }
.kx-bar { display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 0 12px 0 14px; border-bottom: 1px solid var(--border); flex: none; min-width: 0; }
.kx-crumbs { display: flex; align-items: center; gap: 2px; flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; font-size: 13px; }
.kx-crumbs a { padding: 3px 6px; border-radius: 6px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; }
.kx-crumbs a:hover { background: var(--accent); color: var(--foreground); text-decoration: none; }
.kx-crumbs a[aria-current] { color: var(--foreground); font-weight: 600; }
.kx-sep { color: var(--muted-foreground); }
.kx-search { display: flex; align-items: center; gap: 2px; width: 320px; flex: none; height: 30px; padding: 0 3px 0 8px; border: 1px solid var(--input); border-radius: var(--control-radius); background: var(--card); color: var(--muted-foreground); }
.kx-search:focus-within { outline: 2px solid color-mix(in srgb, var(--primary) 45%, transparent); outline-offset: 1px; }
.kx-search input { flex: 1; min-width: 0; height: 26px; padding: 0 6px; border: 0; background: transparent; color: var(--foreground); font-size: 13px; }
.kx-search input:focus { outline: none; }
.kx-search input::-webkit-search-cancel-button { display: none; }
.kx-qx { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 6px; color: var(--muted-foreground); flex: none; }
.kx-qx:hover { background: var(--accent); }
.kx-body { display: flex; flex: 1; min-width: 0; min-height: 0; }
.kx-tree { width: 260px; flex: none; overflow-y: auto; padding: 10px 6px 16px; border-right: 1px solid var(--border); }
.kx-treehead { padding: 2px 8px 6px; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--muted-foreground); }
.kx-ul { list-style: none; margin: 0; padding: 0; }
.kx-row { display: flex; align-items: center; gap: 2px; min-height: 28px; padding: 0 4px 0 calc(4px + var(--d, 0) * 14px); border-radius: var(--control-radius); }
.kx-row:hover { background: var(--accent); }
.kx-row.on { background: var(--primary-surface); }
.kx-chev { display: inline-grid; place-items: center; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 5px; background: transparent; color: var(--muted-foreground); flex: none; }
button.kx-chev:hover { background: var(--accent); }
button.kx-chev .icon { transition: transform .15s; }
button.kx-chev[aria-expanded="true"] .icon { transform: rotate(90deg); }
.kx-node { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; height: 26px; padding: 0 6px 0 2px; font-size: 13px; }
.kx-node:hover { text-decoration: none; }
.kx-node .icon { color: var(--muted-foreground); flex: none; }
.kx-row.on .kx-node { font-weight: 600; } .kx-row.on .kx-node .icon { color: var(--primary); }
.kx-node .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kx-node.dim .nm { color: var(--muted-foreground); }
.kx-node .n { margin-left: auto; padding-left: 6px; font-size: 11px; color: var(--muted-foreground); font-variant-numeric: tabular-nums; flex: none; }
.kx-tag { display: inline-flex; align-items: center; padding: 0 5px; border-radius: 4px; background: var(--accent); color: var(--muted-foreground); font-size: 10.5px; font-weight: 500; line-height: 16px; flex: none; }
.kx-empty { padding: 4px 8px; font-size: 12px; color: var(--muted-foreground); }
.kx-ul .kx-empty { padding-left: calc(30px + var(--d, 0) * 14px); }
.kx-main { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
.kx-filters { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-height: 44px; padding: 7px 12px; border-bottom: 1px solid var(--border); flex: none; }
.kx-dd { position: relative; }
.kx-dd > summary { list-style: none; } .kx-dd > summary::-webkit-details-marker { display: none; }
.kx-ddb { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border: 1px solid var(--input); border-radius: var(--control-radius); background: var(--card); font-size: 12.5px; font-weight: 500; cursor: pointer; user-select: none; }
.kx-ddb:hover, .kx-dd[open] > .kx-ddb { background: var(--accent); }
.kx-ddb:focus-visible { outline: 2px solid color-mix(in srgb, var(--primary) 45%, transparent); outline-offset: 1px; }
.kx-ddb.on { border-color: color-mix(in srgb, var(--primary) 45%, var(--input)); }
.kx-ddb .icon { color: var(--muted-foreground); }
.kx-badge { display: inline-grid; place-items: center; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; background: var(--primary); color: var(--primary-foreground); font-size: 10.5px; font-weight: 600; }
.menu-pop.kx-pop { left: 0; right: auto; top: 34px; width: 250px; max-height: 60vh; overflow-y: auto; gap: 2px; }
.kx-pophead { display: flex; align-items: center; gap: 6px; padding: 2px 4px 6px; }
.kx-clear, .kx-clearall { font-size: 12px; color: var(--primary); }
.kx-clear { margin-left: auto; } .kx-clearall { padding: 0 4px; }
.kx-opt { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 6px; font-size: 13px; cursor: pointer; }
.kx-opt:hover { background: var(--accent); }
.kx-opt input { width: 14px; height: 14px; margin: 0; padding: 0; accent-color: var(--primary); flex: none; }
.kx-opt .lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kx-opt.zero .lbl { color: var(--muted-foreground); }
.kx-opt .n { margin-left: auto; font-size: 12px; color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
.kx-chip { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 4px 0 8px; border-radius: 6px; background: var(--accent); color: var(--accent-foreground); font-size: 12px; font-weight: 500; white-space: nowrap; }
.kx-chip:hover { background: color-mix(in srgb, var(--foreground) 10%, transparent); text-decoration: none; }
.kx-chip .icon { color: var(--muted-foreground); }
.kx-count { margin-left: auto; padding-left: 8px; font-size: 12.5px; color: var(--muted-foreground); white-space: nowrap; }
.kx-foldbtn { display: none; height: 28px; padding: 0 10px; font-size: 12.5px; }
.kx-scroll { flex: 1; min-height: 0; overflow: auto; }
.kx-table { table-layout: fixed; }
.kx-table th { position: sticky; top: 0; z-index: 1; height: 32px; padding: 0 12px; background: var(--background); }
.kx-table th a { display: inline-flex; align-items: center; gap: 4px; color: inherit; }
.kx-table th a:hover { color: var(--foreground); text-decoration: none; }
.kx-table th[aria-sort="ascending"], .kx-table th[aria-sort="descending"] { color: var(--foreground); }
.kx-arrow { font-size: 9px; }
.kx-table td { padding: 7px 12px; }
.kx-table tr[data-href] { cursor: pointer; }
.kx-table tr.dim .kx-line a { color: var(--muted-foreground); }
.kx-table .c-kind { width: 110px; } .kx-table .c-out { width: 100px; } .kx-table .c-writer { width: 110px; }
.kx-table .c-mod { width: 96px; } .kx-table .c-size { width: 84px; }
.kx-table td.c-kind, .kx-table td.c-writer, .kx-table td.c-mod, .kx-table td.c-size { color: var(--muted-foreground); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kx-cell { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
.kx-cell > .icon { margin-top: 2px; color: var(--muted-foreground); flex: none; }
.kx-title { display: grid; gap: 1px; min-width: 0; }
.kx-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.kx-line a { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.kx-addr { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 11px var(--font-mono); color: var(--muted-foreground); }
.kx-snip { font-size: 12px; color: var(--muted-foreground); overflow-wrap: anywhere; }
.kx-snip mark { padding: 0 1px; border-radius: 2px; background: var(--warning-surface); color: var(--foreground); }
.chip.kx-broken { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--error) 35%, transparent); }
.chip.kx-dim { color: var(--muted-foreground); }
.kx-pager { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; padding: 10px 12px; font-size: 12px; }
.kx-pager a { color: var(--primary); }
.kx-none { padding: 24px; font-size: 13px; }
/* An item's own page */
.kx-item { display: grid; gap: 12px; max-width: 860px; margin: 0 auto; padding: 22px 28px 32px; }
.kx-ihead { display: flex; align-items: flex-start; gap: 10px; } .kx-ihead .icon { margin-top: 4px; color: var(--muted-foreground); flex: none; }
.kx-item h2 { font-size: 18px; line-height: 1.35; overflow-wrap: anywhere; }
.kx-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12.5px; color: var(--muted-foreground); }
.kx-addrline { display: flex; align-items: center; gap: 6px; min-width: 0; }
.kx-addrline code { min-width: 0; padding: 4px 8px; border-radius: 6px; background: var(--code-background); overflow-wrap: anywhere; }
.kx-text { font-size: 13.5px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.kx-h3 { font-size: 13px; }
.kx-links { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.kx-links li { display: flex; align-items: center; gap: 8px; min-width: 0; } .kx-links code { overflow-wrap: anywhere; }
@media (max-width: 1100px) { .kx-tree { width: 220px; } .kx-table .c-writer, .kx-table .c-size { display: none; } }
@media (max-width: 900px) { .kx-table .c-kind { display: none; } }
/* At phone width the tree opens from Folders, over the contents. */
@media (max-width: 760px) {
  .kx-bar { flex-wrap: wrap; gap: 8px; padding: 8px 14px; }
  .kx-crumbs { flex: 1 1 100%; overflow-x: auto; }
  .kx-search { flex: 1 1 100%; width: auto; }
  .kx-tree { display: none; }
  .kx[data-folders="open"] .kx-body { flex-direction: column; }
  .kx[data-folders="open"] .kx-tree { display: block; width: auto; max-height: 45vh; border-right: 0; border-bottom: 1px solid var(--border); }
  .kx-foldbtn { display: inline-flex; }
  .kx-filters { padding: 7px 14px; }
  .kx-table .c-out { width: 84px; } .kx-table .c-mod { width: 100px; }
  .menu-pop.kx-pop { position: fixed; top: auto; right: 0; bottom: 0; left: 0; width: auto; max-height: 70vh; border-radius: 14px 14px 0 0; }
  .kx-item { padding: 16px 14px 24px; }
}`;
