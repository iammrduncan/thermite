#!/usr/bin/env node
// Public-content check: fails when files that Git would publish contain lab identifiers,
// private network addresses or secret-shaped strings.
//
// Generic patterns live here. Lab-specific identifiers live in a private denylist
// (.internal/public-denylist.txt, git-ignored), one regular expression per line:
//   - lines starting with "#" are comments;
//   - a "cs:" prefix makes the pattern case-sensitive (default: case-insensitive).
// A line containing "public-check: allow" is skipped (use sparingly, with a reason).
//
// By default it scans what Git would commit: the staged (index) content of every tracked file,
// whatever is on disk. Stage new files first. With --untracked it also scans untracked,
// non-ignored files from disk, except the owner's tooling directories (.agents/, .claude/,
// skills-lock.json), which are never committed by agents.
//
// A clone without .internal/ (a contributor's, say) checks the generic patterns only, with a
// warning. Where .internal/ exists, a missing denylist is an error: the maintainers' checkouts
// must never pass without it. --allow-missing-denylist also downgrades that to a warning.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const internalDir = join(root, ".internal");
const denylistPath = join(internalDir, "public-denylist.txt");

// Addresses that may appear in public files: unspecified, loopback and the documentation ranges.
const allowedIPv4 =
  /^(?:0\.0\.0\.0|127\.0\.0\.1|192\.0\.2\.\d+|198\.51\.100\.\d+|203\.0\.113\.\d+)$/;
const octet = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const ipv4 = new RegExp(`(?<![\\d.])(?:${octet}\\.){3}${octet}(?![\\d.])`, "g");

const generic = [
  { label: "private IPv4 (10/8)", re: /\b10\.(?:\d{1,3}\.){2}\d{1,3}\b/ },
  { label: "private IPv4 (172.16/12)", re: /\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/ },
  { label: "private IPv4 (192.168/16)", re: /\b192\.168\.\d{1,3}\.\d{1,3}\b/ },
  {
    label: "CGNAT IPv4 (100.64/10)",
    re: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/,
  },
  { label: "MAC address", re: /\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/i },
  { label: "private key block", re: /BEGIN [A-Z ]*PRIVATE KEY/ },
  {
    label: "API key shape",
    re: /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[bp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/,
  },
];

const lab = [];
if (existsSync(denylistPath)) {
  for (const raw of readFileSync(denylistPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const caseSensitive = line.startsWith("cs:");
    const source = caseSensitive ? line.slice(3) : line;
    lab.push({ label: "lab identifier", re: new RegExp(source, caseSensitive ? "" : "i") });
  }
} else if (!existsSync(internalDir) || process.argv.includes("--allow-missing-denylist")) {
  console.warn("check-public: no private denylist here; checking generic patterns only.");
} else {
  console.error(`check-public: private denylist missing (${denylistPath}).`);
  console.error(
    ".internal/ exists, so its denylist must too (--allow-missing-denylist to override).",
  );
  process.exit(1);
}

const ownerTooling = [".agents/", ".claude/", "skills-lock.json"];
const notOwnerTooling = (f) => !ownerTooling.some((p) => f === p || f.startsWith(p));
const list = (args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .filter(notOwnerTooling);

// Staged content, read from the index (so a file deleted or changed on disk is still checked).
const sources = list(["ls-files", "--cached", "-z"]).map((f) => ({
  file: f,
  read: () => execFileSync("git", ["show", `:${f}`], { cwd: root, maxBuffer: 256 * 1024 * 1024 }),
}));
if (process.argv.includes("--untracked")) {
  for (const f of list(["ls-files", "--others", "--exclude-standard", "-z"])) {
    const full = join(root, f);
    if (existsSync(full) && statSync(full).isFile()) {
      sources.push({ file: f, read: () => readFileSync(full) });
    }
  }
}

const patterns = [...generic, ...lab];
let hits = 0;
for (const { file, read } of sources) {
  // latin1 keeps every byte, so identifiers inside binary files are found too.
  const lines = read().toString("latin1").split("\n");
  lines.forEach((text, i) => {
    if (text.includes("public-check: allow")) return;
    const report = (label, match) => {
      hits += 1;
      console.error(`${file}:${i + 1}: ${label}: ${match}`);
    };
    for (const { label, re } of patterns) {
      const m = text.match(re);
      if (m) report(label, m[0]);
    }
    for (const m of text.matchAll(ipv4)) {
      if (!allowedIPv4.test(m[0])) report("IPv4 address", m[0]);
    }
  });
}
const files = sources;

if (hits > 0) {
  console.error(
    `check-public: ${hits} hit(s) in ${files.length} files. Remove lab specifics before committing.`,
  );
  process.exit(1);
}
console.log(`check-public: ok (${files.length} files, ${patterns.length} patterns)`);
