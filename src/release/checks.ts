/**
 * The checks of each published image (goal 010): what the release workflow holds an image to
 * after it pushes it and before the image gets its version's tag. The owner moved the RunPod rig
 * image from the lab to Thermite's release on 2026-10-24, with the lab's rules for it. These
 * functions decide; scripts/release/check-images.ts pulls each image with no sign-in and runs PROBE in it.
 */
import { IMAGES, type ImageKey } from "./bundle.ts";

/**
 * What an image carries that a published image must not, as `name=value` lines (sh, run as
 * root so that every file is seen): Claude Code, socat, bubblewrap, set-id files, and pi-tui's
 * prebuilt native helpers, which every image deletes (goal 169).
 */
export const PROBE = [
  'printf "claude=%s\\n" "$(command -v claude; find / -xdev -type f -name claude 2>/dev/null | head -n 3 | tr "\\n" " ")"',
  'printf "socat=%s\\n" "$(command -v socat)"',
  'printf "bwrap=%s\\n" "$(command -v bwrap)"',
  'printf "setid=%s\\n" "$(find / -xdev -type f -perm /6000 2>/dev/null | head -n 5 | tr "\\n" " ")"',
  'printf "pitui=%s\\n" "$(find / -xdev -type d -path "*/@earendil-works/pi-tui/native" 2>/dev/null | head -n 3 | tr "\\n" " ")"',
].join("; ");

/** What is known of one pulled image. */
export interface ImageFacts {
  /** It pulled with no sign-in: its package is public. */
  anonymous: boolean;
  /** Its environment, `NAME=value` each, as `docker image inspect` gives it. */
  env: string[];
  /** PROBE's output. */
  probe: string;
  /** The platforms the image is published for, such as `linux/arm64`. */
  platforms: string[];
}

/** The images whose processes run the agents' roles: the harnesses and the rig image. */
const ROLE_IMAGES: ImageKey[] = ["harness", "harness-cuda", "harness-cuda13", "rig-cuda"];

/** A value of the environment, or undefined. */
function envValue(env: string[], name: string): string | undefined {
  const line = env.find((e) => e.startsWith(`${name}=`));
  return line === undefined ? undefined : line.slice(name.length + 1);
}

/** PROBE's output as name to value, each value trimmed. */
export function probeValues(probe: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of probe.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1).trim();
  }
  return out;
}

/**
 * What is wrong with a published image, one line each in words; empty when it holds. Every image:
 * it pulls with no sign-in, reports the release's commit, carries no Claude Code (decided
 * 2026-10-18), has no set-id file and no native part of pi-tui (goal 169), and sets no key, token
 * or password in its environment (a setting that names a file, such as
 * THERMITE_SUPERVISOR_TOKEN_FILE, is a path, not a secret).
 * The harnesses and the rig image also report their image ID and carry neither socat nor
 * bubblewrap. The supervisor and the rig image name no STE checker: a deployment adds its own.
 * Each image is published for its platforms (bundle.ts), arm64 too where it says so.
 */
export function imageProblems(key: ImageKey, commit: string, facts: ImageFacts): string[] {
  if (!facts.anonymous)
    return [
      "it does not pull without signing in: make its package public on GitHub (the package's settings, once), then run the checks again",
    ];
  const problems: string[] = [];
  const said = probeValues(facts.probe);
  const reported = envValue(facts.env, "THERMITE_COMMIT");
  if (reported !== commit)
    problems.push(
      `it reports THERMITE_COMMIT ${reported ? JSON.stringify(reported) : "not at all"}, not the release's commit ${commit}`,
    );
  if (said.claude)
    problems.push(`it carries Claude Code (${said.claude}): a published image never does`);
  for (const line of facts.env) {
    const name = line.slice(0, line.indexOf("="));
    const value = line.slice(name.length + 1);
    if (
      value &&
      (/SNAPSHOT_KEY$/.test(name) || /^THERMITE_\w*(KEY|TOKEN|SECRET|PASSWORD)$/.test(name))
    )
      problems.push(
        `it sets ${name} in its environment: no key, token or password goes in an image`,
      );
  }
  if (ROLE_IMAGES.includes(key)) {
    if (!envValue(facts.env, "THERMITE_IMAGE_ID"))
      problems.push("it does not report THERMITE_IMAGE_ID, which the harness reports as its image");
    if (said.socat) problems.push(`it carries socat (${said.socat})`);
    if (said.bwrap) problems.push(`it carries bubblewrap (${said.bwrap})`);
  }
  if (said.setid) problems.push(`it has set-id files: ${said.setid}`);
  if (said.pitui)
    problems.push(
      `it holds pi-tui's prebuilt native helpers (${said.pitui}): every image deletes them`,
    );
  const missing = IMAGES[key].platforms.filter((p) => !facts.platforms.includes(p));
  if (missing.length) problems.push(`it is not published for ${missing.join(" or ")}`);
  if ((key === "supervisor" || key === "rig-cuda") && envValue(facts.env, "THERMITE_STE_CHECKER"))
    problems.push(
      "it names an STE checker (THERMITE_STE_CHECKER): the checker is a deployment's own",
    );
  return problems;
}
