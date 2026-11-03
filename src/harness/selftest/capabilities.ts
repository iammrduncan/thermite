import { spawnSync } from "node:child_process";

/**
 * Files with capabilities on the container's own filesystem: a program a role runs could gain
 * privileges through one, as through a set-id program, where the host does not stop it (RunPod
 * leaves no_new_privs off). The attribute holds them (`getcap` reads it); Node has no call for
 * extended attributes, so the harness image's python3 reads them.
 */

/** The extended attribute that holds a file's capabilities. */
export const CAPS_ATTR = "security.capability";

/** The longest a look over the container's files may take. */
const LOOK_TIMEOUT_MS = 120_000;

/** Walks `root` on its own device, leaving out `skip`, and lists the regular files with `attr`. */
const LOOK = `
import json, os, stat, sys
root, attr, skip = sys.argv[1], sys.argv[2], set(sys.argv[3:])
get = getattr(os, "getxattr", None)
if get is None:
    print(json.dumps({"none": "this system has no file capabilities"}))
    sys.exit(0)
dev = os.lstat(root).st_dev
found, unreadable, stack = [], 0, [root]
while stack:
    d = stack.pop()
    try:
        names = os.listdir(d)
    except OSError:
        unreadable += 1
        continue
    for n in names:
        p = os.path.join(d, n)
        try:
            st = os.lstat(p)
        except OSError:
            continue
        if st.st_dev != dev or p in skip:
            continue
        if stat.S_ISDIR(st.st_mode):
            stack.append(p)
        elif stat.S_ISREG(st.st_mode):
            try:
                get(p, attr, follow_symlinks=False)
                found.append(p)
            except OSError:
                pass
print(json.dumps({"found": found, "unreadable": unreadable}))
`;

/**
 * Files with capabilities from `root`, not crossing into other mounts, `skip` left out (as
 * setIdCheck): "none", or "FOUND <files>". Without python3 the check can't be made: MISSING.
 * `attr` is the attribute looked for (tests look for one of their own).
 */
export function fileCapsCheck(root = "/", skip: string[] = [], attr = CAPS_ATTR): string {
  const r = spawnSync("python3", ["-I", "-c", LOOK, root, attr, ...skip], {
    encoding: "utf8",
    timeout: LOOK_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error) return `MISSING: python3, which reads files' capabilities (${r.error.message})`;
  if (r.status !== 0) return `failed: exit ${r.status ?? r.signal}: ${r.stderr.slice(-300)}`;
  let out: { none?: string; found?: string[]; unreadable?: number };
  try {
    out = JSON.parse(r.stdout) as typeof out;
  } catch {
    return `failed: ${r.stdout.slice(0, 300)}`;
  }
  if (out.none) return `none (${out.none})`;
  const found = out.found ?? [];
  if (found.length)
    return `FOUND ${found.length} files with capabilities: ${found.slice(0, 10).join(", ")}${found.length > 10 ? ", ..." : ""}`;
  return out.unreadable ? `none (${out.unreadable} folders not readable)` : "none";
}
