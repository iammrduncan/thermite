/** Live, one run at a time: the runs, the stream, the kept messages and the composer. */
export const LIVE = `/* Live, one run at a time: the stream gets the room */
.lwrap { display: grid; grid-template-columns: 230px minmax(0, 1fr); width: 100%; min-height: 0; position: relative; }
.lwrap.closed { grid-template-columns: minmax(0, 1fr); } .lwrap.closed .lruns { display: none; }
@media (max-width: 1180px) {
  .lwrap { grid-template-columns: minmax(0, 1fr); } .lwrap .lruns { display: none; }
  .lwrap.open .lruns { display: block; position: absolute; z-index: 20; top: 0; bottom: 0; left: 0; width: 250px; box-shadow: 8px 0 24px rgb(0 0 0 / 12%); }
}
.lruns { border-right: 1px solid var(--border); overflow-y: auto; padding: 12px 8px; background: var(--sidebar); }
.lruns .hd { font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--muted-foreground); margin: 10px 8px 6px; cursor: default; }
.lruns details > summary { list-style: none; cursor: pointer; } .lruns details > summary::-webkit-details-marker { display: none; }
.lr { display: block; padding: 8px 10px; border-radius: 8px; color: inherit; margin-bottom: 2px; }
.lr:hover { background: var(--sidebar-row-hover); text-decoration: none; }
.lr.on { background: var(--sidebar-row-active); box-shadow: 0 0 0 1px var(--border); }
.lr .t { display: flex; align-items: center; gap: 7px; font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lr .s { display: block; font-size: 12px; color: var(--muted-foreground); margin-top: 1px; }
.lr.idle .t { font-weight: 500; color: var(--muted-foreground); }
.lempty { font-size: 12.5px; color: var(--muted-foreground); padding: 4px 10px; }
.lcol { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.lhead { display: flex; align-items: center; gap: 8px; padding: 7px 14px; border-bottom: 1px solid var(--border); background: var(--card); min-width: 0; }
.lhead .t { font-weight: 650; font-size: 14px; white-space: nowrap; }
.lhead form { display: inline; }
.lmeta { flex: 1; min-width: 0; font-size: 12px; color: var(--muted-foreground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* The chips wrap rather than scroll: a scrolling bar would clip its menus (the kept messages'). */
.lchips { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; padding: 6px 14px; border-bottom: 1px solid var(--border); position: relative; z-index: 5; }
.lchip { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--input); background: var(--card); color: var(--foreground); font-size: 12.5px; font-weight: 500; flex: none; cursor: pointer; }
.lchip:hover { background: var(--accent); text-decoration: none; }
.lchip.on { background: var(--foreground); color: var(--background); border-color: var(--foreground); }
.lchip.lfollow.on { background: var(--accent); color: var(--foreground); border-color: var(--input); }
.lstream { padding: 10px 18px 16px; gap: 4px; }
.lstream [hidden] { display: none !important; }
.lv-div { display: flex; align-items: center; gap: 10px; margin: 10px 0 4px; font-size: 12px; color: var(--muted-foreground); }
.lv-div::before, .lv-div::after { content: ""; flex: 1; height: 1px; background: var(--border); }
.lv-div b { color: var(--foreground); font-weight: 600; }
.lv-md p { margin: 0 0 6px; } .lv-md p:last-child { margin: 0; } .lv-md code { font-size: 12px; }
.lv-you .you { display: inline-block; background: var(--primary-surface); border: 1px solid color-mix(in srgb, var(--primary) 25%, transparent); border-radius: 10px; padding: 6px 11px; white-space: pre-wrap; }
.lv-read .lv-body { font-size: 12px; }
.lv-answer .answer { display: inline-block; background: var(--card); border: 1px solid var(--border); border-left: 3px solid #0d9488; border-radius: 10px; padding: 6px 11px; }
.lv-answer .answer p { display: inline; margin: 0; }
.lkept { position: relative; flex: none; } .lkept > summary { list-style: none; } .lkept > summary::-webkit-details-marker { display: none; }
.lkept .menu-pop { top: 30px; width: min(340px, 86vw); }
.lkept .krow { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: start; padding-top: 8px; border-top: 1px solid var(--border); }
.lkept .krow form { display: inline; }
.lcomposer { display: flex; gap: 6px; align-items: flex-end; padding: 8px 14px; border-top: 1px solid var(--border); background: var(--card); }
.lcomposer.off { color: var(--muted-foreground); font-size: 13px; padding: 12px 16px; }
.lcomposer textarea { flex: 1; min-height: 34px; max-height: 160px; height: 34px; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--input); resize: none; line-height: 1.4; background: var(--background); font-size: 13.5px; }
.lcomposer .lto { height: 34px; width: auto; max-width: 200px; flex: none; font-weight: 500; }
.lcomposer button { height: 34px; flex: none; }
.lpin { display: inline-grid; place-items: center; width: 34px; height: 34px; border-radius: var(--control-radius); border: 1px solid var(--input); cursor: pointer; flex: none; opacity: .5; }
.lpin input { position: absolute; opacity: 0; pointer-events: none; }
.lpin:has(input:checked) { opacity: 1; background: var(--accent); }
.lpin[hidden] { display: none; }
.lnotice { display: flex; gap: 8px; align-items: center; padding: 8px 14px; border-top: 1px solid color-mix(in srgb, var(--warning) 45%, transparent); background: var(--warning-surface); font-size: 13px; }
.lnotice svg { color: var(--warning-foreground); flex: none; }
.lnotice.qjudge { border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent); border-radius: 8px; margin: 0 0 12px; }
/* Each kind of agent has its colour (goal 188): on its chip's dot and its lines' name. */
:root { --k-lane: #1d4ed8; --k-planner: #7c3aed; --k-judge: #0f766e; --k-teacher: #c2410c; --k-merger: #a16207; --k-auditor: #be123c; --k-reviewer: #4d7c0f; --k-writer: #0369a1; --k-advisor: #52525b; }
@media (prefers-color-scheme: dark) { :root { --k-lane: #93c5fd; --k-planner: #c4b5fd; --k-judge: #5eead4; --k-teacher: #fdba74; --k-merger: #fcd34d; --k-auditor: #fda4af; --k-reviewer: #bef264; --k-writer: #7dd3fc; --k-advisor: #d4d4d8; } }
.kdot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--k-advisor); }
.lchip.on .kdot { box-shadow: 0 0 0 2px var(--background); }
.lv-who.k-lane { color: var(--k-lane); } .kdot.k-lane { background: var(--k-lane); }
.lv-who.k-planner { color: var(--k-planner); } .kdot.k-planner { background: var(--k-planner); }
.lv-who.k-judge { color: var(--k-judge); } .kdot.k-judge { background: var(--k-judge); }
.lv-who.k-teacher { color: var(--k-teacher); } .kdot.k-teacher { background: var(--k-teacher); }
.lv-who.k-merger { color: var(--k-merger); } .kdot.k-merger { background: var(--k-merger); }
.lv-who.k-auditor { color: var(--k-auditor); } .kdot.k-auditor { background: var(--k-auditor); }
.lv-who.k-reviewer { color: var(--k-reviewer); } .kdot.k-reviewer { background: var(--k-reviewer); }
.lv-who.k-writer { color: var(--k-writer); } .kdot.k-writer { background: var(--k-writer); }
.lv-who.k-advisor { color: var(--k-advisor); }
.lv-who[class*="k-"] { font-weight: 600; }`;
