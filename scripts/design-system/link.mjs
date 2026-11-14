// @ts-check
// The design system (packages/design-system) has no packages of its own while it lives in this
// repository: it builds and is type-checked with the app's (web/node_modules), which hold every
// package it names as a peer dependency. This makes the link that lets it find them:
// packages/design-system/node_modules -> ../../web/node_modules. `npm run web:install` runs it.
import { existsSync, lstatSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const link = join(root, "packages", "design-system", "node_modules");
const target = join("..", "..", "web", "node_modules");

if (!existsSync(join(root, "web", "node_modules"))) {
  console.error("design-system link: the app's packages are not installed: npm run web:install");
  process.exit(1);
}
const there = lstatSync(link, { throwIfNoEntry: false });
if (there?.isSymbolicLink() && readlinkSync(link) === target) {
  console.log("design-system link: packages/design-system/node_modules is in place");
} else if (there && !there.isSymbolicLink()) {
  console.error(
    "design-system link: packages/design-system/node_modules is a folder of its own. Remove it: the design system uses the app's packages.",
  );
  process.exit(1);
} else {
  if (there) rmSync(link);
  symlinkSync(target, link, "dir");
  console.log("design-system link: packages/design-system/node_modules -> web/node_modules");
}
