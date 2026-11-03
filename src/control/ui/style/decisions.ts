/**
 * The owner's decisions, one row each and opened with the evidence and each choice; a research
 * run's reviews; facts lists and choices.
 */
export const DECISIONS = `/* decisions: one row each (what, why, facts, buttons); opened, the evidence and each choice */
.dqs { border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); overflow: hidden; }
.dq { border-bottom: 1px solid var(--border); }
.dq:last-child { border-bottom: 0; }
.dq > summary { list-style: none; display: grid; grid-template-columns: 120px minmax(0, 1fr) auto; gap: 14px; align-items: start; padding: 12px 14px; cursor: pointer; }
.dq > summary::-webkit-details-marker { display: none; }
.dq > summary:hover, .dq[open] > summary { background: var(--muted); }
.dq-kind { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: 13px; white-space: nowrap; padding-top: 1px; color: var(--warning-foreground); }
.dq-bad .dq-kind { color: var(--error-foreground); } .dq-violet .dq-kind { color: var(--violet-foreground); }
.dq-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dq-head { font-weight: 600; font-size: 14px; line-height: 1.35; }
.dq-why { font-size: 13px; color: var(--muted-foreground); }
.dq-sub { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; margin-top: 3px; }
.dq-where { font-size: 12px; color: var(--muted-foreground); }
.dq-where a { color: inherit; text-decoration: underline; text-decoration-color: var(--border); text-underline-offset: 3px; }
.dq-side { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.dq-age { font-size: 12px; color: var(--muted-foreground); white-space: nowrap; }
.dq-btns { display: flex; gap: 6px; }
.dq-btns button, .dq-btns .btn { height: 28px; padding: 0 10px; }
.dq-body { padding: 4px 14px 16px 148px; display: flex; flex-direction: column; gap: 12px; }
.dq-q { margin: 0; font-weight: 600; font-size: 13px; }
dl.dq-choices { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 6px 14px; margin: 0; padding-top: 10px; border-top: 1px solid var(--border); font-size: 13px; }
dl.dq-choices dt { font-weight: 600; font-size: 12px; padding-top: 1px; } dl.dq-choices dd { margin: 0; }
.dq-foot { font-size: 12px; } .dq-foot a { color: var(--primary); }
/* A research run's reviews (goal 116): each review is a decision's row, by its outcome's tone */
.dq-ok .dq-kind { color: var(--success-foreground); } .dq-info .dq-kind { color: var(--info-foreground); }
.dq-body > .small { margin-top: 2px; }
table.rv-items { font-size: 12.5px; border: 1px solid var(--border); border-radius: 8px; border-collapse: separate; border-spacing: 0; overflow: hidden; }
table.rv-items td { vertical-align: top; } table.rv-items ul.flaws { margin: 0; }
details.rv-who > summary { cursor: pointer; padding: 4px 0; }
details.rv-who > table { margin: 6px 0 4px; }
.rv-lines { padding: 0 12px; border: 1px solid var(--border); border-radius: 8px; margin: 0; }
dl.dc-facts, dl.facts { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 8px 14px; margin: 0; font-size: 13px; }
dl.dc-facts dt, dl.facts dt { color: var(--muted-foreground); font-size: 12px; font-weight: 600; padding-top: 1px; }
dl.dc-facts dd, dl.facts dd { margin: 0; min-width: 0; word-break: break-word; }
ul.stuck-calls { margin: 4px 0 0; padding-left: 18px; } ul.stuck-calls code { word-break: break-all; }
.stuck-stop { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 10px 12px; border: 1px solid var(--error-foreground); border-radius: var(--control-radius); background: var(--error-surface); color: var(--foreground); }
.side dl.facts { grid-template-columns: 90px minmax(0, 1fr); }
.quote { border-left: 2px solid var(--border); padding: 1px 0 1px 10px; font-size: 14px; }
.quote.inline { border: 0; padding: 0; font-style: italic; }
ul.flaws { margin: 4px 0 0; padding-left: 18px; } ul.flaws li { margin: 2px 0; }
.dc-choices { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--border); padding-top: 12px; }
.choice { display: grid; grid-template-columns: 210px minmax(0, 1fr); gap: 12px; align-items: start; font-size: 13px; }
.choice .btns { display: flex; } .choice .btns > span { padding-top: 6px; }
.choice .does { padding-top: 6px; color: var(--foreground); }
@media (max-width: 1100px) { .dq > summary { grid-template-columns: minmax(0, 1fr); } .dq-side { align-items: flex-start; } .dq-body { padding-left: 14px; } .tallies { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 760px) { dl.dc-facts, dl.facts, dl.dq-choices, .choice { grid-template-columns: minmax(0, 1fr); } }`;
