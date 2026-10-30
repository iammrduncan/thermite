/**
 * Paths as text, with "/" between their parts, worked out as Node's `path.posix` works them out.
 * `core` does no I/O and imports none of Node's modules but node:crypto (CONVENTIONS.md), so the
 * kit's schema and the tunnel's folders use these. tests/core/paths.test.ts holds them to Node's.
 */

/**
 * A path with its "." parts, empty parts and ".." parts worked out, as `path.posix.normalize`
 * gives it: a ".." takes away the part before it, or stays at the start of a relative path, or
 * goes at the root. An absolute path stays absolute, a final "/" stays, and nothing is ".".
 */
export function normalizePath(path: string): string {
  if (path === "") return ".";
  const absolute = path.startsWith("/");
  const trailing = path.endsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
    else if (!absolute) parts.push("..");
  }
  const joined = parts.join("/");
  if (joined === "") return absolute ? "/" : trailing ? "./" : ".";
  const out = trailing ? `${joined}/` : joined;
  return absolute ? `/${out}` : out;
}

/** Paths joined with "/" and normalized, as `path.posix.join` joins them; empty ones left out. */
export function joinPath(...paths: string[]): string {
  return normalizePath(paths.filter((p) => p !== "").join("/"));
}

/**
 * Where the harness reads its inbox, which the supervisor fills: inside a folder of the harness
 * image's own that only root and the controller's group may enter (containers/harness/Containerfile),
 * so that no role reaches what the supervisor fetched, whatever the modes in the mounted folder.
 * Compose, the machine units and the cluster manifests mount the inbox here.
 */
export const HARNESS_INBOX_DIR = "/controller/inbox";

/**
 * Where the supervisor fills the inbox in its own image: inside a folder of the image's own that
 * only root and the supervisor's group may enter (containers/supervisor/Containerfile), so that no
 * advisor's program reaches what the supervisor fetched, whatever the modes in the mounted folder.
 * Compose, the machine units and the cluster manifests mount the inbox here.
 */
export const SUPERVISOR_INBOX_DIR = "/supervisor/inbox";

/** The supervisor's home in its passwd entry, in both images: ssh finds ~/.ssh there. */
export const SUPERVISOR_PASSWD_HOME = "/var/lib/thermite-supervisor/home";
