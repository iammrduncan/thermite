/**
 * The live session view (Magnesium's session board) and the live view's lines, with what sits
 * between them in the sheet: form labels' info icon, the new-campaign page's rows and a decision's
 * sent note.
 */
export const SESSION = `/* live session view (Magnesium's session board) */
.sessions { width: 280px; flex: none; border-right: 1px solid var(--border); overflow-y: auto; padding: 12px 8px; background: var(--sidebar); }
.sessions .side-row { padding: 8px 10px; align-items: flex-start; }
.sessions .side-row.on { background: var(--sidebar-row-active); box-shadow: 0 0 0 1px var(--border); }
.sessions .side-row .two { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
.transcript-wrap { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.transcript { flex: 1; overflow-y: auto; padding: 20px 28px 12px; display: flex; flex-direction: column; gap: 10px; }
.transcript .tx { max-width: 860px; font-size: 14px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
.transcript .think { max-width: 860px; font-size: 13px; color: var(--muted-foreground); }
.transcript .think summary, .transcript details.tool summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 6px; }
.transcript details > summary::-webkit-details-marker { display: none; }
.transcript details.tool { max-width: 860px; font-size: 13px; color: var(--muted-foreground); }
.transcript details.tool summary .name { color: var(--foreground); font-family: var(--font-mono); font-size: 12px; }
.transcript details.tool pre, .transcript .think pre { margin: 6px 0 0; padding: 10px 12px; background: var(--code-background); border-radius: var(--control-radius); font-family: var(--font-mono); font-size: 12px; white-space: pre-wrap; word-break: break-word; max-height: 360px; overflow: auto; color: var(--foreground); }
.transcript .msg { align-self: flex-end; max-width: 640px; background: var(--accent); border-radius: 14px; padding: 10px 14px; font-size: 14px; white-space: pre-wrap; }
.transcript .msg .who { font-size: 11px; color: var(--muted-foreground); margin-bottom: 2px; font-weight: 600; }
.transcript .status { align-self: center; color: var(--muted-foreground); font-size: 12px; display: flex; align-items: center; gap: 10px; width: 100%; max-width: 860px; }
.transcript .status::before, .transcript .status::after { content: ""; flex: 1; height: 1px; background: var(--border); }
.transcript .logline { font-family: var(--font-mono); font-size: 12px; color: var(--foreground); display: flex; gap: 10px; max-width: 980px; }
.transcript .logline .t { color: var(--muted-foreground); flex: none; }
.transcript .unsigned { font-size: 11px; color: var(--warning-foreground); }
.composer { margin: 0 28px 18px; max-width: 860px; border: 1px solid var(--border); border-radius: 16px; background: var(--card); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; box-shadow: 0 1px 2px rgb(0 0 0 / 4%); }
.composer textarea { border: 0; padding: 4px 2px; min-height: 52px; background: transparent; font-size: 14px; }
.composer textarea:focus { outline: none; }
.composer .bar2 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.composer .bar2 select { height: 28px; font-size: 12px; }
.composer .hint { font-size: 12px; color: var(--muted-foreground); }
.composer.off { background: var(--muted); color: var(--muted-foreground); font-size: 13px; padding: 14px 16px; }
@media (max-width: 760px) { .sessions { display: none; } .transcript { padding: 14px; } .composer { margin: 0 12px 12px; } }
pre.report { white-space: pre-wrap; font-family: var(--font-mono); font-size: 12px; margin: 0; }
/* Form labels with an info icon: hovering or focusing it shows what the field means (#tip). */
.lb { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; }
.ii { display: inline-grid; place-items: center; width: 15px; height: 15px; border-radius: 50%; border: 1px solid var(--muted-foreground); color: var(--muted-foreground); font: italic 600 10px/1 Georgia, serif; cursor: help; flex: none; }
.ii:hover, .ii:focus { background: var(--foreground); color: var(--background); border-color: var(--foreground); outline: none; }
#tip { position: fixed; z-index: 50; max-width: 340px; padding: 10px 12px; border-radius: 8px; background: var(--foreground); color: var(--background); font-size: 12.5px; line-height: 1.45; box-shadow: 0 6px 24px rgba(0,0,0,.18); pointer-events: none; display: none; }
/* The new-campaign page. */
#nc [hidden], #prov-add [hidden], #mcp-add [hidden] { display: none !important; }
.gr { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 9px 14px; border-bottom: 1px solid var(--border); font-size: 13px; cursor: pointer; }
.gr:last-child { border-bottom: 0; } .gr.used { color: var(--muted-foreground); cursor: not-allowed; }
#add-rig [hidden] { display: none !important; }
.dq-sent { display: inline-block; max-width: 380px; font-size: 12px; line-height: 1.45; color: var(--muted-foreground); text-align: right; white-space: normal; }
.dq-sent b { color: var(--foreground); }
/* The live view: every line has its time; tool calls read as commands. */
.lv-head { padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--card); }
.lv-head dl.facts { grid-template-columns: 110px minmax(0, 1fr); gap: 4px 12px; }
.lv-row { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 10px; padding: 3px 0; align-items: baseline; font-size: 13px; line-height: 1.5; }
.lv-t { font: 12px var(--font-mono, ui-monospace, monospace); color: var(--muted-foreground); white-space: nowrap; cursor: default; }
.lv-body { min-width: 0; }
.lv-body details > summary { cursor: pointer; list-style: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lv-body details > summary::-webkit-details-marker { display: none; }
.lv-body details[open] > summary { white-space: normal; }
.lv-body pre { margin: 6px 0 4px; padding: 8px 10px; max-height: 360px; overflow: auto; background: var(--muted); border-radius: 6px; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
.lv-name { display: inline-block; min-width: 62px; font: 600 12px var(--font-mono, ui-monospace, monospace); color: var(--foreground); }
.lv-cmd { font-size: 12px; background: none; padding: 0; }
.lv-res, .lv-hint .lv-res { margin-left: 8px; font-size: 12px; }
.lv-who { display: inline-block; margin-right: 8px; font-size: 11px; color: var(--muted-foreground); }
.lv-think summary { color: var(--muted-foreground); }
.lv-said { white-space: pre-wrap; }
.lv-status span, .lv-log span { color: var(--muted-foreground); }
.lv-unsigned { margin-left: 8px; font-size: 10px; color: var(--warning-foreground); }`;
