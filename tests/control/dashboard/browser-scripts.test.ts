import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, test } from "node:test";
import { Script } from "node:vm";
import { controlOnly, signIn } from "../../helpers/control-stack.ts";

/**
 * The dashboard's browser scripts (CONVENTIONS.md, "The dashboard"): each is a string in its page
 * module, served from control at /ui/assets/<name>.js, and no page runs an inline script. Every
 * script control serves parses as JavaScript; every page's script tag names one control serves;
 * and a server constant goes into a script only through JSON.stringify.
 */

const ROOT = join(import.meta.dirname, "../../..");
/** Where the pages and their scripts live. */
const PAGE_DIRS = ["src/control/ui", "src/control/dashboard"];
const ASSET = /^\/ui\/assets\/[\w.-]+\.js$/;

/** Every TypeScript file under the page folders, with its path from the repository's root. */
function pageSources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(".ts"))
        out.push({ file: relative(ROOT, path), text: readFileSync(path, "utf8") });
    }
  };
  for (const dir of PAGE_DIRS) visit(join(ROOT, dir));
  return out;
}

/** The end of the string or template literal that opens at `start` (its quote), past its quote. */
function literalEnd(text: string, start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === quote) return i + 1;
    else if (quote === "`" && c === "$" && text[i + 1] === "{") i = expressionEnd(text, i + 2) - 1;
  }
  throw new Error(`a literal at ${start} has no end`);
}

/** The end of a template's `${…}` whose expression starts at `start`: just past its `}`. */
function expressionEnd(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") i = literalEnd(text, i) - 1;
    else if (c === "{") depth++;
    else if (c === "}") {
      if (depth === 0) return i + 1;
      depth--;
    }
  }
  throw new Error(`an expression at ${start} has no end`);
}

/** Each browser script constant (`NAME_JS = \`…\``) of a source, with what goes into it. */
function browserScripts(text: string): { name: string; line: number; parts: string[] }[] {
  const out: { name: string; line: number; parts: string[] }[] = [];
  for (const m of text.matchAll(/\bconst ([A-Z][A-Z0-9_]*_JS) = (?:String\.raw)?`/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const parts: string[] = [];
    const end = literalEnd(text, open);
    for (let i = open + 1; i < end - 1; i++) {
      if (text[i] === "\\") i++;
      else if (text[i] === "$" && text[i + 1] === "{") {
        const close = expressionEnd(text, i + 2);
        parts.push(text.slice(i + 2, close - 1).trim());
        i = close - 1;
      }
    }
    out.push({ name: m[1] as string, line: text.slice(0, m.index).split("\n").length, parts });
  }
  return out;
}

/**
 * What may go into a browser script: a server constant through JSON.stringify, another browser
 * script, or a function's own source (`fn.toString()`), which the page runs as the server does.
 */
const SAFE_PART = [
  /^JSON\.stringify\([\s\S]*\)$/,
  /^[A-Z][A-Z0-9_]*_JS$/,
  /^[A-Za-z_$][\w$]*\.toString\(\)$/,
];

/** The scripts control serves, by their routes. */
function servedScripts(control: ReturnType<typeof controlOnly>["control"]): string[] {
  const paths = control.routes.filter((r) => r.method === "GET" && ASSET.test(r.path));
  return [...new Set(paths.map((r) => r.path))].sort();
}

describe("the dashboard's browser scripts", () => {
  test("every script control serves parses as JavaScript", async () => {
    const { control } = controlOnly();
    const { get } = await signIn(control);
    const served = servedScripts(control);
    assert.ok(served.length >= 10, `served scripts: ${served.join(", ")}`);
    for (const path of served) {
      const res = await get(path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type") ?? "", /^text\/javascript\b/, path);
      const js = await res.text();
      assert.ok(js.length > 0, path);
      assert.doesNotThrow(() => new Script(js, { filename: path }), path);
    }
  });

  test("the pages' script tags name the scripts control serves, and no page has an inline script", () => {
    const named = new Set<string>();
    for (const { file, text } of pageSources())
      for (const m of text.matchAll(/<script\b[^>]*>/g)) {
        const src = /\ssrc="([^"]+)"/.exec(m[0])?.[1];
        assert.ok(src, `${file}: an inline script: ${m[0]}`);
        named.add(src);
      }
    // Each tag names a script control serves, and control serves no script that no page loads.
    assert.deepEqual([...named].sort(), servedScripts(controlOnly().control));
  });

  test("a server constant goes into a browser script only through JSON.stringify", () => {
    const found: string[] = [];
    const unsafe: string[] = [];
    for (const { file, text } of pageSources())
      for (const script of browserScripts(text)) {
        found.push(script.name);
        for (const part of script.parts)
          if (!SAFE_PART.some((rx) => rx.test(part)))
            unsafe.push(`${file}:${script.line} ${script.name}: \${${part}}`);
      }
    assert.ok(found.length >= 20, `browser scripts: ${found.join(", ")}`);
    assert.deepEqual(unsafe, [], "inject server constants with JSON.stringify");
  });

  test("the check reads a script's parts, nested literals and escapes included", () => {
    // Written with "$[" for a template's "${", so that no string of this test looks like one.
    const code = (s: string) => s.replaceAll("$[", "${");
    const text = code(
      [
        "export const A_JS = `",
        'const x = $[JSON.stringify({ a: "}" })};',
        "const y = \\`not \\$[a part}\\`;",
        "$[B_JS}$[fn.toString()}$[n}$[`inner $[m}`}",
        "`;",
      ].join("\n"),
    );
    const [script] = browserScripts(text);
    assert.deepEqual(script?.parts, [
      'JSON.stringify({ a: "}" })',
      "B_JS",
      "fn.toString()",
      "n",
      code("`inner $[m}`"),
    ]);
    const unsafe = (script?.parts ?? []).filter((p) => !SAFE_PART.some((rx) => rx.test(p)));
    assert.deepEqual(unsafe, ["n", code("`inner $[m}`")]);
  });
});
