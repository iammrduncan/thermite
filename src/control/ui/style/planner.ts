/**
 * The experiment queue and the Planner tab: experiments, rules, a research run's hypotheses,
 * directions and their picker, and Tell the planner.
 */
export const PLANNER = `/* The experiment queue and the Planner tab (goal 064) */
.qcols { display: grid; grid-template-columns: minmax(0, 1fr) 330px; gap: 20px; align-items: start; }
@media (max-width: 1100px) { .qcols { grid-template-columns: minmax(0, 1fr); } }
.qside { display: grid; gap: 14px; }
.qcard { padding: 12px 14px; display: grid; gap: 8px; font-size: 13px; }
.qcard h3 { margin: 0; font-size: 13px; font-weight: 650; }
.qlist { display: grid; gap: 6px; }
.qi { display: grid; grid-template-columns: 18px 22px minmax(0, 1fr) auto; gap: 10px; align-items: start; padding: 10px 12px; background: var(--card); border: 1px solid var(--border); border-radius: 10px; }
.qi.drag { opacity: .45; } .qi.over { box-shadow: 0 -2px 0 var(--primary); }
.qh { cursor: grab; color: var(--muted-foreground); user-select: none; line-height: 20px; }
.qn { font: 600 12px var(--font-mono); color: var(--muted-foreground); line-height: 20px; }
.qt { font-weight: 600; font-size: 13.5px; }
.qwhy { font-size: 12.5px; color: var(--muted-foreground); margin-top: 3px; }
.qmeta { display: flex; gap: 8px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
.qacts { display: flex; gap: 4px; align-items: center; opacity: .35; } .qi:hover .qacts, .qi:focus-within .qacts { opacity: 1; }
.qacts form { display: inline; }
.qsrc { display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 5px; font-size: 11px; font-weight: 600; white-space: nowrap; }
.qsrc.planner { background: color-mix(in srgb, #7c3aed 12%, transparent); color: var(--violet-foreground); }
.qsrc.teacher { background: color-mix(in srgb, #0d9488 13%, transparent); color: #0f766e; }
.qsrc.auditor { background: var(--accent); color: var(--muted-foreground); }
.qsrc.you { background: var(--primary-surface); color: var(--info-foreground); }
.qsrc.lane { background: color-mix(in srgb, #0e7490 12%, transparent); color: #0e7490; }
.qdir { font: 500 11.5px var(--font-mono); color: var(--muted-foreground); }
.qadd { display: grid; grid-template-columns: minmax(0, 1fr) 180px 140px auto; gap: 8px; align-items: end; padding: 12px; border: 1px dashed var(--input); border-radius: 10px; margin-bottom: 10px; }
.qadd .qwhy-f { grid-column: 1 / -2; }
@media (max-width: 760px) { .qadd { grid-template-columns: minmax(0, 1fr); } .qadd .qwhy-f { grid-column: auto; } }
.qlane { display: grid; gap: 3px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; }
.qlt { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--muted-foreground); }
.qlt b { color: var(--foreground); }
.qidea { display: grid; gap: 4px; padding: 8px 10px; border: 1px dashed var(--input); border-radius: 8px; }
.qb { display: flex; gap: 6px; margin-top: 2px; } .qb form { display: inline; }
.qres { font-weight: 600; font-size: 12.5px; }
.menu-pop.qedit { width: min(360px, 86vw); } .menu-pop.qedit form { display: grid; gap: 8px; } .menu-pop.qedit textarea, .menu-pop.qedit input { width: 100%; }
.qres.win, .qres.done { color: var(--success-foreground); } .qres.wait { color: var(--warning-foreground); } .qres.broken { color: var(--error-foreground); } .qres.loss, .qres.flat, .qres.none { color: var(--muted-foreground); font-weight: 500; }
.qrules { display: grid; gap: 8px; }
.qrule { display: grid; grid-template-columns: 70px minmax(0, 1fr) auto; gap: 10px; align-items: start; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); font-size: 13px; }
.qrule form { display: inline; }
.qkind { font: 700 11px var(--font-mono); text-transform: uppercase; padding: 3px 7px; border-radius: 5px; text-align: center; background: var(--accent); color: var(--muted-foreground); }
.qkind.avoid { background: var(--error-surface); color: var(--error-foreground); } .qkind.always { background: var(--success-surface); color: var(--success-foreground); } .qkind.try { background: var(--primary-surface); color: var(--info-foreground); }
.qrule.legacy { border-style: dashed; }
/* A research run's hypotheses (goal 117): their status as a rule's kind, the owner's moves */
.qkind.author { background: var(--primary-surface); color: var(--info-foreground); } .qkind.promoted { background: var(--success-surface); color: var(--success-foreground); }
.qkind.retired { background: var(--error-surface); color: var(--error-foreground); }
.qrule.hy { grid-template-columns: 84px minmax(0, 1fr) auto; }
.hy-move { display: inline-flex; align-items: center; gap: 2px; }
.hy-move .ii { width: 13px; height: 13px; font-size: 9px; }
.qrule .qb { margin-top: 0; }
@media (max-width: 760px) { .qrule { grid-template-columns: 64px minmax(0, 1fr); } .qrule > :last-child { grid-column: 2; } }
/* Directions, written :name: (goal 066); dashed while the planner has yet to design one */
.dtok { display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 6px; font: 500 12px var(--font-mono); background: color-mix(in srgb, #7c3aed 10%, transparent); color: var(--violet-foreground); white-space: nowrap; vertical-align: baseline; }
.dtok i { font-style: normal; opacity: .45; }
.dtok.new { background: transparent; border: 1px dashed color-mix(in srgb, #7c3aed 45%, transparent); }
.dtok.bad { background: var(--error-surface); color: var(--error-foreground); }
.dlist { display: grid; gap: 2px; max-height: 480px; overflow-y: auto; }
.dlrow { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 4px 8px; align-items: center; padding: 5px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
.dlrow:last-child { border-bottom: 0; }
.dlrow .muted { margin-left: auto; text-align: right; }
.dlrow.fresh { background: color-mix(in srgb, #7c3aed 5%, transparent); }
.dlrow .qkind, .dpick .qkind { padding: 1px 5px; }
/* The : picker in Tell the planner */
.dpick { position: fixed; z-index: 60; width: 360px; max-width: calc(100vw - 24px); background: var(--card); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 12px 34px rgb(0 0 0 / 18%); font-size: 13px; overflow: hidden; }
.dpick[hidden] { display: none; }
.dpick .dh { padding: 8px 12px 6px; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--muted-foreground); border-bottom: 1px solid var(--border); }
.dpick .dl { max-height: 260px; overflow-y: auto; padding: 4px; }
.dpick .dr { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 10px; padding: 7px 9px; border-radius: 7px; cursor: pointer; }
.dpick .dr.on { background: var(--primary-surface); }
.dpick .dr.fresh { border-top: 1px dashed var(--border); border-radius: 0 0 7px 7px; }
.dpick .dr .n { font: 500 12.5px var(--font-mono); }
.dpick .dr .r { display: flex; gap: 4px; font-size: 11px; }
.dpick .dr .s { grid-column: 1 / -1; font-size: 11.5px; color: var(--muted-foreground); }
.dpick .dnone { padding: 10px 12px; color: var(--muted-foreground); font-size: 12.5px; line-height: 1.45; }
.dpick .df { padding: 6px 12px; border-top: 1px solid var(--border); font-size: 11.5px; color: var(--muted-foreground); }
.dpick kbd { font: 600 10.5px var(--font-mono); padding: 1px 5px; border: 1px solid var(--border); border-radius: 4px; background: var(--muted); }
/* Tell the planner: the box, and each message with the planner's answer */
.qtell { display: grid; gap: 8px; }
.qtell .ktools { margin: 0; }
.qtell .nc-does { margin: 2px 0 0; }
.qthread { display: grid; gap: 12px; margin-top: 4px; }
.qthread:empty { display: none; }
.qturn { display: grid; gap: 6px; }
.qmsg { padding: 8px 11px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; line-height: 1.55; overflow-wrap: anywhere; }
.qmsg.you { background: var(--muted); }
.qmsg.planner { border-color: color-mix(in srgb, #7c3aed 30%, var(--border)); }
.qmsg ul { margin: 4px 0 0; padding-left: 18px; display: grid; gap: 5px; }
.qmh { margin-bottom: 3px; }
.qstep { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 10px; align-items: start; font-size: 13px; line-height: 1.45; color: var(--muted-foreground); }
.qstep .ic { width: 18px; height: 18px; border-radius: 50%; margin-top: 1px; border: 2px solid var(--border); }
.qstep.wait .ic { border-top-color: var(--primary); animation: qspin .9s linear infinite; }
@keyframes qspin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .qstep.wait .ic { animation: none; } }
.qhands { padding: 4px 14px; margin-bottom: 22px; }
.qhand { display: grid; grid-template-columns: 54px minmax(0, 1fr); gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.qhand:last-child { border-bottom: 0; }
.qhand .tm { font: 12px var(--font-mono); color: var(--muted-foreground); }
.qhand ul { margin: 4px 0 0; padding-left: 18px; display: grid; gap: 2px; }`;
