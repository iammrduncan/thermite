#!/usr/bin/env node
// @ts-check
// Verifies design-system package boundaries and light/dark CSS token parity:
// 1. packages/design-system/src/ imports nothing from other Thermite packages or outside itself.
// 2. Every var(--*) mapped in base.css @theme inline has both light and dark definitions in
//    base.css, and each preset defines matching light + dark pairs for its overridden custom vars.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const DS_ROOT = resolve("packages/design-system");
const DS_SRC = join(DS_ROOT, "src");
const FORBIDDEN_SPEC =
  /^(?:@thermite\/|(?:.*\/)?packages\/(?:core|control|runner|cli|ui|harness-libfx)(?:\/|$))/;
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|css)$/;
const IMPORT_RE =
  /(?:(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?|import\s*\(\s*|@import\s+(?:url\(\s*)?)["']([^"']+)["']/g;

/** @type {string[]} */
const errors = [];

/**
 * Strips CSS block comments and returns every balanced `{ ... }` body whose header matches `re`.
 * @param {string} css
 * @param {RegExp} headerRe
 * @returns {string[]}
 */
function extractBlocks(css, headerRe) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  /** @type {string[]} */
  const bodies = [];
  for (const match of clean.matchAll(headerRe)) {
    const start = (match.index ?? 0) + match[0].length;
    let depth = 1;
    let i = start;
    while (i < clean.length && depth > 0) {
      if (clean[i] === "{") depth += 1;
      else if (clean[i] === "}") depth -= 1;
      i += 1;
    }
    if (depth === 0) bodies.push(clean.slice(start, i - 1));
  }
  return bodies;
}

/** @param {string} block */
function customProps(block) {
  return new Set([...block.matchAll(/(?:^|[;{\s])(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1] ?? ""));
}

/** @param {string} css */
function splitLightDarkRoots(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const darkBlocks = extractBlocks(
    clean,
    /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{/g,
  );
  let withoutDark = clean;
  for (const body of darkBlocks) withoutDark = withoutDark.replace(body, "");
  const lightRoots = extractBlocks(withoutDark, /:root\s*\{/g);
  const darkRoots = darkBlocks.flatMap((block) => extractBlocks(block, /:root\s*\{/g));
  const light = new Set(lightRoots.flatMap((b) => [...customProps(b)]));
  const dark = new Set(darkRoots.flatMap((b) => [...customProps(b)]));
  return { light, dark };
}

// 1. Boundary check: packages/design-system/src/ imports nothing outside packages/design-system.
if (!existsSync(DS_SRC)) {
  errors.push("packages/design-system/src/ does not exist");
} else {
  for (const entry of readdirSync(DS_SRC, { recursive: true })) {
    const rel = String(entry).split("\\").join("/");
    if (!SOURCE_EXT.test(rel)) continue;
    const file = join(DS_SRC, rel);
    const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of text.matchAll(IMPORT_RE)) {
      const spec = match[1] ?? "";
      if (FORBIDDEN_SPEC.test(spec)) {
        errors.push(`${relative(process.cwd(), file)}: forbidden import "${spec}"`);
      } else if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec);
        if (target !== DS_ROOT && !target.startsWith(`${DS_ROOT}${sep}`)) {
          errors.push(`${relative(process.cwd(), file)}: import escapes design-system "${spec}"`);
        }
      }
    }
  }
}

// 2. Token parity: base.css @theme inline var(--*) must exist in both light and dark :root.
const basePath = join(DS_SRC, "theme/base.css");
if (!existsSync(basePath)) {
  errors.push("packages/design-system/src/theme/base.css is missing");
} else {
  const baseCss = readFileSync(basePath, "utf8");
  const themeBlocks = extractBlocks(baseCss, /@theme\s+inline\s*\{/g);
  if (themeBlocks.length === 0) {
    errors.push("theme/base.css: missing @theme inline block");
  } else {
    const themeBody = themeBlocks.join("\n");
    const themeOwn = customProps(themeBody);
    const { light, dark } = splitLightDarkRoots(baseCss);
    const referenced = new Set(
      [...themeBody.matchAll(/var\(\s*(--[a-z0-9-]+)\s*[,)]/gi)].map((m) => m[1] ?? ""),
    );
    for (const token of [...referenced].sort()) {
      if (themeOwn.has(token)) continue;
      if (!light.has(token))
        errors.push(`theme/base.css: ${token} mapped in @theme inline is missing from light :root`);
      if (!dark.has(token))
        errors.push(`theme/base.css: ${token} mapped in @theme inline is missing from dark :root`);
    }
  }
}

// 3. Preset parity: every overridden :root custom property in a preset exists in both light and dark.
for (const preset of ["thermite.css", "fxbot.css"]) {
  const presetPath = join(DS_SRC, "theme/presets", preset);
  if (!existsSync(presetPath)) {
    errors.push(`packages/design-system/src/theme/presets/${preset} is missing`);
    continue;
  }
  const { light, dark } = splitLightDarkRoots(readFileSync(presetPath, "utf8"));
  for (const token of [...light].sort()) {
    if (!dark.has(token))
      errors.push(`theme/presets/${preset}: ${token} defined in light :root but missing in dark`);
  }
  for (const token of [...dark].sort()) {
    if (!light.has(token))
      errors.push(`theme/presets/${preset}: ${token} defined in dark :root but missing in light`);
  }
}

if (errors.length > 0) {
  for (const err of errors) console.error(`check-design: ${err}`);
  process.exit(1);
}
console.log("check-design: ok (boundaries + light/dark token parity)");
