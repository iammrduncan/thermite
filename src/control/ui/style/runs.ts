/** A run at a glance, a run's page (its goals, champions and attempts), and an attempt's page. */
export const RUNS = `/* a run at a glance: its lanes, planner and judge, one line each */
.brief { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 14px; }
.brief + .brief { margin-top: 10px; }
.brief-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; flex-wrap: wrap; }
.brief-name { font-weight: 600; font-size: 14px; }
.brief-progress { display: inline-flex; align-items: center; gap: 8px; margin-left: auto; }
.br { display: grid; grid-template-columns: 70px minmax(0, 1fr) 80px; gap: 10px; padding: 4px 0; font-size: 13px; border-top: 1px dashed var(--border); }
.brief-head + .br, .brief > .br:first-child { border-top: 0; }
.brief-head ~ .br { padding-left: 34px; }
.br-who { color: var(--muted-foreground); font-family: var(--font-mono); font-size: 12px; padding-top: 1px; }
.br-what { min-width: 0; word-break: break-word; } .br-what a { color: var(--primary); }
.br.muted .br-what { color: var(--muted-foreground); }
.br-when { color: var(--muted-foreground); font-size: 12px; text-align: right; white-space: nowrap; }
.br-more { display: block; color: var(--muted-foreground); font-size: 12px; }
.side .brief-head ~ .br { padding-left: 0; } .side .br { grid-template-columns: 56px minmax(0, 1fr) 56px; }
.fig { font-weight: 600; font-size: 13px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.goalbar { display: inline-flex; gap: 2px; }
.goalbar .seg { width: 14px; height: 8px; border-radius: 2px; background: var(--border); }
.goalbar .seg.ok { background: var(--success); } .goalbar .seg.bad { background: var(--error); } .goalbar .seg.warn { background: var(--warning); }

/* a hill climb's metrics on its Overview (goal 209): priorities, guard rows, informational tiles */
.ms-top { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 14px; margin-bottom: 14px; }
.ms-top > .ms-primary:only-child { grid-column: span 2; }
@media (max-width: 1100px) { .ms-top { grid-template-columns: minmax(0, 1fr); } .ms-top > .ms-primary:only-child { grid-column: auto; } }
.ms-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.ms-big { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 4px; }
.fig-big { font-size: 26px; font-weight: 650; font-variant-numeric: tabular-nums; }
.ms-mid { display: flex; align-items: baseline; gap: 8px; margin: 8px 0 4px; }
.ms-switch { display: inline-flex; border: 1px solid var(--input); border-radius: var(--control-radius); overflow: hidden; float: right; margin-top: -30px; }
.ms-switch input { position: absolute; opacity: 0; pointer-events: none; }
.ms-switch label { padding: 3px 10px; font-size: 12px; cursor: pointer; }
.ms-switch input:checked + label { background: var(--foreground); color: var(--background); }
.ms-switch input:focus-visible + label { outline: 2px solid var(--primary); }
.ms-chart-unit { display: none; }
.ms-primary:has(#ms-unit:checked) .ms-chart-unit { display: block; }
.ms-primary:has(#ms-unit:checked) .ms-chart-gain { display: none; }
.ms-guards { margin-bottom: 14px; }
.ms-guards-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; padding: 10px 14px; border-bottom: 1px solid var(--border); }
.ms-guard { display: grid; grid-template-columns: minmax(180px, 1.3fr) 330px 110px 110px minmax(120px, 1fr); gap: 0 14px; align-items: center; padding: 8px 14px; border-bottom: 1px solid var(--border); }
.ms-guard:last-child { border-bottom: 0; }
.ms-guard-cols { background: var(--muted); padding-top: 5px; padding-bottom: 5px; }
@media (max-width: 1000px) { .ms-guard { grid-template-columns: minmax(0, 1fr); gap: 4px; } .ms-guard-cols { display: none; } }
.ms-info-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin: 4px 0 8px; }
.ms-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
.ms-tile-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 8px; }
svg.chart.ms-spark { height: auto; display: inline-block; }
svg.chart .ms-line { fill: none; stroke: var(--info); stroke-width: 1.5; }
svg.chart .ms-pt { fill: var(--info); }
svg.chart .ms-latest { fill: var(--card); stroke: var(--info); stroke-width: 1.5; stroke-dasharray: 2 2; }
svg.chart .ms-band { fill: var(--success); opacity: .12; }

/* a run's judge queue (goal 209) */
.jq { display: grid; grid-template-columns: 90px minmax(0, 1fr) auto; gap: 10px; align-items: baseline; padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 13px; }
.jq:last-child { border-bottom: 0; }
.jq-main { min-width: 0; word-break: break-word; }

/* a run's page */
.run-head { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
.run-title { font-size: 18px; font-weight: 650; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.run-title .label { font-size: 12px; }
details.matrix > summary { padding: 10px 14px; cursor: pointer; font-size: 13px; font-weight: 600; }
details.matrix[open] > summary { border-bottom: 1px solid var(--border); }
.cols.run-cols { grid-template-columns: minmax(0, 1.7fr) minmax(300px, 1fr); }
@media (max-width: 1100px) { .cols.run-cols { grid-template-columns: minmax(0, 1fr); } }
.run-said { font-size: 15px; line-height: 1.5; margin: 0 0 20px; max-width: 900px; }
.gl { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 10px; padding: 9px 14px; border-bottom: 1px solid var(--border); font-size: 13px; }
.gl:last-child { border-bottom: 0; }
.gl-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.gl-why { color: var(--muted-foreground); font-size: 12px; } .gl-why.bad { color: var(--error-foreground); }
details.howcheck > summary { cursor: pointer; font-size: 12px; color: var(--primary); width: fit-content; }
.howc { display: flex; flex-direction: column; gap: 6px; margin: 6px 0 2px; padding: 8px 10px; border-left: 2px solid var(--border); }
.howc code { word-break: break-word; }
table.howc-cells { width: 100%; font-size: 12px; }
table.howc-cells td, table.howc-cells th { padding: 4px 8px 4px 0; vertical-align: top; }
.khow { margin-top: 12px; } .khow .gl { padding: 8px 0; }
details.more > summary { list-style: none; cursor: pointer; } details.more > summary::-webkit-details-marker { display: none; }
details.more > summary .more-tog::after { content: "more"; color: var(--primary); white-space: nowrap; }
details.more[open] > summary .more-part { display: none; } details.more[open] > summary .more-tog::after { content: "less"; }
.gl-mark { width: 20px; height: 20px; border-radius: 50%; display: inline-grid; place-items: center; font-size: 11px; font-weight: 700; background: var(--muted); color: var(--muted-foreground); }
.gl-mark.ok { background: var(--success-surface); color: var(--success-foreground); }
.gl-mark.bad { background: var(--error-surface); color: var(--error-foreground); }
.gl-mark.warn { background: var(--warning-surface); color: var(--warning-foreground); }
.ladder-chart { padding: 12px 14px 4px; border-bottom: 1px solid var(--border); }
.lad { display: grid; grid-template-columns: 36px minmax(0, 1fr) auto 64px 40px; gap: 10px; align-items: center; padding: 8px 14px; border-bottom: 1px solid var(--border); font-size: 13px; }
.lad:last-child { border-bottom: 0; }
.lad-n { font-weight: 650; color: var(--muted-foreground); } .lad-age { color: var(--muted-foreground); font-size: 12px; text-align: right; }
.lad-main a { color: inherit; }
.ar { display: grid; grid-template-columns: 96px minmax(0, 1fr) auto 56px 36px; gap: 10px; align-items: center; padding: 9px 14px; border-bottom: 1px solid var(--border); font-size: 13px; color: inherit; }
.ar:last-child { border-bottom: 0; }
.ar:hover { background: var(--muted); text-decoration: none; }
.ar-out { justify-content: center; }
.ar-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ar-main b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ar-effect { display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; align-items: center; }
.ar-guards { display: flex; flex-wrap: wrap; gap: 2px 10px; justify-content: flex-end; flex-basis: 100%; font-size: 12px; color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
.ag.bad { color: var(--error-foreground); font-weight: 600; } .ag.warn { color: var(--warning-foreground); }
/* a hill climb's guards (goal 184): a chart for each, and a line under each champion */
.guards { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 10px 24px; padding: 10px 14px 8px; border-bottom: 1px solid var(--border); }
.gchart { min-width: 0; } .gchart-title { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; font-size: 13px; margin-bottom: 4px; }
.gchart svg.chart { max-height: 150px; } .gchart-words .small { color: var(--muted-foreground); } .gchart-words b { color: var(--foreground); font-weight: 600; } .gchart-words b.bad { color: var(--error-foreground); }
svg.chart .gpt.est { stroke-dasharray: 2 2; } .guard-legend .lg-est { width: 9px; height: 9px; border: 1.5px dashed var(--info); border-radius: 50%; vertical-align: -1px; }
svg.chart .gline { fill: none; stroke: var(--info); stroke-width: 2; }
svg.chart .gpt { fill: var(--card); stroke: var(--info); stroke-width: 2; } svg.chart .gpt.near { stroke: var(--warning); }
svg.chart .start { stroke: var(--muted-foreground); stroke-width: 1; stroke-dasharray: 2 3; }
svg.chart .limit { stroke: var(--error); stroke-width: 1.5; stroke-dasharray: 5 4; }
svg.chart .lbl-limit { fill: var(--error-foreground); font-weight: 600; } svg.chart .glast { fill: var(--foreground); font-weight: 600; }
.guard-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; padding: 4px 14px 10px; border-bottom: 1px solid var(--border); }
.guard-legend i { display: inline-block; width: 18px; vertical-align: middle; margin-right: 6px; border-top: 2px solid var(--info); }
.guard-legend .lg-start { border-top: 1px dotted var(--muted-foreground); } .guard-legend .lg-limit { border-top: 2px dashed var(--error); }
.lad-guards { grid-column: 2 / -1; display: flex; flex-wrap: wrap; gap: 2px 14px; font-size: 12px; color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
.lad-guards b { color: var(--foreground); font-weight: 600; } .lad-guards .near, .lad-guards .near b { color: var(--warning-foreground); }
.ar-lane { color: var(--muted-foreground); font-family: var(--font-mono); font-size: 12px; }
.ar-age { color: var(--muted-foreground); font-size: 12px; text-align: right; }
/* an attempt's page */
.att-head { margin-bottom: 8px; }
.att-crumb { display: flex; align-items: center; gap: 8px; color: var(--muted-foreground); font-size: 13px; margin-bottom: 6px; }
.att-title { font-size: 20px; line-height: 1.3; margin: 0 0 6px; max-width: 920px; font-weight: 650; }
.att-head a { color: var(--primary); }
.decide { border: 1px solid color-mix(in srgb, var(--warning) 45%, var(--border)); background: var(--warning-surface); border-radius: var(--radius); padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.decide-bad { border-color: color-mix(in srgb, var(--error) 45%, var(--border)); background: var(--error-surface); }
.decide-violet { border-color: color-mix(in srgb, var(--violet-foreground) 35%, var(--border)); background: color-mix(in srgb, var(--violet-foreground) 6%, transparent); }
.decide-q { display: flex; align-items: center; gap: 12px; font-size: 14px; }
.decide-q .dq-age { margin-left: auto; }
.decide-why { font-size: 13px; }
.decide dl.dq-choices { border-top-color: color-mix(in srgb, var(--foreground) 12%, transparent); }
ol.stepper { list-style: none; margin: 0; padding: 0; }
ol.stepper li { display: grid; grid-template-columns: 14px minmax(0, 1fr) 40px; gap: 10px; align-items: start; padding: 6px 0; font-size: 13px; position: relative; }
ol.stepper li:not(:last-child)::before { content: ""; position: absolute; left: 4px; top: 18px; bottom: -8px; width: 2px; background: var(--border); }
ol.stepper .sd { width: 10px; height: 10px; border-radius: 50%; background: var(--border); margin-top: 4px; position: relative; z-index: 1; }
ol.stepper li.ok .sd { background: var(--success); } ol.stepper li.bad .sd { background: var(--error); } ol.stepper li.warn .sd { background: var(--warning); }
ol.stepper li.ok .st { color: var(--success-foreground); } ol.stepper li.bad .st { color: var(--error-foreground); } ol.stepper li.warn .st { color: var(--warning-foreground); }
ol.stepper .sa { color: var(--muted-foreground); font-size: 12px; text-align: right; }
details.matrix .card { border: 0; border-radius: 0; }
.fw { padding: 9px 14px; border-bottom: 1px solid var(--border); font-size: 13px; } .fw:last-child { border-bottom: 0; }
.fl { display: grid; grid-template-columns: minmax(0, 1fr) 130px 84px; gap: 10px; align-items: center; padding: 8px 14px; border-bottom: 1px solid var(--border); font-size: 13px; }
.fl:last-child { border-bottom: 0; }
.fl code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fl-bar { display: flex; height: 8px; } .fl-bar i { display: block; } .fl-bar .add { background: var(--success); } .fl-bar .rem { background: var(--error); }
.fl-n { text-align: right; font-size: 12px; font-variant-numeric: tabular-nums; }
/* a run's work in git (goal 185): its branch, each champion's commit and menu, the drawer */
.gitline { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; padding: 8px 14px; border-bottom: 1px solid var(--border); font-size: 13px; }
.lad-sha { grid-column: 2 / -1; font-size: 12px; color: var(--muted-foreground); }
.lad-menu { position: relative; } .lad-menu > summary { list-style: none; cursor: pointer; color: var(--muted-foreground); padding: 0 6px; border-radius: 6px; }
.lad-menu > summary::-webkit-details-marker { display: none; } .lad-menu > summary:hover { background: var(--muted); }
.lad-menu .menu-pop { top: 24px; width: min(300px, 86vw); } .lad-menu .mi { display: grid; text-align: left; background: none; border: 0; padding: 6px 8px; border-radius: 6px; color: inherit; cursor: pointer; font: inherit; }
.lad-menu .mi:hover { background: var(--muted); text-decoration: none; } button[data-copied]::after { content: " ✓"; color: var(--success-foreground); }
#from-champion [data-when-change] { display: none; margin-top: 6px; } #from-champion fieldset:has(input[value="change"]:checked) [data-when-change] { display: block; }`;
