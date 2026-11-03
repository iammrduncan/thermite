/**
 * Settings › Retention policies: the policy form's fields, its segmented choices and preview, Run
 * now's confirmation in the page, and the list of what no policy removes.
 */
export const RETENTION = `/* The policy form: a label column and its controls. */
.rt-form { display: grid; gap: 16px; }
.rt-head { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: baseline; justify-content: space-between; }
.rt-head h3 { margin: 0; font-size: 15px; }
.rt-field { display: grid; grid-template-columns: 190px minmax(0, 1fr); gap: 6px 16px; align-items: start; }
@media (max-width: 760px) { .rt-field { grid-template-columns: 1fr; } }
.rt-lab { font-weight: 600; font-size: 13px; padding-top: 6px; }
.rt-ctl { display: grid; gap: 8px; min-width: 0; }
.rt-ctl input[type=text] { width: 100%; max-width: 360px; }
.rt-ctl input[type=number] { width: 90px; }
.rt-ctl input[type=text], .rt-ctl input[type=number], .rt-ctl input[type=time], .rt-ctl select { height: 32px; padding: 0 9px; border: 1px solid var(--input); border-radius: var(--control-radius); background: var(--card); font-size: 13px; max-width: 100%; }
.rt-seg { display: inline-flex; flex-wrap: wrap; border: 1px solid var(--input); border-radius: var(--control-radius); overflow: hidden; width: fit-content; max-width: 100%; padding: 0; margin: 0; }
.rt-seg label { display: inline-flex; cursor: pointer; }
.rt-seg label + label { border-left: 1px solid var(--input); }
.rt-seg input { position: absolute; opacity: 0; width: 0; height: 0; }
.rt-seg span { padding: 6px 12px; font-size: 13px; background: var(--card); }
.rt-seg input:checked + span { background: var(--primary); color: var(--primary-foreground); font-weight: 600; }
.rt-seg input:focus-visible + span { outline: 2px solid color-mix(in srgb, var(--primary) 45%, transparent); outline-offset: -2px; }
.rt-picks, .rt-row { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; font-size: 13px; }
.rt-picks label, .rt-checks label { display: flex; gap: 6px; align-items: center; font-size: 13px; }
.rt-checks { display: grid; gap: 6px; }
.rt-kindinfo { font-size: 12.5px; color: var(--muted-foreground); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; background: var(--accent); }
.rt-warn { margin-top: 8px; color: var(--foreground); }
.rt-preview { border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; display: grid; gap: 6px; background: var(--accent); }
.rt-preview b { font-size: 15px; }
.rt-foot { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; border-top: 1px solid var(--border); padding-top: 14px; }
/* Run now asks first, in the page. */
.rt-confirm { border: 1px solid var(--error); background: var(--error-surface); border-radius: var(--radius); padding: 14px 16px; display: grid; gap: 10px; }
button.danger.solid { background: var(--error); color: #fff; border-color: var(--error); font-weight: 600; }
.rt-empty { display: grid; gap: 10px; justify-items: start; padding: 22px 18px; }
.rt-empty b { font-size: 15px; }
.rt-never { display: grid; gap: 8px; }
.rt-never div { display: grid; grid-template-columns: 210px minmax(0, 1fr); gap: 4px 14px; font-size: 13px; }
@media (max-width: 640px) { .rt-never div { grid-template-columns: 1fr; } }
`;
