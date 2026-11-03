/**
 * Bars and meters: Edit rig's agents, plan use, a research run's questions, stacked bars, legends
 * and deltas.
 */
export const BARS = `/* bars */
/* Edit rig's agents (goals 070, 073 and 074): two groups; Runs in and Context on every line */
.roles { display: grid; grid-template-columns: minmax(150px, .95fr) minmax(190px, 1.4fr) minmax(92px, .55fr) minmax(132px, .8fr) minmax(150px, .9fr); gap: 8px 14px; align-items: center; }
.roles .hd { font-size: 12px; font-weight: 600; color: var(--muted-foreground); }
.roles select { height: 32px; width: 100%; min-width: 0; border: 1px solid var(--input); border-radius: var(--control-radius); background: var(--card); font-size: 13px; padding: 0 8px; }
.roles .ln { display: contents; }
.roles .ln[hidden] { display: none; }
.roles .grp { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 2px 10px; margin-top: 6px; padding-top: 12px; border-top: 1px solid var(--border); }
.roles .grp .lb { font-size: 11.5px; letter-spacing: .05em; text-transform: uppercase; color: var(--foreground); }
.roles .ag { display: grid; gap: 1px; min-width: 0; }
.roles .ag .lb { font-size: 13px; }
.roles .job { font-size: 11.5px; line-height: 1.35; color: var(--muted-foreground); }
.roles select.bad { border-color: var(--error); }
.roles select:disabled { opacity: 1; color: var(--muted-foreground); background: transparent; border-style: dashed; cursor: default; }
.roles select option[hidden] { display: none; }
.t2-m, .mb-m { display: flex; align-items: center; gap: 6px; min-width: 0; }
.t2-m select, .mb-m select { flex: 1; min-width: 0; }
.mb-m .lb { flex: none; font-weight: 500; color: var(--muted-foreground); }
.t2-x { flex: none; width: 30px; height: 32px; padding: 0; justify-content: center; color: var(--muted-foreground); font-size: 16px; box-shadow: none; }
.t2-x:hover { text-decoration: none; }
.t2-add-c { grid-column: 2 / -1; margin-top: -4px; }
.t2-add-c .btn { height: 24px; padding: 0 8px; font-size: 12px; }
.ctx-w { position: relative; min-width: 0; }
.ctx-b { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; height: 32px; padding: 0 10px; border: 1px solid var(--input); border-radius: var(--control-radius); background: var(--card); color: var(--foreground); font-size: 12.5px; font-variant-numeric: tabular-nums; list-style: none; cursor: pointer; user-select: none; }
.ctx-b::-webkit-details-marker { display: none; }
.ctx-b:hover { border-color: var(--muted-foreground); }
.ctx-w[open] > .ctx-b { border-color: var(--primary); background: var(--primary-surface); }
.ctx-w.ctx-bad > .ctx-b { border-color: var(--error); }
.ctx-w.off > .ctx-b { cursor: default; background: transparent; border-style: dashed; }
.ctx-w.off > .ctx-b:hover { border-color: var(--input); }
.ctx-b .ctx-car { flex: none; width: 7px; height: 7px; margin: -4px 2px 0 0; border-right: 1.5px solid var(--muted-foreground); border-bottom: 1.5px solid var(--muted-foreground); transform: rotate(45deg); }
.ctx-w[open] > .ctx-b .ctx-car { margin-top: 3px; transform: rotate(-135deg); }
.ctx-w.off .ctx-car { display: none; }
.ctx-b b { font-weight: 650; }
.ctx-k { display: none; color: var(--muted-foreground); }
.ctx-v { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.ctx-v .bad { color: var(--error-foreground); }
.ctx-pop { position: absolute; z-index: 40; top: calc(100% + 6px); right: 0; width: 320px; max-width: calc(100vw - 32px); display: grid; gap: 8px; padding: 10px 12px; background: var(--popover); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 12px 34px rgb(0 0 0 / 18%); }
.ctx-f { display: grid; grid-template-columns: minmax(0, 1fr) 96px 42px; align-items: center; gap: 8px; margin: 0; }
.ctx-f input { height: 30px; width: 100%; padding: 0 8px; border: 1px solid var(--input); border-radius: var(--control-radius); background: var(--background); font-variant-numeric: tabular-nums; }
.ctx-f input.bad { border-color: var(--error); }
.ctx-f > .muted { font-size: 12px; }
.ctx-msg { font-size: 12px; line-height: 1.4; color: var(--muted-foreground); }
.ctx-msg:empty { display: none; }
.ctx-msg.bad { color: var(--error-foreground); } .ctx-msg.warn { color: var(--warning-foreground); }
.row-say { grid-column: 2 / -1; margin-top: -3px; font-size: 12.5px; line-height: 1.45; color: var(--error-foreground); }
.chg li.bad { color: var(--error-foreground); }
@media (max-width: 900px) {
  .roles { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .roles .ag { grid-column: 1 / -1; padding-top: 6px; }
  .roles .ag-sp { display: none; }
  .roles select[data-role], .roles .t2-m, .roles .mb-m, .roles .ctx-w, .roles .row-say, .roles .t2-add-c { grid-column: 1 / -1; }
  .roles .ln.sub > .t2-m, .roles .ln.sub > .mb-m { padding-top: 8px; border-top: 1px dashed var(--border); }
  .roles .t2-add-c { margin-top: 0; }
  .roles .hd { display: none; }
  .roles .hd + .grp, .roles .hd + .hd { margin-top: 0; padding-top: 0; border-top: 0; }
  .ctx-pop { left: 0; width: auto; }
  .ctx-k { display: inline; }
}
.flag { border-left: 3px solid var(--warning-foreground); padding: 6px 0 6px 12px; margin: 12px 0 0; font-size: 13px; line-height: 1.5; }
.use { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 22px; font-size: 13px; }
.ubar { height: 8px; border-radius: 99px; background: var(--muted); overflow: hidden; margin: 4px 0 2px; }
.ubar > div { height: 100%; background: var(--primary); border-radius: 99px; }
.ubar.warn > div { background: var(--warning-foreground); }
.meter { display: grid; grid-template-columns: auto 1fr auto; gap: 2px 8px; align-items: center; font-size: 12px; }
.meter .k { color: var(--muted-foreground); } .meter .v { text-align: right; font-variant-numeric: tabular-nums; }
.bar { grid-column: 1 / -1; height: 3px; background: var(--border); border-radius: 999px; overflow: hidden; }
.bar > i { display: block; height: 100%; background: #52525b; border-radius: 999px; }
.rq { display: grid; gap: 4px; font-size: 12px; }
.rq-head { display: flex; gap: 12px; align-items: baseline; justify-content: space-between; }
.rq-text { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.rq-v { color: var(--muted-foreground); white-space: nowrap; font-variant-numeric: tabular-nums; }
/* A research run's questions on its Overview (goal 117): where the end stands, then each question */
.rq-sum { display: grid; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--border); }
.rq-sum:last-child { border-bottom: 0; }
.rq-q .gl-main { gap: 5px; }
.rq-chips { display: inline-flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.rq-ans { font-size: 13px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.rq-q ul.flaws { margin: 0; }
.rq-q .bar { margin-top: 2px; }
.rq-rule { display: grid; gap: 4px; }
.rq-rule .lb { font-weight: 600; color: var(--foreground); vertical-align: -3px; }
.rq-sum a, .dq-body a { color: var(--primary); }
.bar.primary > i { background: var(--primary); } .bar.ok > i { background: var(--success); } .bar.warn > i { background: #ea580c; } .bar.bad > i { background: var(--error); }
.stack-bar { display: flex; height: 8px; border-radius: 999px; overflow: hidden; background: var(--border); gap: 1px; }
.stack-bar > i { display: block; height: 100%; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 10px; font-size: 12px; }
.legend .sw { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 6px; vertical-align: 0; }
.delta { display: inline-flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }
.delta i { display: inline-block; height: 6px; border-radius: 2px; }`;
