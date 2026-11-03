import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The image builds, as the tests read them: the one Containerfile whose targets are control, the
 * harness and the supervisor, the one-container rig image's file on a harness built first, and the
 * scripts both mount for the steps that run them (containers/build/).
 */

/** The repository's root. */
export const ROOT = join(import.meta.dirname, "..", "..");

/** The Containerfile control, the harness and the supervisor are built from, each its target. */
export const CONTAINERFILE = "containers/Containerfile";
/** The one-container rig image's Containerfile: one stage, on the harness image. */
export const RIG_CONTAINERFILE = "containers/rig/Containerfile";
/** The scripts the images' steps mount and run, which no image keeps. */
export const BUILD_SCRIPTS = "containers/build";

/** The images, by their target of CONTAINERFILE, and the rig image. */
export type Image = "control" | "harness" | "supervisor" | "rig";

/** A file of the repository, by its path from the root. */
export const repoFile = (path: string): string => readFileSync(join(ROOT, path), "utf8");

/** One stage of a Containerfile: its FROM line, and everything up to the next FROM. */
export function stage(text: string, name: string): string {
  const from = new RegExp(`\\nFROM \\S+ AS ${name}\\n`).exec(text);
  if (!from) throw new Error(`no stage ${name}`);
  const next = text.indexOf("\nFROM ", from.index + 1);
  return text.slice(from.index, next < 0 ? undefined : next);
}

/** What an image holds: its target's stage, or the rig image's one stage. */
export function finalStage(image: Image): string {
  if (image === "rig") {
    const rig = repoFile(RIG_CONTAINERFILE);
    return rig.slice(rig.lastIndexOf("\nFROM "));
  }
  return stage(repoFile(CONTAINERFILE), image);
}

/** A stage's instructions, comments left out and each continued line joined to its first. */
export function instructions(text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    current = current ? `${current}\n${line}` : line;
    if (line.endsWith("\\")) continue;
    if (current.trim()) out.push(current);
    current = "";
  }
  return out;
}

/** The step that runs one of the build scripts, mounted from their stage for that step only. */
export const RUN_SCRIPT = (script: string) =>
  `RUN --mount=type=bind,from=build-scripts,target=/mnt sh /mnt/${script}`;

/**
 * The users and groups a step makes: its shell run with groupadd and useradd standing in for
 * themselves, each printing its arguments, so the loops' arithmetic is the shell's own.
 */
export function usersMade(script: string): {
  groups: Map<string, number>;
  users: Map<string, { uid: number; group: string }>;
} {
  const stubs = 'groupadd() { echo "groupadd $*"; }\nuseradd() { echo "useradd $*"; }\n';
  const calls = execFileSync("sh", ["-c", `${stubs}${script}`], { encoding: "utf8" });
  const groups = new Map<string, number>();
  const users = new Map<string, { uid: number; group: string }>();
  for (const line of calls.trim().split("\n")) {
    const group = /^groupadd -g (\d+) (\S+)$/.exec(line);
    if (group) {
      groups.set(group[2] as string, Number(group[1]));
      continue;
    }
    const user = /^useradd -u (\d+) -g (\S+) .* (\S+)$/.exec(line);
    if (!user) throw new Error(`not a user or a group: ${line}`);
    users.set(user[3] as string, { uid: Number(user[1]), group: user[2] as string });
  }
  return { groups, users };
}
