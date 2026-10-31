/** The Campaigns and Rigs lists, a campaign's head, and the ⋯ menus. */
export const LISTS = `/* Campaigns: at work, waiting, every campaign (goal 063) */
.av.ck { background: #71717a; }
.kwork { display: grid; grid-template-columns: repeat(auto-fill, minmax(440px, 1fr)); gap: 14px; }
.kwork.one { grid-template-columns: minmax(0, 1fr); }
.kcard { display: flex; flex-direction: column; padding: 0; overflow: hidden; }
.kcard .brief { border: 0; margin: 0; box-shadow: none; flex: 1; }
.kfoot { display: flex; gap: 8px; align-items: center; padding: 8px 14px; border-top: 1px solid var(--border); background: var(--muted); }
.kfoot form { display: inline; }
.kneed { display: flex; gap: 12px; align-items: center; padding: 10px 14px; margin-bottom: 22px; border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent); background: var(--warning-surface); border-radius: var(--radius); font-size: 13px; }
.kneed svg { color: var(--warning-foreground); flex: none; }
.ktools { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
.fchip { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 11px; border-radius: 999px; border: 1px solid var(--input); background: var(--card); color: var(--foreground); font-size: 12.5px; font-weight: 500; }
.fchip:hover { background: var(--accent); text-decoration: none; }
.fchip .n { color: var(--muted-foreground); }
.fchip.on { background: var(--foreground); color: var(--background); border-color: var(--foreground); }
.fchip.on .n { color: color-mix(in srgb, var(--background) 70%, transparent); }
.ksearch { margin-left: auto; }
.ksearch input { height: 30px; width: 260px; max-width: 60vw; padding: 0 10px; border-radius: var(--control-radius); border: 1px solid var(--input); background: var(--card); font-size: 13px; }
.ktable td { vertical-align: middle; }
.ktable tr.click:hover td { background: var(--accent); }
.kname { display: flex; gap: 10px; align-items: center; color: inherit; }
.kname:hover { text-decoration: none; } .kname:hover b { text-decoration: underline; }
.kabout { display: block; font-size: 12px; color: var(--muted-foreground); margin-top: 1px; }
/* the Rigs list: one row for each rig */
.rtable td { vertical-align: top; padding-top: 10px; padding-bottom: 10px; }
.rtable .rsub { display: block; font-size: 12px; color: var(--muted-foreground); margin-top: 1px; white-space: normal; }
.rtable .nowrap, .rtable td.nowrap .rsub { white-space: nowrap; }
.rtable a.kname b { font-size: 13.5px; }
.rtable .vchip { text-decoration: none; cursor: pointer; }
.rtable .vchip:hover { text-decoration: underline; }
.rtable tr.click { cursor: pointer; }
.kdots { display: inline-flex; gap: 10px; font-size: 12.5px; white-space: nowrap; }
.kdot { display: inline-flex; align-items: center; gap: 5px; }
.kdot::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--input); }
.kdot.run::before { background: var(--success); } .kdot.pause::before { background: var(--warning); } .kdot.done::before { background: #a1a1aa; }
.kdot.ok::before { content: "✓"; width: auto; height: auto; border-radius: 0; background: none; color: var(--success-foreground); font-weight: 700; }
.kst { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 6px; font-size: 12px; font-weight: 600; }
.kst.pause { background: var(--warning-surface); color: var(--warning-foreground); } .kst.done { background: var(--accent); color: var(--muted-foreground); }
.kst.ok { background: var(--success-surface); color: var(--success-foreground); }
.khead { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; align-items: start; margin-bottom: 22px; }
.kabout-big { font-size: 14px; margin-top: 3px; }
.kgoals { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.kgoal { font-size: 12px; padding: 3px 8px; border-radius: 6px; background: var(--accent); }
.kgoal.ok { background: var(--success-surface); color: var(--success-foreground); } .kgoal.bad { background: var(--error-surface); color: var(--error-foreground); }
details.kmore > summary { cursor: pointer; text-align: center; padding: 8px; font-size: 12.5px; color: var(--info-foreground); border-top: 1px solid var(--border); }
details.menu { position: relative; display: inline-block; }
details.menu > summary { list-style: none; }
details.menu > summary::-webkit-details-marker { display: none; }
.menu-pop { position: absolute; right: 0; top: 38px; z-index: 30; width: 280px; padding: 10px; display: grid; gap: 6px; background: var(--card); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 10px 30px rgb(0 0 0 / 14%); font-size: 13px; }`;
