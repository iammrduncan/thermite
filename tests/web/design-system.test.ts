import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

/**
 * The design system (packages/design-system, goal 243) is where every component and every look
 * is made, and its site shows each one. These hold it for every later screen:
 *
 * - the app writes no look of its own: no class and no style in its files, so a screen is made
 *   of the design system's parts and of nothing else;
 * - the site cannot fall behind: every part the design system gives has an example on a page.
 *
 * The import check holds the rest (scripts/checks/lib/imports.ts): the app imports the design
 * system by its door alone, and none of the packages a look is made with.
 */
const ROOT = join(import.meta.dirname, "..", "..");
const APP = join("web", "src");
const DESIGN = join("packages", "design-system");

/**
 * The app's files that still write classes: the screens of the app's first build and their own
 * parts, which stay until each is built from its board. The list may only shrink: a file leaves
 * it with the goal that rebuilds it. No other file of the app may write a class.
 */
const NOT_YET_REBUILT: Record<string, string> = {
  "screens/home.tsx": "Home: goal 246",
  "screens/run.tsx": "a run's screen: goal 247",
  "screens/settings.tsx": "Setup: goal 252",
  "parts/rows.tsx": "the rows of Home and of a run's screen: goals 246 and 247",
  "parts/figure.tsx": "a run's chart: goal 247",
  "parts/time.tsx": "a time in a row: goals 246 and 247",
};

/** The gallery of the app's screens: a development tool, which a built app does not have. */
const DEV = "dev/";

function files(dir: string, under = ""): string[] {
  return readdirSync(join(ROOT, dir, under), { withFileTypes: true }).flatMap((entry) => {
    const path = under ? `${under}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return files(dir, path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Where a file gives something a look of its own. */
const LOOK = /\b(?:className|class|style)\s*=/;

describe("the app's look", () => {
  test("no file of the app writes a class or a style: every look is a part of the design system", () => {
    const found: string[] = [];
    for (const file of files(APP)) {
      if (file.startsWith(DEV) || file in NOT_YET_REBUILT) continue;
      readFileSync(join(ROOT, APP, file), "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (LOOK.test(line)) found.push(`web/src/${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
        });
    }
    assert.deepEqual(
      found,
      [],
      "make the look a part in packages/design-system/src/parts/, give it an example on the site, and use the part here",
    );
  });

  test("the list of screens not yet rebuilt only shrinks", () => {
    for (const [file, why] of Object.entries(NOT_YET_REBUILT)) {
      const path = join(ROOT, APP, file);
      assert.ok(existsSync(path), `web/src/${file} is gone (${why}): take it off the list`);
      assert.ok(
        LOOK.test(readFileSync(path, "utf8")),
        `web/src/${file} writes no class any more (${why}): take it off the list`,
      );
    }
    // The six of 2026-11-14. A new file is never added: a new screen is made of parts.
    assert.ok(Object.keys(NOT_YET_REBUILT).length <= 6, "the list does not grow");
  });

  test("the app has no components of its own beside its screens", () => {
    assert.ok(
      !existsSync(join(ROOT, APP, "components")),
      "web/src/components is the design system's now",
    );
    assert.ok(
      !existsSync(join(ROOT, "web", "components.json")),
      "shadcn's tool writes into the design system",
    );
  });
});

describe("the design system's packages", () => {
  test("it has none of its own: each one it needs is the app's, at a version it takes", () => {
    const read = (path: string) =>
      JSON.parse(readFileSync(join(ROOT, path, "package.json"), "utf8")) as Record<
        string,
        Record<string, string> | undefined
      >;
    const design = read(DESIGN);
    assert.equal(design.dependencies, undefined, "it installs nothing: its packages are peers");
    assert.equal(design.devDependencies, undefined);
    const app = read("web");
    const has = { ...app.devDependencies, ...app.dependencies };
    const major = (version: string) => version.replace(/^[\^~]/, "").split(".")[0];
    for (const [name, wanted] of Object.entries(design.peerDependencies ?? {})) {
      assert.ok(has[name], `the app has ${name}, which the design system needs`);
      assert.equal(
        major(has[name] ?? ""),
        major(wanted),
        `the app's ${name} (${has[name]}) is a version the design system takes (${wanted}): change its peer dependency with the app's`,
      );
    }
  });
});

describe("the design system's site", () => {
  const site = join(ROOT, DESIGN, "site");
  const examples = readdirSync(join(site, "examples")).filter((f) => f.endsWith(".tsx"));
  const shown = examples.map((f) => readFileSync(join(site, "examples", f), "utf8")).join("\n");
  const pages = readFileSync(join(site, "pages.ts"), "utf8");
  const onPages = Array.from(pages.matchAll(/file: "([a-z-]+)"/g), (m) => m[1]);

  test("every part the design system gives has an example", () => {
    const door = readFileSync(join(ROOT, DESIGN, "src", "index.ts"), "utf8");
    const parts: string[] = [];
    for (const m of door.matchAll(/export \* from "\.\/([a-z-/]+\.tsx?)";/g)) {
      const text = readFileSync(join(ROOT, DESIGN, "src", m[1] ?? ""), "utf8");
      // A part is a component: a function it exports whose name starts with a capital.
      for (const p of text.matchAll(/^export function ([A-Z][A-Za-z]*)/gm)) parts.push(p[1] ?? "");
    }
    assert.ok(parts.length >= 40, `the design system's parts are read (${parts.length})`);
    // The frame and a screen are what the site itself is made of (site.tsx).
    const used = `${shown}\n${readFileSync(join(site, "site.tsx"), "utf8")}`;
    assert.deepEqual(
      parts.filter((name) => !new RegExp(`<${name}\\b`).test(used)),
      [],
      "give each part an example in packages/design-system/site/examples/, on a page of pages.ts",
    );
  });

  test("every example is on a page, and every page's example is there", () => {
    const have = examples.map((f) => f.slice(0, -".tsx".length)).sort();
    assert.deepEqual([...onPages].sort(), have);
    assert.equal(new Set(onPages).size, onPages.length, "an example is on one page");
  });

  test("an example is written as an app writes it: from the design system's door", () => {
    for (const file of examples) {
      const text = readFileSync(join(site, "examples", file), "utf8");
      for (const m of text.matchAll(/from "([^"]+)"/g)) {
        const from = m[1] ?? "";
        assert.ok(
          from === "@ds" || from === "react" || from === "lucide-react",
          `${file} imports ${from}: an example imports parts from @ds, as an app does`,
        );
      }
    }
  });
});
