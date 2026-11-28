// How a message box formats what the owner types, as Slack's does, and the Markdown it reads and writes (Input
// Markdown). It's ProseMirror. The app's box is built from it, and the app gives it to plugins' boxes through
// `@fxbot/app`, with ProseMirror itself through the page's `require`, so Messages' box and a room's build their
// schemas from these parts, with chips of their own.
//
// The box's text stays the truth: a line is a paragraph, and what's written is standard Markdown, so `*x*` typed as in
// Slack is bold, and written `**x**`, which is what a bot reads. Reading the text back gives the same doc, and writing
// that gives the same text.
import {
  baseKeymap,
  chainCommands,
  lift,
  newlineInCode,
  setBlockType,
  splitBlock,
  toggleMark,
  wrapIn,
} from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  undoInputRule,
  wrappingInputRule,
} from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import {
  Fragment,
  Mark,
  type MarkSpec,
  type MarkType,
  type Node,
  type NodeSpec,
  type NodeType,
  type Schema,
  Slice,
} from "prosemirror-model";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { type Command, type EditorState, Plugin, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

// The schema's parts. A box adds its chips, inline nodes in group "inline", which take any mark but code and link.
export const nodes: Record<string, NodeSpec> = {
  doc: { content: "block+" },
  paragraph: {
    group: "block",
    content: "inline*",
    parseDOM: [{ tag: "p" }],
    toDOM: () => ["p", 0],
  },
  blockquote: {
    group: "block",
    content: "block+",
    defining: true,
    parseDOM: [{ tag: "blockquote" }],
    toDOM: () => ["blockquote", 0],
  },
  code_block: {
    group: "block",
    content: "text*",
    marks: "",
    code: true,
    defining: true,
    attrs: { params: { default: "" } },
    parseDOM: [{ tag: "pre", preserveWhitespace: "full" }],
    toDOM: () => ["pre", ["code", 0]],
  },
  bullet_list: {
    group: "block",
    content: "list_item+",
    parseDOM: [{ tag: "ul" }],
    toDOM: () => ["ul", 0],
  },
  ordered_list: {
    group: "block",
    content: "list_item+",
    attrs: { order: { default: 1 } },
    parseDOM: [
      {
        tag: "ol",
        getAttrs: (dom) => ({ order: Number((dom as HTMLElement).getAttribute("start")) || 1 }),
      },
    ],
    toDOM: (node) => (node.attrs.order === 1 ? ["ol", 0] : ["ol", { start: node.attrs.order }, 0]),
  },
  list_item: {
    content: "paragraph block*",
    defining: true,
    parseDOM: [{ tag: "li" }],
    toDOM: () => ["li", 0],
  },
  text: { group: "inline" },
};
// A link the box keeps: to a site, a mail address, or a place in the app. Any other, such as javascript:, stays text.
const linkable = (href: string) => /^(https?:\/\/|mailto:)/i.test(href) || /^\/(?!\/)/.test(href);
// Underline is left out: Markdown has none.
export const marks: Record<string, MarkSpec> = {
  link: {
    attrs: { href: {} },
    inclusive: false,
    parseDOM: [
      {
        tag: "a[href]",
        getAttrs: (dom) =>
          linkable((dom as HTMLElement).getAttribute("href") ?? "")
            ? { href: (dom as HTMLElement).getAttribute("href") }
            : false,
      },
    ],
    toDOM: (mark) => ["a", { href: mark.attrs.href, title: mark.attrs.href }, 0],
  },
  strong: { parseDOM: [{ tag: "strong" }, { tag: "b" }], toDOM: () => ["strong", 0] },
  em: { parseDOM: [{ tag: "em" }, { tag: "i" }], toDOM: () => ["em", 0] },
  strike: { parseDOM: [{ tag: "s" }, { tag: "del" }], toDOM: () => ["s", 0] },
  code: { code: true, excludes: "_", parseDOM: [{ tag: "code" }], toDOM: () => ["code", 0] },
};
// A chip as a box spells it: its node's name, how it's written, and the pattern that reads it back, a global regex.
export type Chips = {
  type: string;
  write: (node: Node) => string;
  pattern: RegExp;
  read: (match: RegExpExecArray, schema: Schema) => Node | null;
};

const punct = /[\p{P}\p{S}]/u;
const space = /\s/u;
const asciiPunct = /[!-/:-@[-`{-~]/;
const word = /[\p{L}\p{N}]/u;

function reqNode(schema: Schema, name: string): NodeType {
  const type = schema.nodes[name];
  if (!type) throw new Error(`Missing ProseMirror node type: ${name}`);
  return type;
}

function reqMark(schema: Schema, name: string): MarkType {
  const type = schema.marks[name];
  if (!type) throw new Error(`Missing ProseMirror mark type: ${name}`);
  return type;
}

function schemaNodes(schema: Schema) {
  return {
    doc: reqNode(schema, "doc"),
    paragraph: reqNode(schema, "paragraph"),
    blockquote: reqNode(schema, "blockquote"),
    code_block: reqNode(schema, "code_block"),
    bullet_list: reqNode(schema, "bullet_list"),
    ordered_list: reqNode(schema, "ordered_list"),
    list_item: reqNode(schema, "list_item"),
  };
}

function schemaMarks(schema: Schema) {
  return {
    link: reqMark(schema, "link"),
    strong: reqMark(schema, "strong"),
    em: reqMark(schema, "em"),
    strike: reqMark(schema, "strike"),
    code: reqMark(schema, "code"),
  };
}

// Whether a run of *, _, or ~ can open or close, by CommonMark's flanking rules, from the characters around it. The
// start and end of a line count as space. Strikethrough's ~ follows the rules for *.
function flanking(char: string, before: string, after: string) {
  const ws = (c: string) => !c || space.test(c);
  const left = !ws(after) && (!punct.test(after) || ws(before) || punct.test(before));
  const right = !ws(before) && (!punct.test(before) || ws(after) || punct.test(after));
  if (char !== "_") return { open: left, close: right };
  return {
    open: left && (!right || punct.test(before)),
    close: right && (!left || punct.test(after)),
  };
}

// ---- Writing

// What's written, and where each place in the doc lands in it, for the caret's offset as a textarea counts it: a place
// lands after the text before it and before any marker there, so an offset leaves open marks open.
type Written = { text: string; anchors: [number, number][] };
const written = new WeakMap<Node, Map<Chips | undefined, Written>>();
const order = ["link", "strike", "strong", "em"];

function write(doc: Node, chips?: Chips): Written {
  const kept = written.get(doc)?.get(chips);
  if (kept) return kept;
  let text = "";
  const anchors: [number, number][] = [];
  let lines = 0;
  const line = (prefix: string) => {
    if (lines++) text += "\n";
    text += prefix;
  };
  // A block's lines: `first` begins its first line, `rest` each one after. A quote or a list is followed by a blank
  // line before the block after it, which would otherwise read as part of it.
  function blocks(parent: Node, start: number, first: string, rest: string) {
    parent.forEach((child, offset, i) => {
      const pre = i === 0 ? first : rest;
      block(child, start + offset, pre, rest);
      if (
        i < parent.childCount - 1 &&
        /^(bullet_list|ordered_list|blockquote)$/.test(child.type.name)
      )
        line(rest.trimEnd());
    });
  }
  function block(node: Node, pos: number, first: string, rest: string) {
    const name = node.type.name;
    if (name === "paragraph") {
      line(node.content.size ? first : first.trimEnd());
      inline(node, pos + 1);
    } else if (name === "code_block") {
      const code = node.textContent;
      const longest = Math.max(
        2,
        ...[...code.matchAll(/^(`{3,})/gm)].map((m) => (m[1] ?? "").length),
      );
      const fence = "`".repeat(longest + 1);
      line(first + fence + (node.attrs.params ?? ""));
      const parts = code.split("\n");
      let at = pos + 1;
      for (const part of parts) {
        line(part ? rest : rest.trimEnd());
        for (let i = 0; i <= part.length; i++) anchors.push([at + i, text.length + i]);
        text += part;
        at += part.length + 1;
      }
      line(rest + fence);
    } else if (name === "blockquote") {
      blocks(node, pos + 1, `${first}> `, `${rest}> `);
    } else if (name === "bullet_list" || name === "ordered_list") {
      node.forEach((item, offset, i) => {
        const marker = name === "bullet_list" ? "- " : `${(node.attrs.order ?? 1) + i}. `;
        blocks(
          item,
          pos + 1 + offset + 1,
          (i === 0 ? first : rest) + marker,
          rest + " ".repeat(marker.length),
        );
      });
    }
  }
  function inline(block: Node, start: number) {
    const schema = block.type.schema;
    // Each piece: a text, a chip, or a code span, with its marks and where it starts in the doc.
    type Piece = {
      node?: Node;
      text?: string;
      marks: readonly Mark[];
      pos: number;
      code?: Mark;
      flat: number;
    };
    let pieces: Piece[] = [];
    block.forEach((child, offset) => {
      const code = child.marks.find((m) => m.type.spec.code);
      pieces.push({
        node: child.isText ? undefined : child,
        text: child.isText ? child.text : undefined,
        marks: code ? [] : child.marks,
        pos: start + offset,
        code,
        flat: 0,
      });
    });
    // Space at a mark's edge goes outside it: `** x**` isn't bold in Markdown.
    const has = (piece: Piece | undefined, mark: Mark) =>
      Boolean(piece && mark.isInSet(piece.marks));
    const expelled: Piece[] = [];
    pieces.forEach((piece, i) => {
      if (piece.text === undefined || piece.code || !piece.marks.length) {
        expelled.push(piece);
        return;
      }
      const starting = piece.marks.filter((m) => !has(pieces[i - 1], m));
      const ending = piece.marks.filter((m) => !has(pieces[i + 1], m));
      if (!piece.text.trim()) {
        expelled.push({
          ...piece,
          marks: piece.marks.filter((m) => !starting.includes(m) && !ending.includes(m)),
        });
        return;
      }
      const lead = (/^\s*/.exec(piece.text)?.[0] ?? "").length;
      const trail = (/\s*$/.exec(piece.text)?.[0] ?? "").length;
      const from = lead && starting.length ? lead : 0;
      const to = trail && ending.length ? piece.text.length - trail : piece.text.length;
      if (from)
        expelled.push({
          ...piece,
          text: piece.text.slice(0, from),
          marks: piece.marks.filter((m) => !starting.includes(m)),
        });
      if (to > from)
        expelled.push({ ...piece, text: piece.text.slice(from, to), pos: piece.pos + from });
      if (to < piece.text.length && to >= from)
        expelled.push({
          ...piece,
          text: piece.text.slice(to),
          pos: piece.pos + to,
          marks: piece.marks.filter((m) => !ending.includes(m)),
        });
    });
    pieces = expelled;
    // The line as plain text, a chip or code span as one symbol, for what a literal marker would do.
    let flat = "";
    for (const piece of pieces) {
      piece.flat = flat.length;
      flat += piece.text !== undefined && !piece.code ? piece.text : "\ufffc";
    }
    const owner = (i: number) =>
      pieces.find(
        (p) => p.text !== undefined && !p.code && i >= p.flat && i < p.flat + p.text.length,
      );
    const literal = (i: number) => Boolean(owner(i));
    const linked = (p: Piece) => p.marks.some((m) => m.type.name === "link");
    // A line's start that would read as a quote, a list, or a fence.
    const lineStart = (escaped: Set<number>) => {
      if (!pieces[0] || pieces[0].text === undefined || pieces[0].code || pieces[0].marks.length)
        return escaped;
      const begins = flat.replace(/[\s\S]/g, (c, i: number) => (escaped.has(i) ? `\\${c}` : c));
      const list = /^(\d{1,9})[.)](\s|$)/.exec(begins);
      if (/^>/.test(begins) || /^[-+*](\s|$)/.test(begins) || /^(`{3,}|~{3,})/.test(begins))
        escaped.add(0);
      else if (list?.[1]) escaped.add(list[1].length);
      return escaped;
    };
    // The escapes a line needs: only where a marker would otherwise format, so `2 * 3 * 4`, snake_case, and ~/path
    // stay as typed.
    const careful = () => {
      const escaped = new Set<number>();
      const uses = new Set<string>();
      for (const piece of pieces)
        for (const m of piece.marks)
          uses.add(
            m.type.name === "strong"
              ? "*"
              : m.type.name === "strike"
                ? "~"
                : m.type.name === "em"
                  ? "_*"
                  : "",
          );
      const used = [...uses].join("");
      const runs = [...flat.matchAll(/([*_~])\1*/g)]
        .filter((m) => literal(m.index))
        .map((m) => {
          const ch = m[1] ?? "";
          return {
            at: m.index,
            length: m[0].length,
            char: ch,
            ...flanking(ch, flat[m.index - 1] ?? "", flat[m.index + m[0].length] ?? ""),
          };
        });
      runs.forEach((run, i) => {
        const pairs =
          (run.open && runs.slice(i + 1).some((r) => r.char === run.char && r.close)) ||
          (run.close && runs.slice(0, i).some((r) => r.char === run.char && r.open));
        if (pairs || ((run.open || run.close) && used.includes(run.char)))
          for (let k = 0; k < run.length; k++) escaped.add(run.at + k);
      });
      const ticks = [...flat].filter((c, i) => c === "`" && literal(i)).length;
      const code = pieces.some((p) => p.code);
      for (let i = 0; i < flat.length; i++) {
        const piece = owner(i);
        if (!piece) continue;
        const c = flat[i] ?? "";
        if (c === "`" && (code || ticks > 1)) escaped.add(i);
        else if (c === "\\" && (i === flat.length - 1 || asciiPunct.test(flat[i + 1] ?? "")))
          escaped.add(i);
        else if (
          c === "[" &&
          (/^\[[^\]\n]*\]\(/.test(flat.slice(i)) ||
            pieces.some((p) => p.flat > i && (p.node || linked(p))))
        )
          escaped.add(i);
        else if ((c === "[" || c === "]") && linked(piece)) escaped.add(i);
      }
      if (chips)
        for (const m of flat.matchAll(
          new RegExp(
            chips.pattern.source,
            chips.pattern.flags.includes("g") ? chips.pattern.flags : `${chips.pattern.flags}g`,
          ),
        ))
          if (literal(m.index)) escaped.add(m.index);
      return lineStart(escaped);
    };
    // Or every marker, for a line the careful way didn't read back as it is.
    const every = () => {
      const escaped = new Set<number>();
      for (let i = 0; i < flat.length; i++)
        if (literal(i) && /[\\`*_~[\]<]/.test(flat[i] ?? "")) escaped.add(i);
      return lineStart(escaped);
    };
    const render = (escaped: Set<number>) => {
      let out = "";
      const here: [number, number][] = [];
      let stack: Mark[] = [];
      const em = (i: number) => {
        // _ for italics, or * inside a word, where _ doesn't count: by what's written just before, and the text just
        // after, unless another marker comes between.
        let end = i;
        while (end < pieces.length && pieces[end]?.marks.some((m) => m.type.name === "em")) end++;
        const others = (piece: Piece) =>
          piece.marks.filter((m) => m.type.name !== "em" && order.includes(m.type.name));
        const next = pieces[end];
        const prevPiece = pieces[end - 1];
        const plainAfter =
          next &&
          prevPiece &&
          !next.code &&
          next.text !== undefined &&
          Mark.sameSet(others(next), others(prevPiece));
        return word.test(out.at(-1) ?? text.at(-1) ?? "") ||
          (plainAfter && word.test(next.text?.[0] ?? ""))
          ? "*"
          : "_";
      };
      const delims = new Map<Mark, string>();
      const open = (mark: Mark, i: number) => {
        const d =
          mark.type.name === "strong"
            ? "**"
            : mark.type.name === "strike"
              ? "~~"
              : mark.type.name === "em"
                ? em(i)
                : "[";
        delims.set(mark, d);
        out += d;
      };
      const close = (mark: Mark) => {
        if (mark.type.name === "link")
          out += `](${String(mark.attrs.href).replace(/[ ()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)})`;
        else out += delims.get(mark) ?? "";
      };
      // How far a mark goes from a piece, so the one that lasts longer opens first, outside.
      const reach = (mark: Mark, i: number) => {
        let end = i;
        while (end < pieces.length && mark.isInSet(pieces[end]?.marks ?? [])) end++;
        return end;
      };
      pieces.forEach((piece, i) => {
        const mine = piece.marks.filter((m) => order.includes(m.type.name));
        // The marks open that go on stay open; the rest close, inner first, and what's new opens.
        let keep = 0;
        while (keep < stack.length && stack[keep]?.isInSet(mine)) keep++;
        here.push([piece.pos, out.length]);
        for (const mark of stack.slice(keep).reverse()) close(mark);
        const kept = stack.slice(0, keep);
        const opening = mine
          .filter((m) => !m.isInSet(kept))
          .sort(
            (a, b) =>
              reach(b, i) - reach(a, i) || order.indexOf(a.type.name) - order.indexOf(b.type.name),
          );
        for (const mark of opening) open(mark, i);
        stack = [...kept, ...opening];
        if (piece.code) {
          const content = piece.text ?? "";
          const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
          const fence = "`".repeat(longest + 1);
          const pad =
            /^`|`$/.test(content) || (/^ .* $/.test(content) && content.trim()) ? " " : "";
          out += fence + pad;
          for (let k = 1; k < content.length; k++) here.push([piece.pos + k, out.length + k]);
          out += content + pad + fence;
        } else if (piece.text !== undefined) {
          for (let k = 0; k < piece.text.length; k++) {
            if (k) here.push([piece.pos + k, out.length]);
            out += escaped.has(piece.flat + k) ? `\\${piece.text[k]}` : piece.text[k];
          }
        } else if (piece.node) {
          out += chips && piece.node.type.name === chips.type ? chips.write(piece.node) : "";
        }
      });
      here.push([start + block.content.size, out.length]);
      for (const mark of stack.reverse()) close(mark);
      return { out, here };
    };
    // The line must read back as it is. A mix of markers the careful way gets wrong is written with every one escaped.
    const want = Fragment.fromArray(
      pieces.map((p) =>
        p.code
          ? schema.text(p.text!, [p.code])
          : p.text !== undefined
            ? schema.text(p.text, p.marks)
            : p.node!.mark(p.marks),
      ),
    );
    const same = (out: string) => Fragment.fromArray(readInline(out, schema, chips)).eq(want);
    let done = render(careful());
    if (!same(done.out)) {
      const again = render(every());
      if (same(again.out)) done = again;
    }
    for (const [pos, at] of done.here) anchors.push([pos, text.length + at]);
    text += done.out;
  }
  blocks(doc, 0, "", "");
  const out = { text, anchors: anchors.sort((a, b) => a[0] - b[0] || a[1] - b[1]) };
  if (!written.has(doc)) written.set(doc, new Map());
  written.get(doc)!.set(chips, out);
  return out;
}

