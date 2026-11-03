import { readFileSync } from "node:fs";
import { type BuildInfo, buildOf } from "../core/version.ts";

let own: BuildInfo | undefined;

/**
 * This process's build: the version in package.json (next to dist/ in the images, at the top of
 * the repository in development) and the commit in THERMITE_COMMIT, which the images take from
 * their build argument of the same name. Read once; what a build is, and how two compare, is in
 * core/version.ts.
 */
export function buildInfo(): BuildInfo {
  if (own) return own;
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
  };
  own = buildOf(pkg.version, process.env.THERMITE_COMMIT);
  return own;
}
