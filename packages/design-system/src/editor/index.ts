import * as commands from "prosemirror-commands";
import * as historyModule from "prosemirror-history";
import * as inputrules from "prosemirror-inputrules";
import * as keymap from "prosemirror-keymap";
import * as model from "prosemirror-model";
import * as schemaList from "prosemirror-schema-list";
import * as state from "prosemirror-state";
import * as transform from "prosemirror-transform";
import * as view from "prosemirror-view";
import * as formatting from "./formatting.ts";

/** Shared ProseMirror runtime modules map for plugin bridges sharing one ProseMirror copy. */
export const prosemirrorModules: Record<string, unknown> = {
  "prosemirror-commands": commands,
  "prosemirror-history": historyModule,
  "prosemirror-inputrules": inputrules,
  "prosemirror-keymap": keymap,
  "prosemirror-model": model,
  "prosemirror-schema-list": schemaList,
  "prosemirror-state": state,
  "prosemirror-transform": transform,
  "prosemirror-view": view,
};

export { Editor, type EditorProps } from "./editor.tsx";
export { FormatBar, FormatButton } from "./format-bar.tsx";
export { formatting };
