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
.ar-effect { display: flex; gap: 4px; justify-content: flex-end; }
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
.fl-n { text-align: right; font-size: 12px; font-variant-numeric: tabular-nums; }`;
