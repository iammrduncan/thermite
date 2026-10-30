/** The page's columns, stacks and grids, and how they fold on a narrow screen. */
export const LAYOUT = `/* ---------------------------------------------------------------- layout */
.cols { display: grid; grid-template-columns: minmax(0, 1fr) 400px; gap: 24px; align-items: start; }
.stack { display: flex; flex-direction: column; gap: 12px; }
.grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.grid2 > .card + .card, .stack > .card + .card { margin-top: 0; }
.card.camp { padding: 0; }
.kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
@media (min-width: 1700px) { .kpis { grid-template-columns: repeat(6, minmax(0, 1fr)); } }
.head { display: flex; align-items: baseline; gap: 8px; margin: 4px 0 10px; }
.head h2 { font-size: 14px; }
.head .n { color: var(--muted-foreground); font-size: 13px; }
.head .right { margin-left: auto; font-size: 12px; color: var(--muted-foreground); }
.head .right a { color: var(--primary); }
.block { margin-bottom: 28px; }
.pager { display: flex; gap: 14px; margin-top: 10px; font-size: 12px; } .pager a { color: var(--primary); }
@media (max-width: 1100px) { .cols { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 760px) {
  .app, .app.rail { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr) 30px; }
  .sidebar .side-tog { display: none; }
  .sidebar { grid-row: 1; flex-direction: row; flex-wrap: wrap; padding: 8px; border-right: 0; border-bottom: 1px solid var(--border); }
  .sidebar .section, .sidebar .side-row, .sidebar .side-foot, .sidebar .side-head, .sidebar .side-camps, .sidebar .side-say { display: none; }
  .kmore-pop { width: min(300px, calc(100vw - 32px)); }
  .brand, .app.rail .brand { padding: 4px 8px; }
  .app.rail .sidebar { padding: 8px; }
  .app.rail .side-top { flex-direction: row; margin-bottom: 0; }
  .app.rail .brand-name, .app.rail .nav a > span:not(.count):not(.badge) { position: static; width: auto; height: auto; overflow: visible; clip-path: none; }
  .app.rail .nav a { padding: 6px 10px; }
  .app.rail .nav a .count { display: inline; } .app.rail .nav a .badge { position: static; }
  .nav { display: flex; flex-wrap: wrap; gap: 2px; }
  .main { grid-row: 2; }
  .content { padding: 14px; }
  .grid2 { grid-template-columns: minmax(0, 1fr); }
}`;