export const toMarkdown = (doc: Node, chips?: Chips) => write(doc, chips).text;
// Where a place in the doc is in its text, as a textarea's selectionStart counts it, and back.
export function offsetOf(doc: Node, pos: number, chips?: Chips) {
  const { anchors } = write(doc, chips);
  let found = 0;
  for (const [at, offset] of anchors) {
    if (at > pos) break;
    found = offset;
  }
  return found;
}
export function posOf(doc: Node, offset: number, chips?: Chips) {
  const { anchors } = write(doc, chips);
  // The first place at or after the offset, so one inside a chip's text or a marker goes after it.
  const hit = anchors.find(([, at]) => at >= offset) ?? anchors.at(-1);
  return hit ? hit[0] : 1;
}

// ---- Reading

// The Markdown a box writes, and the same subset of what an owner types: fences, quotes, lists, and in a line, code
// spans, links, the box's chips, **, __, *, _, ~~, and ~, and escapes. Anything else stays text.
export function fromMarkdown(text: string, schema: Schema, chips?: Chips): Node {
  const n = schemaNodes(schema);
  try {
    const doc = n.doc.create(null, readBlocks(text.split("\n"), schema, chips));
    doc.check();
    return doc;
  } catch {
    // A text it can't build stays as lines of text.
    return n.doc.create(
      null,
      text.split("\n").map((line) => n.paragraph.create(null, line ? schema.text(line) : null)),
    );
  }
}

