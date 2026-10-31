/**
 * Forms: Edit rig's parts and their switches, fields, choice cards and sections, and New
 * campaign's brief, Markdown, steps and tables.
 */
export const FORMS = `/* Edit rig: one row per part, with its switch. */
.pt { display: grid; grid-template-columns: 52px minmax(0, 1fr); gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--border); }
.pt:last-child { border-bottom: 0; } .pt.locked { opacity: .8; } .pt-off { margin-top: 4px; color: var(--muted-foreground); }
.pt-state { font-size: 12px; } .pt-state.on { color: var(--success-foreground); } .pt-state.off { color: var(--warning-foreground); }
.sw { position: relative; display: inline-block; width: 40px; height: 22px; margin-top: 2px; }
.sw input { opacity: 0; width: 0; height: 0; }
.knob { position: absolute; inset: 0; background: var(--border); border-radius: 999px; transition: .15s; cursor: pointer; }
.knob::before { content: ""; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: .15s; box-shadow: 0 1px 2px rgba(0,0,0,.2); }
.sw input:checked + .knob { background: var(--primary); } .sw input:checked + .knob::before { transform: translateX(18px); }
.sw input:disabled + .knob { cursor: not-allowed; opacity: .6; }
.chg li { margin: 2px 0; }
.kind { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; }
.kind.m { background: var(--primary-surface); color: var(--info-foreground); }
.kind.r { background: var(--warning-surface); color: var(--warning-foreground); }
.kind.g { background: color-mix(in srgb, var(--violet-foreground) 14%, transparent); color: var(--violet-foreground); }
.fd { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; min-width: 0; }
.fd input:not([type=checkbox]):not([type=file]), .fd select, .fd textarea { height: 34px; padding: 0 10px; border: 1px solid var(--input); border-radius: var(--control-radius); background: var(--card); font-size: 13px; width: 100%; }
.fd textarea { height: 64px; padding: 8px 10px; font-family: var(--font-mono); font-size: 12px; }
.g2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px; }
.g3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 16px; }
.cards3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
@media (max-width: 900px) { .g2, .g3, .cards3 { grid-template-columns: 1fr; } }
.ch { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 10px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 8px; font-size: 13px; line-height: 1.45; cursor: pointer; background: var(--card); }
.ch > :only-child { grid-column: 1 / -1; }
.ch:hover { border-color: color-mix(in srgb, var(--foreground) 30%, transparent); }
.ch.on { border-color: var(--primary); background: var(--primary-surface); }
.ch.dis { opacity: .5; cursor: not-allowed; }
.ch b { display: block; font-size: 13.5px; margin-bottom: 2px; }
.ch .muted { font-size: 12.5px; }
.dotx { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--input); margin-top: 2px; }
.ch.on .dotx { border-color: var(--primary); background: radial-gradient(var(--primary) 0 3px, transparent 4px); }
.sec { margin-bottom: 26px; }
.sec > h2 { font-size: 15px; margin: 0 0 4px; }
.sec > p.lead { margin: 0 0 12px; color: var(--muted-foreground); font-size: 13px; line-height: 1.5; max-width: 820px; }
.nc-does { border-left: 3px solid var(--border); padding: 4px 0 4px 12px; margin: 12px 0 0; color: var(--muted-foreground); font-size: 13px; line-height: 1.5; }
.nc-does b { color: var(--foreground); font-weight: 600; }
/* A campaign's brief (goal 078): New campaign's boxes and preview, and its page's block */
.nc-brief { max-width: 1040px; }
.bl { display: grid; gap: 6px; }
.bl-row { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; gap: 8px; align-items: start; }
.bl-k { display: inline-grid; place-items: center; width: 22px; height: 22px; margin-top: 6px; border-radius: 50%; background: var(--accent); color: var(--muted-foreground); font-size: 11px; font-weight: 600; }
.fd .bl-row textarea { height: 54px; min-height: 34px; max-height: 480px; padding: 7px 10px; font: 13px/1.45 var(--font-sans); resize: vertical; }
.bl-row button { margin-top: 4px; }
.bl-act { margin-top: 2px; }
.md-two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
@media (max-width: 900px) { .md-two { grid-template-columns: 1fr; } }
.fd .md-two textarea.md-in { height: 260px; min-height: 120px; padding: 8px 10px; font-size: 12.5px; line-height: 1.5; }
.md-out { height: 260px; overflow: auto; padding: 6px 12px; border: 1px dashed var(--input); border-radius: var(--control-radius); background: var(--muted); }
[data-md-say].bad, [data-bl-n].bad { color: var(--error-foreground); }
.md { font-size: 13.5px; line-height: 1.55; overflow-wrap: anywhere; }
.md h3, .md h4, .md h5, .md h6 { margin: 12px 0 4px; font-size: 14px; } .md h3 { font-size: 15px; }
.md > :first-child { margin-top: 6px; }
.md p { margin: 6px 0; } .md ul, .md ol { margin: 6px 0; padding-left: 22px; } .md li { margin: 2px 0; }
.md a { color: var(--primary); text-decoration: underline; text-underline-offset: 2px; }
.md pre { margin: 6px 0; padding: 8px 10px; background: var(--code-background); border-radius: var(--control-radius); overflow: auto; white-space: pre-wrap; }
.md blockquote { margin: 6px 0; padding: 0 0 0 10px; border-left: 3px solid var(--border); color: var(--muted-foreground); }
.md hr { border: 0; border-top: 1px solid var(--border); margin: 10px 0; }
.kbrief { display: grid; gap: 14px; }
.kb-part .lb { margin-bottom: 4px; }
.kb-list { margin: 4px 0 0; padding-left: 22px; font-size: 13.5px; line-height: 1.5; } .kb-list li { margin: 3px 0; }
.kb-info > summary { cursor: pointer; font-size: 13px; }
.kb-info .md { margin-top: 6px; padding: 4px 12px; border-left: 3px solid var(--border); }
.sum { font-size: 15px; line-height: 1.6; margin: 0 0 12px; }
.act { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.big { height: 38px; padding: 0 18px; font-size: 14px; }
.wiz { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 24px; align-items: start; }
@media (max-width: 760px) { .wiz { grid-template-columns: 1fr; } }
ol.nc-steps { list-style: none; margin: 0; padding: 0; position: sticky; top: 70px; }
ol.nc-steps li { display: flex; gap: 10px; align-items: center; padding: 8px 10px; border-radius: 8px; font-size: 13px; color: var(--muted-foreground); cursor: pointer; }
ol.nc-steps li .k { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--border); font-size: 11px; font-weight: 600; }
ol.nc-steps li.on { background: var(--accent); color: var(--foreground); font-weight: 600; }
ol.nc-steps li.on .k { background: var(--foreground); color: var(--background); border-color: var(--foreground); }
ol.nc-steps li.done .k { background: var(--success-surface); color: var(--success-foreground); border-color: transparent; }
.adv { border: 1px dashed var(--border); border-radius: var(--radius); padding: 0; margin-top: 8px; }
.adv > summary { cursor: pointer; padding: 10px 14px; font-size: 13px; font-weight: 600; color: var(--muted-foreground); }
.adv[open] > summary { border-bottom: 1px dashed var(--border); }
.adv > div { padding: 14px; }
.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl th { text-align: left; font-size: 12px; color: var(--muted-foreground); font-weight: 600; padding: 6px 8px; }
.tbl td { padding: 4px 8px; }
.tbl input, .tbl select { height: 30px; width: 100%; padding: 0 8px; border: 1px solid var(--input); border-radius: var(--control-radius); background: var(--card); font-size: 12.5px; }
.ph { display: inline-flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
.ph button { height: 24px; font-family: var(--font-mono); font-size: 11px; padding: 0 8px; }
pre.json { background: var(--muted); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; font-size: 11.5px; max-height: 360px; overflow: auto; margin: 0; }`;
