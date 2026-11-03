#!/usr/bin/env node
// The documentation site's Changelog page is CHANGELOG.md, at the repository's root, below its
// heading, with the site's front matter in front and its links to site pages made relative to the
// page. This script writes the page from it (`npm run docs:changelog`); `npm run docs:check` fails
// when the two differ.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const changelogFile = join(root, "CHANGELOG.md");
export const changelogPageFile = join(root, "docs/_site/src/content/docs/project/changelog.md");

const FRONT = `---
title: "Changelog"
description: "Each release of Thermite, newest first: what's new, what changed and what was removed."
type: project
sidebar:
  order: 1
---
`;

const NOTE =
  "<!-- Written from CHANGELOG.md by `npm run docs:changelog`: change CHANGELOG.md, not this page. -->\n";

/** The page that CHANGELOG.md makes: its text below the `# Changelog` heading. */
export function changelogPage(changelog = readFileSync(changelogFile, "utf8")) {
  const heading = /^# Changelog\n+/.exec(changelog);
  if (!heading) throw new Error("CHANGELOG.md must start with the heading `# Changelog`");
  // A link to a site page, from the repository's root, is the same page from project/.
  const body = changelog
    .slice(heading[0].length)
    .replaceAll("](docs/_site/src/content/docs/", "](../");
  return `${FRONT}\n${NOTE}\n${body}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(changelogPageFile, changelogPage());
  process.stdout.write(
    "docs/_site/src/content/docs/project/changelog.md: written from CHANGELOG.md\n",
  );
}
