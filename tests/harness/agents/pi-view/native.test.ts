import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

/**
 * The Pi view runs without pi-tui's native folder (goal 169; the owner's decision of 2026-10-30):
 * every image deletes `native/` (its prebuilt helpers for a clipboard and modifier keys), so the
 * view must draw with a copy of pi-tui that has none, and must load no native module at all. A
 * child process resolves pi-tui to such a copy, refuses every native module, and draws the view.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const PKG = join(ROOT, "node_modules", "@earendil-works", "pi-tui");
const scratch = mkdtempSync(join(tmpdir(), "thermite-pitui-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("the view draws with a pi-tui that has no native folder, and loads no native module", () => {
  assert.ok(
    existsSync(join(PKG, "native")),
    "the installed package has the folder an image deletes",
  );
  // pi-tui as an image has it: the package without native/, beside its two dependencies.
  const modules = join(scratch, "node_modules");
  const copy = join(modules, "@earendil-works", "pi-tui");
  cpSync(PKG, copy, { recursive: true, filter: (src) => !src.startsWith(join(PKG, "native")) });
  assert.ok(!existsSync(join(copy, "native")));
  for (const dep of ["marked", "get-east-asian-width"])
    symlinkSync(join(ROOT, "node_modules", dep), join(modules, dep), "dir");
  const hooks = join(scratch, "hooks.mjs");
  writeFileSync(
    hooks,
    `let target;
export function initialize(data) { target = data.target; }
export async function resolve(specifier, context, next) {
  if (specifier === "@earendil-works/pi-tui") return { url: target, shortCircuit: true };
  return next(specifier, context);
}
`,
  );
  const preload = join(scratch, "preload.mjs");
  writeFileSync(
    preload,
    `import { register } from "node:module";
register(${JSON.stringify(pathToFileURL(hooks).href)}, { data: { target: ${JSON.stringify(pathToFileURL(join(copy, "dist", "index.js")).href)} } });
process.dlopen = (_module, file) => { throw new Error("a native module was loaded: " + file); };
`,
  );
  const run = join(scratch, "run.mjs");
  writeFileSync(
    run,
    `const { PiView } = await import(${JSON.stringify(pathToFileURL(join(ROOT, "src/harness/agents/pi-view/view.ts")).href)});
let written = "";
const view = new PiView({ out: (d) => { written += d; }, cols: 80, rows: 24, heading: "VIEW-WITHOUT-NATIVE" });
view.start();
view.attach({ subscribe: () => () => undefined }, () => ({ turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0, compactions: 0, model: "m" }));
view.note("**drawn**");
view.owner("words", "steer");
view.flush();
view.stop();
process.stdout.write(JSON.stringify({ from: import.meta.resolve("@earendil-works/pi-tui"), drawn: written.includes("VIEW-WITHOUT-NATIVE") && written.includes("words") }));
`,
  );
  const said = execFileSync(process.execPath, ["--import", pathToFileURL(preload).href, run], {
    cwd: scratch,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "--disable-warning=ExperimentalWarning" },
  });
  assert.deepEqual(JSON.parse(said), {
    from: pathToFileURL(join(copy, "dist", "index.js")).href,
    drawn: true,
  });
});
