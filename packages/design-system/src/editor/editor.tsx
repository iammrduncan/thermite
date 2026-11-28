import { Schema } from "prosemirror-model";
import { EditorState, Selection, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { type ComponentProps, type RefObject, useLayoutEffect, useRef, useState } from "react";
import * as formatting from "./formatting.ts";

const schema = new Schema({ nodes: formatting.nodes, marks: formatting.marks });

function stateOf(text: string) {
  const doc = formatting.fromMarkdown(text, schema);
  return EditorState.create({
    schema,
    doc,
    selection: Selection.atEnd(doc),
    plugins: formatting.plugins(schema),
  });
}

type EditorChangeEvent = {
  target: { value: string; selectionStart: number };
};

export interface EditorProps
  extends Omit<
    ComponentProps<"textarea">,
    "ref" | "onChange" | "onKeyDown" | "onPaste" | "onFocus" | "onBlur"
  > {
  ref?: RefObject<HTMLElement | null>;
  onChange?: (event: EditorChangeEvent) => void;
  onKeyDown?: (event: KeyboardEvent & { nativeEvent?: KeyboardEvent }) => void;
  onPaste?: (event: ClipboardEvent) => void;
  onFocus?: (event: FocusEvent) => void;
  onBlur?: (event: FocusEvent) => void;
}

/**
 * ProseMirror Input Markdown composer that behaves like a controlled textarea (`value`, `onChange`,
 * `selectionStart`, `setSelectionRange`) while rendering Slack-style live Markdown formatting.
 */
export function Editor({
  value,
  onChange,
  onKeyDown,
  onPaste,
  onFocus,
  onBlur,
  placeholder,
  disabled,
  className,
  ref,
  rows: _rows,
  ...aria
}: EditorProps) {
  const mount = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const text = String(value ?? "");
  const [empty, setEmpty] = useState(!text);

  const latest = useRef({ onChange, onKeyDown, onPaste, onFocus, onBlur });
  latest.current = { onChange, onKeyDown, onPaste, onFocus, onBlur };

  // biome-ignore lint/correctness/useExhaustiveDependencies: ProseMirror view mounts once and syncs controlled text in the next effect
  useLayoutEffect(() => {
    const v: EditorView = new EditorView(mount.current, {
      state: stateOf(text),
      handleKeyDown(editorView, event) {
        if (formatting.ownsKey(editorView.state, event)) return false;
        const augmented = event as KeyboardEvent & { nativeEvent?: KeyboardEvent };
        augmented.nativeEvent = event;
        latest.current.onKeyDown?.(augmented);
        return event.defaultPrevented;
      },
      handlePaste(_editorView, event) {
        latest.current.onPaste?.(event);
        return event.defaultPrevented;
      },
      handleDOMEvents: {
        focus: (_editorView, event) => {
          latest.current.onFocus?.(event);
          return false;
        },
        blur: (_editorView, event) => {
          latest.current.onBlur?.(event);
          return false;
        },
      },
      dispatchTransaction(tr) {
        v.updateState(v.state.apply(tr));
        setEmpty(formatting.isEmpty(v.state.doc));
        if (tr.docChanged) {
          latest.current.onChange?.({
            target: {
              value: formatting.toMarkdown(v.state.doc),
              selectionStart: formatting.offsetOf(v.state.doc, v.state.selection.from),
            },
          });
        }
      },
    });
    view.current = v;
    Object.defineProperty(v.dom, "selectionStart", {
      get: () => formatting.offsetOf(v.state.doc, v.state.selection.from),
    });
    Object.defineProperty(v.dom, "value", {
      get: () => formatting.toMarkdown(v.state.doc),
    });
    Object.assign(v.dom, {
      setSelectionRange: (at: number) =>
        v.dispatch(
          v.state.tr.setSelection(
            TextSelection.near(v.state.doc.resolve(formatting.posOf(v.state.doc, at))),
          ),
        ),
    });
    if (ref) ref.current = v.dom;
    return () => {
      if (ref) ref.current = null;
      view.current = null;
      v.destroy();
    };
  }, []);

  useLayoutEffect(() => {
    const v = view.current;
    if (!v || text === formatting.toMarkdown(v.state.doc)) return;
    v.updateState(stateOf(text));
    setEmpty(formatting.isEmpty(v.state.doc));
  }, [text]);

  useLayoutEffect(() => {
    const attributes: Record<string, string> = {
      "aria-multiline": "true",
      "data-slot": "input-group-control",
      autocorrect: "on",
      autocapitalize: "sentences",
      spellcheck: "true",
      class: `fx-editor fx-formatted ${className ?? ""}`,
    };
    for (const [name, attrVal] of Object.entries(aria)) {
      if (attrVal !== undefined && (name.startsWith("aria-") || name === "role")) {
        attributes[name] = String(attrVal);
      }
    }
    view.current?.setProps({ attributes, editable: () => !disabled });
  });

  return (
    <div className="relative min-w-0 flex-1">
      <div ref={mount} />
      {empty && (
        <span
          className="pointer-events-none absolute inset-x-2.5 top-3 truncate text-base text-muted-foreground md:text-sm"
          aria-hidden="true"
        >
          {placeholder}
        </span>
      )}
    </div>
  );
}