function readBlocks(lines: string[], schema: Schema, chips?: Chips): Node[] {
  const n = schemaNodes(schema);
  const out: Node[] = [];
  // The blank line a quote or a list is written with before the block after it.
  const gap = (i: number) => (lines[i] === "" && i + 1 < lines.length ? i + 1 : i);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fence = /^(`{3,}|~{3,})(.*)$/.exec(line);
    const fenceRun = fence?.[1];
    const fenceInfo = fence?.[2] ?? "";
    if (fence && fenceRun && !(fenceRun[0] === "`" && fenceInfo.includes("`"))) {
      const closing = new RegExp(`^${fenceRun[0]}{${fenceRun.length},}\\s*$`);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const cur = lines[j] ?? "";
        if (closing.test(cur)) break;
        body.push(cur);
        j++;
      }
      const code = body.join("\n");
      out.push(n.code_block.create({ params: fenceInfo.trim() }, code ? schema.text(code) : null));
      i = j + 1;
      continue;
    }
    if (line.startsWith(">")) {
      const inner: string[] = [];
      while (i < lines.length) {
        const cur = lines[i] ?? "";
        if (!cur.startsWith(">")) break;
        inner.push(cur.replace(/^> ?/, ""));
        i++;
      }
      out.push(n.blockquote.create(null, readBlocks(inner, schema, chips)));
      i = gap(i);
      continue;
    }
    const marker = /^([-+*]|(\d{1,9})[.)])( |$)/.exec(line);
    if (marker) {
      const ordered = marker[2] !== undefined;
      const items: Node[] = [];
      let m: RegExpExecArray | null = marker;
      while (m && (m[2] !== undefined) === ordered) {
        const width = (m[1] ?? "").length + 1;
        const body = [(lines[i] ?? "").slice(m[0].length)];
        let j = i + 1;
        const inside = (l: string | undefined) =>
          l !== undefined && l.length > 0 && l.startsWith(" ".repeat(width));
        while (
          j < lines.length &&
          (inside(lines[j]) || (lines[j] === "" && inside(lines[j + 1])))
        ) {
          body.push((lines[j] ?? "").slice(width));
          j++;
        }
        const content = readBlocks(body, schema, chips);
        if (content[0]?.type !== n.paragraph) content.unshift(n.paragraph.create());
        items.push(n.list_item.create(null, content));
        i = j;
        m = i < lines.length ? /^([-+*]|(\d{1,9})[.)])( |$)/.exec(lines[i] ?? "") : null;
      }
      out.push(
        ordered
          ? n.ordered_list.create({ order: Number(marker[2]) }, items)
          : n.bullet_list.create(null, items),
      );
      i = gap(i);
      continue;
    }
    out.push(n.paragraph.create(null, readInline(line, schema, chips)));
    i++;
  }
  return out;
}

// A text takes any mark its paragraph does, and a chip the marks its spec names.
const allows = (node: Node, type: MarkType) => node.isText || node.type.allowsMarkType(type);

type Token = { text: string } | { node: Node; nodes?: undefined } | { nodes: Node[] } | Delim;
type Delim = {
  char: string;
  length: number;
  size: number;
  open: boolean;
  close: boolean;
  dead?: boolean;
  opens: MarkType[];
  closes: MarkType[];
};

function readInline(text: string, schema: Schema, chips?: Chips): Node[] {
  const m = schemaMarks(schema);
  const tokens: Token[] = [];
  const chip = chips
    ? new RegExp(chips.pattern.source, `${chips.pattern.flags.replace("g", "")}y`)
    : null;
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? "";
    const nextChar = text[i + 1];
    if (c === "\\" && nextChar !== undefined && asciiPunct.test(nextChar)) {
      tokens.push({ text: nextChar });
      i += 2;
      continue;
    }
    if (chip && chips) {
      chip.lastIndex = i;
      const found = chip.exec(text);
      const node = found && chips.read(found, schema);
      if (found && node) {
        tokens.push({ node });
        i += found[0].length;
        continue;
      }
    }
    if (c === "`") {
      const run = /^`+/.exec(text.slice(i))?.[0] ?? "`";
      const close = new RegExp(`(?<!\`)${run}(?!\`)`, "g");
      close.lastIndex = i + run.length;
      const end = close.exec(text);
      if (end) {
        let code = text.slice(i + run.length, end.index);
        if (/^ [\s\S]* $/.test(code) && code.trim()) code = code.slice(1, -1);
        if (code) tokens.push({ node: schema.text(code, [m.code.create()]) });
        i = end.index + run.length;
        continue;
      }
      tokens.push({ text: run });
      i += run.length;
      continue;
    }
    if (c === "[") {
      const link = /^\[((?:\\.|[^\\\]\n])*)\]\((<[^>\n]*>|[^\s)]+)\)/.exec(text.slice(i));
      const rawHref = link?.[2] ?? "";
      const href = rawHref.startsWith("<") ? rawHref.slice(1, -1) : rawHref;
      const label = link?.[1] ?? "";
      if (link && label && linkable(href)) {
        const mark = m.link.create({ href });
        tokens.push({
          nodes: readInline(label, schema, chips).map((node) =>
            allows(node, m.link) ? node.mark(mark.addToSet(node.marks)) : node,
          ),
        });
        i += link[0].length;
        continue;
      }
    }
    if (c === "*" || c === "_" || c === "~") {
      const run = new RegExp(`^\\${c}+`).exec(text.slice(i))?.[0] ?? c;
      const { open, close } = flanking(c, text[i - 1] ?? "", text[i + run.length] ?? "");
      tokens.push({
        char: c,
        length: run.length,
        size: run.length,
        open,
        close,
        opens: [],
        closes: [],
      });
      i += run.length;
      continue;
    }
    const last = tokens.at(-1);
    if (last && "text" in last) last.text += c;
    else tokens.push({ text: c });
    i++;
  }
  // Pairs, by CommonMark's rules for emphasis, and GFM's for strikethrough: the same length, one or two.
  const delims = tokens.filter((t): t is Delim => "char" in t);
  delims.forEach((closer, c) => {
    if (!closer.close) return;
    while (closer.length > 0) {
      let o = c - 1;
      for (; o >= 0; o--) {
        const op = delims[o];
        if (!op || op.char !== closer.char || !op.open || !op.length || op.dead) continue;
        if (
          op.char === "~"
            ? op.length !== closer.length || op.length > 2
            : (op.close || closer.open) &&
              (op.size + closer.size) % 3 === 0 &&
              !(op.size % 3 === 0 && closer.size % 3 === 0)
        )
          continue;
        break;
      }
      if (o < 0) break;
      const op = delims[o];
      if (!op) break;
      const use =
        closer.char === "~" ? closer.length : op.length >= 2 && closer.length >= 2 ? 2 : 1;
      const type = closer.char === "~" ? m.strike : use === 2 ? m.strong : m.em;
      op.length -= use;
      closer.length -= use;
      op.opens.push(type);
      closer.closes.push(type);
      for (let k = o + 1; k < c; k++) {
        const inner = delims[k];
        if (inner) inner.dead = true;
      }
    }
    if (closer.length && !closer.open) closer.dead = true;
  });
  // Then the nodes, each with the marks open where it is.
  const out: Node[] = [];
  const active = new Map<MarkType, number>();
  const marksNow = () =>
    [...active].filter(([, count]) => count > 0).map(([type]) => type.create());
  const add = (node: Node) => {
    const marks = marksNow().filter((mark) => allows(node, mark.type));
    const marked = node.mark(marks.reduce((set, mark) => mark.addToSet(set), node.marks));
    const prev = out.at(-1);
    if (prev?.isText && marked.isText && prev.sameMarkup(marked)) {
      out[out.length - 1] = schema.text((prev.text ?? "") + (marked.text ?? ""), prev.marks);
    } else out.push(marked);
  };
  for (const token of tokens) {
    if ("char" in token) {
      for (const type of token.closes) active.set(type, (active.get(type) ?? 1) - 1);
      if (token.length) add(schema.text(token.char.repeat(token.length)));
      for (const type of token.opens) active.set(type, (active.get(type) ?? 0) + 1);
    } else if ("text" in token) {
      if (token.text) add(schema.text(token.text));
    } else if (token.nodes) token.nodes.forEach(add);
    else add(token.node);
  }
  return out;
}

