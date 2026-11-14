import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

/**
 * The brand (goal 243) is one theme, packages/design-system/src/theme.css: each colour has a use
 * and changes by its use between light and dark. So no screen of the app and no part of the
 * design system sets a colour, a size of text or a weight of its own. The stock components are
 * shadcn's, as its tool makes them, and Thermy's drawing keeps its own colours.
 */
const ROOT = join(import.meta.dirname, "..", "..");
const THEME = join(ROOT, "packages", "design-system", "src", "theme.css");
/** The folders whose files wear the brand, and what in them is not held. */
const HELD = [join("web", "src"), join("packages", "design-system")];
const NOT_HELD = [
  join("packages", "design-system", "src", "ui"),
  join("packages", "design-system", "src", "brand", "thermy.tsx"),
  join("packages", "design-system", "node_modules"),
  join("packages", "design-system", "dist"),
];

function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (NOT_HELD.includes(path)) return [];
    if (entry.isDirectory()) return files(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** What a class or a value may not be, outside the theme. */
const OWN: { what: string; found: RegExp }[] = [
  { what: "a colour as a number", found: /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\boklch\(/ },
  {
    what: "a colour of Tailwind's palette",
    found:
      /\b(?:text|bg|border|fill|stroke|from|via|to|ring|outline|decoration|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:-\d+)?\b/,
  },
  {
    what: "a size of text off the brand's four",
    found: /\btext-(?:lg|xl|[2-9]xl|\[[\d.]+(?:px|rem|em)\])/,
  },
  {
    what: "a weight off the brand's two",
    found: /\bfont-(?:thin|extralight|light|medium|bold|extrabold|black)\b/,
  },
  { what: "a shadow of its own", found: /\bshadow-\[/ },
];

describe("the brand", () => {
  test("no screen or part sets a colour, a size of text, a weight or a shadow of its own", () => {
    const found: string[] = [];
    const all = HELD.flatMap(files);
    assert.ok(all.length > 50, "the app's and the design system's files are read");
    for (const file of all) {
      readFileSync(join(ROOT, file), "utf8")
        .split("\n")
        .forEach((line, i) => {
          for (const own of OWN)
            if (own.found.test(line))
              found.push(`${file}:${i + 1}: ${own.what}: ${line.trim().slice(0, 90)}`);
        });
    }
    assert.deepEqual(
      found,
      [],
      "give the look a use in the theme (packages/design-system/src/theme.css), and use its class",
    );
  });

  test("the theme gives every use a value in light, and the ones that change one in dark", () => {
    const css = readFileSync(THEME, "utf8");
    const night = css.indexOf("@media (prefers-color-scheme: dark) {");
    const theme = css.slice(css.indexOf("@theme inline {"), css.indexOf(":root {"));
    const light = css.slice(css.indexOf(":root {"), night);
    const dark = css.slice(night, css.indexOf("@layer base"));
    const uses = (block: string) =>
      new Set(Array.from(block.matchAll(/^\s+(--[a-z0-9-]+):/gm), (m) => m[1]));
    const inLight = uses(light);
    const inTheme = uses(theme);
    // Every value the theme's classes read is set in light, or is the theme's own.
    const read = Array.from(theme.matchAll(/var\((--[a-z0-9-]+)\)/g), (m) => m[1]);
    assert.ok(read.length > 40, "the theme's uses are read");
    assert.deepEqual(
      read.filter((name) => !inLight.has(name) && !inTheme.has(name)),
      [],
      "each colour the theme names has a value",
    );
    // The same in both: the flame button, its text, the ember, and the marks of a picture.
    const same = [
      "--primary",
      "--primary-foreground",
      "--ember",
      "--idle-dot",
      "--idle-mark",
      "--idle-bar",
      "--radius",
      "--sidebar-primary",
      "--sidebar-primary-foreground",
    ];
    const inDark = uses(dark);
    assert.deepEqual(
      Array.from(inLight).filter((name) => !inDark.has(name) && !same.includes(name ?? "")),
      [],
      "a colour that is not the same in light and in dark has its dark value",
    );
  });
});
