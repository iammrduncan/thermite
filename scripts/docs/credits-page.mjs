#!/usr/bin/env node
// The documentation site's Credits page is CREDITS.md, at the repository's root, below its
// heading, with the site's front matter in front. This script writes the page from it
// (`npm run docs:credits`); `npm run docs:check` fails when the two differ.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const creditsFile = join(root, "CREDITS.md");
export const creditsPageFile = join(root, "docs/_site/src/content/docs/project/credits.md");

const FRONT = `---
title: "Credits"
description: "The research, systems, programs, libraries, standards and services Thermite draws on, runs or ships, each with its licence."
type: project
sidebar:
  order: 4
---
`;

const NOTE =
  "<!-- Written from CREDITS.md by `npm run docs:credits`: change CREDITS.md, not this page. -->\n";

/** The page that CREDITS.md makes: its text below the `# Credits` heading. */
export function creditsPage(credits = readFileSync(creditsFile, "utf8")) {
  const heading = /^# Credits\n+/.exec(credits);
  if (!heading) throw new Error("CREDITS.md must start with the heading `# Credits`");
  return `${FRONT}\n${NOTE}\n${credits.slice(heading[0].length)}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(creditsPageFile, creditsPage());
  process.stdout.write("docs/_site/src/content/docs/project/credits.md: written from CREDITS.md\n");
}