// ---- Typing

const inCode = (state: EditorState) => Boolean(state.selection.$from.parent.type.spec.code);
// A box's own Enter in a code block, which starts a line there. The box asks before handing Enter to the app, which
// sends with it.
export const ownsKey = (state: EditorState, event: KeyboardEvent) =>
  event.key === "Enter" &&
  !event.shiftKey &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.altKey &&
  !event.isComposing &&
  inCode(state);
export const isEmpty = (doc: Node) =>
  doc.childCount === 1 &&
  Boolean(doc.firstChild?.isTextblock) &&
  (doc.firstChild?.content.size ?? 0) === 0;

// A mark typed Slack's way, `*x*`, at a word's edge, so `2 * 3 * 4` and snake_case stay as typed.
function markRule(char: string, type: MarkType, double: boolean) {
  // Only *, of these, is escaped: a needless escape is an error in a Unicode pattern.
  const c = char === "*" ? "\\*" : char;
  const delim = double ? `(${c}${c}|${c})` : `(${c})`;
  const pattern = new RegExp(
    `(^|(?!${c})[\\s\\p{P}\\p{S}])${delim}(?![\\s${c}])([^${c}]*?[^\\s${c}])${double ? "\\2" : c}$`,
    "u",
  );
  return new InputRule(
    pattern,
    (state, match, start, end) => {
      const lead = match[1] ?? "";
      const open = match[2] ?? "";
      const content = match[3] ?? "";
      const from = start + lead.length;
      const to = from + open.length + content.length;
      const tr = state.tr.delete(to, end).delete(from, from + open.length);
      return tr.addMark(from, from + content.length, type.create()).removeStoredMark(type);
    },
    { inCodeMark: false },
  );
}

