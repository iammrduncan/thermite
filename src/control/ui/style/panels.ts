/**
 * Close run, the panels from the right (Start a run, Copy a campaign), the MCP servers' choices,
 * and a campaign's own agents' context.
 */
export const PANELS = `/* Close run, in a run's ⋯ (goal 087) */
.menu-pop.export-pop { width: min(340px, 86vw); } .export-now { gap: 8px; } .export-now .ch { margin-bottom: 0; padding: 10px 12px; } .export-now button { justify-content: center; }
.close-run { gap: 8px; } .close-run label { display: flex; flex-direction: column; gap: 5px; } .close-run input { width: 100%; } .close-run button { justify-content: center; }
/* Start a run: a panel from the right */
.drawer-wrap { position: fixed; inset: 0; z-index: 50; }
.drawer-wrap[hidden] { display: none; }
.drawer-bg { position: absolute; inset: 0; background: rgb(0 0 0 / 28%); }
.drawer { position: absolute; top: 0; right: 0; bottom: 0; width: 540px; max-width: 100vw; background: var(--background); border-left: 1px solid var(--border); box-shadow: -10px 0 30px rgb(0 0 0 / 12%); }
.drawer-form { display: flex; flex-direction: column; height: 100%; }
.drawer-form > header { padding: 14px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; }
.drawer-form > header h3 { margin: 0; font-size: 15px; }
.drawer-body { padding: 18px 20px; overflow: auto; flex: 1; display: grid; gap: 18px; align-content: start; }
.drawer-form > footer { padding: 12px 20px; border-top: 1px solid var(--border); display: flex; gap: 10px; align-items: center; background: var(--card); }
.sfd { display: grid; gap: 7px; }
.sfd > .lb { font-size: 13px; font-weight: 600; }
.sfd select, .sfd input { height: 32px; padding: 0 10px; border-radius: var(--control-radius); border: 1px solid var(--input); background: var(--card); font-size: 13px; width: 100%; }
.sopts { display: grid; gap: 6px; }
.sopt { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; gap: 8px; align-items: start; padding: 9px 11px; border: 1px solid var(--border); border-radius: var(--control-radius); background: var(--card); cursor: pointer; font-size: 13px; }
.sopt:has(input:checked) { border-color: var(--primary); background: var(--primary-surface); }
.sopt.dis { opacity: .5; cursor: not-allowed; }
.sopt input { margin: 2px 0 0; height: auto; }
.sopt .sd { display: block; font-size: 12px; color: var(--muted-foreground); margin-top: 2px; }
.sopt .sr { font-size: 12px; white-space: nowrap; }
.sgrid { display: grid; gap: 14px; }
/* MCP servers (goal 068): their tools in Settings, and the kit's servers on the new-campaign page */
.tools { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.tools th { text-align: left; font-weight: 600; font-size: 12px; color: var(--muted-foreground); padding: 4px 8px; border-bottom: 1px solid var(--border); }
.tools td { padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
.tools tr:last-child td { border-bottom: 0; }
.tools td:first-child { font-family: var(--font-mono); white-space: nowrap; width: 1%; }
.more-tools summary { cursor: pointer; margin-top: 6px; }
.mcp-pick { display: grid; gap: 6px; }
.mcp-pick .sopt { grid-template-columns: 18px minmax(0, 1fr) auto; cursor: default; }
.mcp-pick .sopt:has(input:checked) { border-color: var(--border); background: var(--card); }
.mcp-pick .sopt:has(> input[data-srv-on]:checked) { border-color: var(--primary); background: var(--primary-surface); }
.mcp-who { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.mcp-who label { display: inline-flex; gap: 5px; align-items: center; height: 24px; padding: 0 9px; border: 1px solid var(--input); border-radius: 999px; font-size: 12px; background: var(--card); cursor: pointer; }
.mcp-who label:has(input:checked) { border-color: var(--primary); background: var(--primary-surface); }
.mcp-who input { height: auto; width: auto; margin: 0; }
.mcp-who.off { opacity: .45; pointer-events: none; }
.mcp-adv { margin-top: 8px; }
.mcp-tools td input { height: auto; width: auto; margin: 0; }
.mcp-tools td:not(:first-child):not(:nth-child(2)), .mcp-tools th:not(:first-child):not(:nth-child(2)) { text-align: center; width: 1%; }
/* Copy a campaign (goal 069): a panel like Start a run's */
#copy [hidden] { display: none !important; }
.cp-why { margin: 0; font-size: 14px; line-height: 1.55; }
.cp-say { font-size: 12.5px; line-height: 1.5; color: var(--muted-foreground); }
.cp-say.ok { color: var(--success-foreground); } .cp-say.bad { color: var(--error-foreground); }
.cp-say button { margin-left: 4px; vertical-align: baseline; height: 24px; font-size: 12px; padding: 0 8px; }
.sfd input.bad { border-color: var(--error); }
.cp-mcp-sum { font-size: 13px; line-height: 1.55; margin: 2px 0 0; display: grid; gap: 4px; }
.cp-req { white-space: pre-wrap; word-break: break-word; }
/* goal 070: a campaign's own agents' context */
.cc-f { display: grid; grid-template-columns: repeat(2, minmax(0, 220px)); gap: 0 16px; }
.cc-f .fd { margin-bottom: 4px; }
.cc-in { display: flex; align-items: center; gap: 8px; }
.cc-in input { flex: 1; min-width: 0; font-variant-numeric: tabular-nums; }
.fd .cc-in input.bad:not([type=checkbox]), .sfd .cc-in input.bad:not([type=checkbox]) { border-color: var(--error); }
.cc-in .muted { white-space: nowrap; }
.cc-help { font-size: 12.5px; line-height: 1.45; color: var(--muted-foreground); }
.cc-say { font-size: 12.5px; line-height: 1.45; margin-top: 3px; }
.cc-say:empty { display: none; }
.cc-say.bad { color: var(--error-foreground); } .cc-say.ok { color: var(--success-foreground); } .cc-say.warn { color: var(--warning-foreground); }
.cc-say b, .cc-line b, .cc-t b { font-weight: 650; }
.cc-sec { margin: 4px 0 14px; }
.cc-sec h2 { font-size: 14px; }
.cc-rigs-h { margin: 16px 0 6px; }
.cc-tw { max-width: 620px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.cc-t th, .cc-t td { padding: 7px 12px; }
.cc-t td.num, .cc-t th.num { text-align: right; font-variant-numeric: tabular-nums; }
.cc-t tr:last-child td { border-bottom: 0; }
.cc-t tr.bad td { background: var(--error-surface); }
.cc-st.ok { color: var(--success-foreground); } .cc-st.bad { color: var(--error-foreground); }
.cc-line .bad, .cc-rignote.bad { color: var(--error-foreground); }
.cc-act { margin-top: 14px; }
.cc-chg.bad { color: var(--error-foreground); }
[data-start-sum].bad { color: var(--error-foreground); }
.drawer .cc-f { grid-template-columns: repeat(2, minmax(0, 1fr)); }
@media (max-width: 760px) { .cc-f, .drawer .cc-f { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 600px) { .cc-t { font-size: 12px; } .cc-t th, .cc-t td { padding: 6px; } .cc-t th { white-space: normal; } .cc-t td:first-child { white-space: nowrap; } }
@media (max-width: 600px) {
  /* Copy and Start a run don't fit beside a long name: the buttons go under it. */
  .topbar:has([data-open="#copy"]), .topbar:has([data-campaign-more]) { flex-wrap: wrap; row-gap: 6px; padding-top: 8px; padding-bottom: 8px; }
  .drawer .mcp-pick .sopt { grid-template-columns: 18px minmax(0, 1fr); }
  .drawer .mcp-pick .sopt > .sr { display: none; }
}`;
