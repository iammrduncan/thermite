/** A rig's state and the steps of a change under way; RunPod's launch form and a rig's pod. */
export const RUNPOD = `/* a rig's page: its state, and the steps of a change under way */
.card.ok { border-color: color-mix(in srgb, var(--success) 45%, transparent); }
button:disabled { opacity: .5; cursor: not-allowed; }
.steps { display: grid; gap: 2px; margin: 10px 0 0; }
.step { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 10px; align-items: start; padding: 4px 0; font-size: 13px; line-height: 1.45; }
.step .ic { width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 700; margin-top: 1px; }
.step.ok .ic { background: var(--success-surface); color: var(--success-foreground); }
.step.bad .ic { background: var(--error-surface); color: var(--error-foreground); }
.step.wait .ic { border: 2px solid var(--border); border-top-color: var(--primary); animation: stepspin 0.9s linear infinite; }
.step.todo { color: var(--muted-foreground); } .step.todo .ic { border: 2px solid var(--border); }
@keyframes stepspin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .step.wait .ic { animation: none; } }
.flash { padding: 8px 12px; border-radius: 8px; background: var(--success-surface); color: var(--success-foreground); font-size: 13px; }
.flash.bad { background: var(--error-surface); color: var(--error-foreground); }
/* RunPod: the launch form and a rig's pod */
.gtab { display: grid; grid-template-columns: 18px minmax(0, 1.4fr) 80px 110px 110px; gap: 10px; align-items: center; padding: 9px 14px; border-bottom: 1px solid var(--border); font-size: 13px; cursor: pointer; }
.gtab:last-child { border-bottom: 0; }
.gtab.hd { color: var(--muted-foreground); font-size: 12px; font-weight: 600; background: var(--muted); cursor: default; }
.gtab.on { background: var(--primary-surface); }
.gtab .num { text-align: right; font-variant-numeric: tabular-nums; }
.gtab input { width: auto; height: auto; margin: 0; accent-color: var(--primary); }
@media (max-width: 760px) { .gtab { grid-template-columns: 18px minmax(0, 1fr) 90px; } .gtab > :nth-child(3), .gtab > :nth-child(5) { display: none; } }
.price { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; }
.facts4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 0 0 14px; }
@media (max-width: 900px) { .facts4 { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.fact { border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; background: var(--card); }
.fact .k { color: var(--muted-foreground); font-size: 12px; display: flex; gap: 6px; align-items: center; }
.fact .v { font-size: 20px; font-weight: 650; margin-top: 2px; font-variant-numeric: tabular-nums; }
.fact .s { color: var(--muted-foreground); font-size: 12px; margin-top: 2px; }
.fact .bar { margin-top: 8px; }
.lc { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
@media (max-width: 1100px) { .lc { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.lcb { border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px; background: var(--card); display: grid; gap: 6px; align-content: start; font-size: 12.5px; line-height: 1.45; }
.lcb.off { opacity: .55; }
.lcb button { justify-content: center; }
.lcb .muted { font-size: 12px; }
.lcb input { height: 30px; padding: 0 8px; border: 1px solid var(--input); border-radius: var(--control-radius); background: var(--background); font-size: 12.5px; width: 100%; }
.podlog { max-height: 420px; overflow: auto; display: flex; flex-direction: column-reverse; padding: 8px 10px; background: var(--code-background); border-radius: var(--control-radius); }
.pl { display: grid; grid-template-columns: 66px 60px minmax(0, 1fr); gap: 8px; font: 12px/18px var(--font-mono); }
.pl-src, .pl-t { color: var(--muted-foreground); white-space: nowrap; }
.pl.system .pl-src { color: var(--violet-foreground); }
.pl-l { color: var(--foreground); white-space: pre-wrap; word-break: break-word; }
.outlist { display: grid; gap: 0; }
.outrow { display: grid; grid-template-columns: 18px minmax(0, 1fr) 120px; gap: 10px; align-items: center; padding: 7px 0; border-bottom: 1px solid var(--border); font-size: 12.5px; }
.outrow:last-child { border-bottom: 0; }
.outrow .small { text-align: right; }`;
