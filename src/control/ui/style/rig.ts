/**
 * A rig's page: its checks and routes, an action followed to its outcome, the forms beside them
 * and a campaign's card.
 */
export const RIG = `/* a rig's page */
.ck { display: grid; grid-template-columns: 90px minmax(0, 1fr) auto; gap: 12px; align-items: start; padding: 11px 14px; border-bottom: 1px solid var(--border); font-size: 13px; }
.ck:last-child { border-bottom: 0; }
.ck-res .chip { min-width: 70px; justify-content: center; }
.ck-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ck-sum { font-size: 13px; } .ck-sum.bad { color: var(--error-foreground); }
.ck-what { color: var(--muted-foreground); font-size: 12px; }
.cks .ck { grid-template-columns: 132px minmax(0, 1fr) auto; }
/* An action followed to its outcome (goal 080): its words beside the button, or at the top. */
.fw-top { display: flex; flex-direction: column; gap: 4px; margin-bottom: 16px; font-size: 13px; font-weight: 500; }
.fw-say { margin-top: 6px; font-size: 12px; color: var(--muted-foreground); }
.fw-say.ok { color: var(--success-foreground); } .fw-say.bad { color: var(--error-foreground); }
.lcol > .fw-say { margin: 0; padding: 6px 14px; border-top: 1px solid var(--border); background: var(--card); }
[data-fw-top] > .fw-top { margin: 0; padding: 8px 14px; border-width: 0 0 1px; border-radius: 0; box-shadow: none; }
.rr { display: grid; grid-template-columns: 80px minmax(0, 1fr) auto 100px; gap: 10px; align-items: center; padding: 9px 14px; border-bottom: 1px solid var(--border); font-size: 13px; color: inherit; }
.rr:last-child { border-bottom: 0; }
.rr:hover { background: var(--muted); text-decoration: none; }
.rr .chip { justify-content: center; }
.rr-need { text-align: right; }
.camp + .camp { margin-top: 16px; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; width: 100%; }
.form-grid label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; font-weight: 600; }
.form-grid label .muted { font-weight: 400; }
.form-grid input, .form-grid select { width: 100%; }
.form-grid input[readonly] { background: var(--muted); color: var(--muted-foreground); }
.form-end { grid-column: 1 / -1; }
.route-name { color: var(--foreground); }
.rr-route { grid-template-columns: 80px minmax(0, 1fr) auto; align-items: center; }
.route-acts { display: flex; gap: 6px; align-items: center; } .route-acts select { width: 260px; } .route-acts select.harness { width: 140px; }
@media (max-width: 760px) { .form-grid { grid-template-columns: minmax(0, 1fr); } }
.camp-top { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--border); }
.camp-name { font-weight: 650; font-size: 15px; }
.camp-said { margin-top: 3px; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
ol.steps { margin: 0; padding-left: 18px; font-size: 13px; } ol.steps li { margin: 3px 0; }
.explain { color: var(--muted-foreground); font-size: 12px; margin: 4px 0 0; }`;