function rules(schema: Schema) {
  const n = schemaNodes(schema);
  const m = schemaMarks(schema);
  return inputRules({
    rules: [
      wrappingInputRule(/^>\s$/, n.blockquote),
      wrappingInputRule(/^([-+*•])\s$/, n.bullet_list),
      wrappingInputRule(
        /^(\d{1,9})\.\s$/,
        n.ordered_list,
        (match) => ({ order: Number(match[1]) }),
        (match, node) => node.childCount + node.attrs.order === Number(match[1]),
      ),
      textblockTypeInputRule(/^```$/, n.code_block),
      markRule("*", m.strong, true),
      markRule("_", m.em, false),
      markRule("~", m.strike, true),
      new InputRule(
        /(^|(?!`)[\s\p{P}\p{S}])`([^`]+)`$/u,
        (state, match, start, end) => {
          const lead = match[1] ?? "";
          const content = match[2] ?? "";
          const from = start + lead.length;
          const tr = state.tr.delete(from + 1 + content.length, end).delete(from, from + 1);
          return tr.addMark(from, from + content.length, m.code.create()).removeStoredMark(m.code);
        },
        { inCodeMark: false },
      ),
      new InputRule(
        /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)$/,
        (state, match, start, end) => {
          const label = match[1] ?? "";
          const href = match[2] ?? "";
          const tr = state.tr.delete(start + 1 + label.length, end).delete(start, start + 1);
          return tr
            .addMark(start, start + label.length, m.link.create({ href }))
            .removeStoredMark(m.link);
        },
        { inCodeMark: false },
      ),
    ],
  });
}

// The block the caret is in: a quote or a list item, the nearer.
function container(state: EditorState) {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if (name === "list_item" || name === "blockquote") return { name, depth: d };
  }
  return null;
}

function keys(schema: Schema): Record<string, Command> {
  const n = schemaNodes(schema);
  const m = schemaMarks(schema);
  // In a code block, a line, and on its empty last line, out of it. Elsewhere, the next item or line in a list or a
  // quote, and out of it from an empty one.
  const code: Command = (state, dispatch) => {
    const { $head } = state.selection;
    const block = $head.parent;
    if (!block.type.spec.code) return false;
    if (!block.content.size) return setBlockType(n.paragraph)(state, dispatch);
    if ($head.parentOffset === block.content.size && block.textContent.endsWith("\n")) {
      if (dispatch) {
        const tr = state.tr.delete($head.pos - 1, $head.pos);
        const after = tr.mapping.map($head.after());
        tr.insert(after, n.paragraph.create());
        dispatch(tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView());
      }
      return true;
    }
    return newlineInCode(state, dispatch);
  };
  const next: Command = (state, dispatch, view) => {
    const at = container(state);
    if (at?.name === "list_item")
      return chainCommands(splitListItem(n.list_item), liftListItem(n.list_item))(
        state,
        dispatch,
        view,
      );
    if (at?.name === "blockquote") {
      const { $from } = state.selection;
      if (
        !$from.parent.content.size &&
        $from.index(at.depth) === $from.node(at.depth).childCount - 1
      )
        return lift(state, dispatch);
    }
    return splitBlock(state, dispatch);
  };
  const block =
    (type: NodeType): Command =>
    (state, dispatch) =>
      state.selection.$from.parent.type === type
        ? setBlockType(n.paragraph)(state, dispatch)
        : setBlockType(type)(state, dispatch);
  const quote: Command = (state, dispatch) => {
    const { $from } = state.selection;
    for (let d = $from.depth; d > 0; d--)
      if ($from.node(d).type === n.blockquote) return lift(state, dispatch);
    return wrapIn(n.blockquote)(state, dispatch);
  };
  const list =
    (type: NodeType): Command =>
    (state, dispatch, view) => {
      const { $from } = state.selection;
      for (let d = $from.depth; d > 0; d--) {
        const node = $from.node(d);
        if (node.type === type) return liftListItem(n.list_item)(state, dispatch, view);
        if (node.type === n.bullet_list || node.type === n.ordered_list) {
          if (dispatch)
            dispatch(
              state.tr.setNodeMarkup(
                $from.before(d),
                type,
                type === n.ordered_list ? { order: 1 } : null,
              ),
            );
          return true;
        }
      }
      return wrapInList(type)(state, dispatch, view);
    };
  return {
    "Mod-z": undo,
    "Shift-Mod-z": redo,
    "Mod-y": redo,
    "Mod-b": toggleMark(m.strong),
    "Mod-i": toggleMark(m.em),
    "Mod-Shift-x": toggleMark(m.strike),
    "Mod-Shift-c": toggleMark(m.code),
    "Mod-Alt-Shift-c": block(n.code_block),
    "Mod-Shift-9": quote,
    "Mod-Shift-8": list(n.bullet_list),
    "Mod-Shift-7": list(n.ordered_list),
    // The format bar's address field, which listens for this.
    "Mod-Shift-u": (_state, _dispatch, view) => {
      view?.dom.dispatchEvent(new CustomEvent("fx-format-link", { bubbles: true }));
      return true;
    },
    "Mod-Shift-v": () => {
      plain = true;
      return false;
    },
    Tab: sinkListItem(n.list_item),
    "Shift-Tab": liftListItem(n.list_item),
    Enter: chainCommands(code, next),
    "Shift-Enter": chainCommands(
      (state, dispatch) => inCode(state) && newlineInCode(state, dispatch),
      next,
    ),
    Backspace: undoInputRule,
  };
}

// The commands the format bar runs, and what it shows pressed.
export function commands(schema: Schema) {
  const all = keys(schema);
  return {
    strong: all["Mod-b"],
    em: all["Mod-i"],
    strike: all["Mod-Shift-x"],
    code: all["Mod-Shift-c"],
    code_block: all["Mod-Alt-Shift-c"],
    blockquote: all["Mod-Shift-9"],
    bullet_list: all["Mod-Shift-8"],
    ordered_list: all["Mod-Shift-7"],
  };
}
export function active(state: EditorState, name: string) {
  const { $from, from, to, empty } = state.selection;
  const mark = state.schema.marks[name];
  if (mark)
    return empty
      ? Boolean(mark.isInSet(state.storedMarks ?? $from.marks()))
      : state.doc.rangeHasMark(from, to, mark);
  for (let d = $from.depth; d >= 0; d--) if ($from.node(d).type.name === name) return true;
  return false;
}
// The link where the caret is, or the address put on the selection, or written in at the caret. An empty one takes
// the link off.
export function setLink(view: EditorView, href: string) {
  const { state } = view;
  const type = reqMark(state.schema, "link");
  let { from, to } = state.selection;
  const $pos = state.doc.resolve(from);
  const mark = from === to && type.isInSet($pos.marks());
  if (mark) {
    // The whole link the caret is in.
    const runs: [number, number][] = [];
    $pos.parent.forEach((child, offset) => {
      const at = $pos.start() + offset;
      if (!mark.isInSet(child.marks)) return;
      const last = runs.at(-1);
      if (last && last[1] === at) last[1] = at + child.nodeSize;
      else runs.push([at, at + child.nodeSize]);
    });
    const hit = runs.find(([a, b]) => a <= from && from <= b);
    if (hit) [from, to] = hit;
  }
  const tr = state.tr;
  if (!href) tr.removeMark(from, to, type);
  else if (from === to) tr.insert(from, state.schema.text(href, [type.create({ href })]));
  else tr.addMark(from, to, type.create({ href }));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}
export const linkAt = (state: EditorState) =>
  (reqMark(state.schema, "link").isInSet(state.selection.$from.marks())?.attrs.href as
    | string
    | undefined) ?? "";

// ---- Pasting

// Cmd or Ctrl+Shift+V pastes the next text as it is.
let plain = false;
function paste(schema: Schema, chips?: Chips) {
  const n = schemaNodes(schema);
  const m = schemaMarks(schema);
  return new Plugin({
    props: {
      handlePaste(view, event) {
        const asIs = plain;
        plain = false;
        const text = event.clipboardData?.getData("text/plain") ?? "";
        // A copy from a box keeps what ProseMirror copied, and a code block takes text as it is.
        if (
          !text ||
          (event.clipboardData?.getData("text/html") ?? "").includes("data-pm-slice") ||
          inCode(view.state)
        )
          return false;
        const { state } = view;
        const address = text.trim();
        if (!state.selection.empty && /^(https?:\/\/|mailto:)\S+$/.test(address)) {
          view.dispatch(
            state.tr.addMark(
              state.selection.from,
              state.selection.to,
              m.link.create({ href: address }),
            ),
          );
          return true;
        }
        const lines = text.replace(/\r\n?/g, "\n").split("\n");
        const plainly = () =>
          n.doc.create(
            null,
            lines.map((line) => n.paragraph.create(null, line ? schema.text(line) : null)),
          );
        // Markdown becomes formatting only when it writes back as the very text pasted. Anything else, such as code with
        // foo/__init__.py, which Markdown reads as bold, goes in as it is, as if typed.
        const read = asIs ? null : fromMarkdown(lines.join("\n"), schema, chips);
        const doc = read && toMarkdown(read, chips) === lines.join("\n") ? read : plainly();
        view.dispatch(
          state.tr
            .replaceSelection(Slice.maxOpen(doc.content))
            .scrollIntoView()
            .setMeta("uiEvent", "paste"),
        );
        return true;
      },
    },
  });
}

// ---- The boxes there are

// Each view built with these plugins, for the format bar, which finds the box it's beside.
const views = new Set<EditorView>();
const listeners = new Set<() => void>();
let version = 0;
const ping = () => {
  version += 1;
  for (const listener of listeners) listener();
};
export const watch = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const seen = () => version;
export const viewIn = (element: Element | null | undefined) =>
  [...views].find((view) => element?.contains(view.dom));
const registry = new Plugin({
  view(view) {
    views.add(view);
    ping();
    return {
      update: ping,
      destroy: () => {
        views.delete(view);
        ping();
      },
    };
  },
});

// Everything a box needs from here, after its own keys: the typed rules, the keys, undo, pasting, the registry, and
// ProseMirror's own keys.
export function plugins(schema: Schema, chips?: Chips): Plugin[] {
  return [
    rules(schema),
    keymap(keys(schema)),
    history(),
    paste(schema, chips),
    registry,
    keymap(baseKeymap),
  ];
}
