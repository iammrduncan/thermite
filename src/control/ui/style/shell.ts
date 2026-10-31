/**
 * The page's frame: the sidebar, with the campaigns and their folders, the main column's top bar,
 * and the status bar.
 */
export const SHELL = `/* ---------------------------------------------------------------- shell */
.app { display: grid; grid-template-columns: 256px minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) 30px; height: 100vh; }
.sidebar { grid-row: 1 / 2; background: var(--sidebar); border-right: 1px solid var(--border); overflow-y: auto; padding: 12px 8px; display: flex; flex-direction: column; gap: 2px; }
.side-top { display: flex; align-items: flex-start; gap: 4px; }
.brand { display: flex; align-items: center; gap: 10px; padding: 4px 8px 14px; font-weight: 600; font-size: 16px; }
.side-top .brand { flex: 1; min-width: 0; }
.sidebar .side-tog { flex: none; margin-top: 4px; }
.mark { display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 6px; background: #18181b; color: #fff; font-size: 11px; font-weight: 700; letter-spacing: -.02em; }
@media (prefers-color-scheme: dark) { .mark { background: #f5f5f5; color: #0a0a0a; } }
.nav a { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-radius: var(--control-radius); color: var(--foreground); }
.nav a:hover { background: var(--sidebar-row-hover); text-decoration: none; }
.nav a.on { background: var(--accent); font-weight: 500; }
.nav a .icon { color: var(--muted-foreground); }
.nav a .count { margin-left: auto; font-size: 12px; color: var(--muted-foreground); }
.nav a .badge { margin-left: auto; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: #c2410c; color: #fff; font-size: 11px; font-weight: 600; display: inline-grid; place-items: center; }
.section { margin: 16px 10px 4px; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--muted-foreground); }
.side-row { display: flex; align-items: center; gap: 8px; padding: 5px 10px; border-radius: var(--control-radius); font-size: 13px; }
.side-row:hover { background: var(--sidebar-row-hover); text-decoration: none; }
.side-row .right { margin-left: auto; font-size: 11px; color: var(--muted-foreground); white-space: nowrap; }
.side-row .right.label.info { color: var(--info-foreground); } .side-row .right.label.warn { color: var(--warning-foreground); }
.side-row .right.label.violet { color: var(--violet-foreground); } .side-row .right.label.bad { color: var(--error-foreground); }
.side-row .right.label.ok { color: var(--success-foreground); }
.side-row .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The campaigns in the left navigation, with their folders (goal 077) */
.side-head { display: flex; align-items: center; margin: 16px 2px 4px 10px; }
.side-head .section { margin: 0; flex: 1; }
.sidebar .ib { width: 24px; height: 24px; padding: 0; display: inline-grid; place-items: center; border: 0; background: transparent; box-shadow: none; color: var(--muted-foreground); border-radius: 6px; cursor: pointer; list-style: none; }
.sidebar .ib::-webkit-details-marker { display: none; }
.sidebar .ib:hover, .sidebar .ib:focus-visible, .sidebar details[open] > summary.ib { background: var(--sidebar-row-hover); color: var(--foreground); }
.fnew { position: relative; }
.fnew > .menu-pop { top: 28px; right: 0; width: 224px; }
.side-camps { position: relative; display: flex; flex-direction: column; gap: 2px; }
.side-fold { position: relative; }
details.side-folder > summary { list-style: none; display: flex; align-items: center; gap: 6px; padding: 5px 34px 5px 6px; border-radius: var(--control-radius); font-size: 13px; cursor: pointer; user-select: none; }
details.side-folder > summary::-webkit-details-marker { display: none; }
details.side-folder > summary:hover { background: var(--sidebar-row-hover); }
details.side-folder > summary .icon { color: var(--muted-foreground); flex: none; }
details.side-folder > summary > .icon:first-child { transition: transform .15s; }
details.side-folder[open] > summary > .icon:first-child { transform: rotate(90deg); }
details.side-folder > summary .fname { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
details.side-folder > summary .n { margin-left: auto; font-size: 11px; color: var(--muted-foreground); }
.side-folder .side-row { padding-left: 30px; }
.side-empty { padding: 3px 10px 5px 30px; font-size: 12px; color: var(--muted-foreground); }
.fmenu { position: absolute; top: 3px; right: 4px; }
.fmenu > summary { list-style: none; }
.fmenu > .menu-pop { top: 28px; width: 224px; }
.fsep { height: 1px; background: var(--border); margin: 4px 0; }
.side-row[draggable="true"] { cursor: pointer; }
.side-row[draggable="true"]:active, .side-dragging .side-row { cursor: grabbing; }
.side-row[aria-current] { background: var(--sidebar-row-active); box-shadow: 0 0 0 1px var(--border); }
.side-row.dragging { opacity: .4; }
.side-drop { display: none; margin: 4px 2px 0; padding: 6px 10px; border: 1px dashed var(--input); border-radius: var(--control-radius); font-size: 12px; color: var(--muted-foreground); }
.side-dragging .side-drop { display: block; }
.side-dragging .side-fold > details.side-folder > summary { box-shadow: inset 0 0 0 1px var(--border); }
.side-fold.drop-over > details.side-folder > summary, .side-drop.drop-over { background: var(--primary-surface); box-shadow: inset 0 0 0 1.5px var(--primary); color: var(--foreground); }
.side-say { margin: 6px 6px 0; color: var(--muted-foreground); }
.side-say:empty { display: none; }
.side-say.bad { color: var(--error-foreground); }
/* A campaign's page: ⋯ with Move to folder and Archive */
.kmore-pop { width: 300px; }
.kmore-pop > form > button { justify-self: start; }
.kmove { display: flex; gap: 6px; } .kmove select { flex: 1; min-width: 0; }
.dot { width: 7px; height: 7px; border-radius: 999px; background: var(--muted-foreground); flex: none; }
.dot.ok { background: var(--success); } .dot.warn { background: #ea580c; } .dot.bad { background: var(--error); } .dot.info { background: var(--info); }
.dot.pulse { animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
.side-foot { margin-top: auto; padding: 12px 8px 0; display: flex; align-items: center; justify-content: space-between; }
.side-foot .cog { display: inline-grid; place-items: center; width: 32px; height: 32px; border-radius: var(--control-radius); color: var(--muted-foreground); }
.side-foot .cog:hover, .side-foot .cog.on { background: var(--sidebar-row-hover); color: var(--foreground); text-decoration: none; }
/* The left navigation collapsed to its icons (NAV_COOKIE): each name stays for screen readers. */
.app.rail { grid-template-columns: 56px minmax(0, 1fr); }
.app.rail .sidebar { padding: 12px 6px; }
.app.rail .side-top { flex-direction: column; align-items: center; gap: 6px; margin-bottom: 10px; }
.app.rail .brand { padding: 4px 0; }
.app.rail .sidebar .side-tog { margin-top: 0; }
.app.rail .nav a { justify-content: center; padding: 8px 0; position: relative; }
.app.rail .brand-name, .app.rail .nav a > span:not(.count):not(.badge), .app.rail .side-foot button > span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.app.rail .nav a .count { display: none; }
.app.rail .nav a .badge { position: absolute; top: 1px; right: 4px; min-width: 16px; height: 16px; padding: 0 4px; font-size: 10px; }
.app.rail .side-head, .app.rail .side-camps, .app.rail .side-say { display: none; }
.app.rail .side-foot { flex-direction: column; gap: 6px; padding: 12px 0 0; }
.app.rail .side-foot button { padding: 0 7px; }

.main { grid-row: 1 / 2; display: flex; flex-direction: column; min-width: 0; overflow: hidden; }
.topbar { display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 0 20px; border-bottom: 1px solid var(--border); background: var(--background); }
.topbar h1 { font-size: 15px; }
.topbar .crumbs { color: var(--muted-foreground); font-size: 13px; display: flex; gap: 6px; align-items: center; }
.topbar .summary { color: var(--muted-foreground); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.topbar .actions { margin-left: auto; display: flex; gap: 8px; align-items: center; }
.content { flex: 1; overflow-y: auto; padding: 20px; }
.content.flush { padding: 0; display: flex; overflow: hidden; }

.statusbar { grid-column: 1 / -1; display: flex; align-items: center; gap: 18px; padding: 0 16px; border-top: 1px solid var(--border); background: var(--background); font-size: 12px; white-space: nowrap; overflow: hidden; }
.statusbar .item { display: inline-flex; align-items: center; gap: 6px; }
.statusbar .item.warn { color: #c2410c; font-weight: 500; } .statusbar .item.bad { color: var(--error-foreground); font-weight: 500; }
.statusbar .sub { color: var(--muted-foreground); }
.statusbar .spacer { margin-left: auto; }
@media (prefers-color-scheme: dark) { .statusbar .item.warn { color: #fb923c; } }`;
