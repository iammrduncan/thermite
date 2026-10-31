/**
 * Which Thermite a process runs, and which version of the contract between control and a rig it
 * speaks. Control, the harness and the supervisor each report theirs: the harness in its signed
 * report's summary (`build`), the supervisor in headers on every call to control. Control compares
 * them with its own, marks a rig that is behind, and refuses one it cannot work with.
 */

/**
 * The version of the contract between control and a rig (routes, reports, signed commands). It
 * goes up only for a change one side cannot handle from the other.
 */
export const PROTOCOL = 1;

/**
 * The oldest protocol of the other side this build still works with. When PROTOCOL goes up, this
 * stays at the protocol before it for at least one release: an update of control must never cut
 * off the rigs that still run the build before it (version.test.ts checks it).
 */
export const OLDEST_PROTOCOL = 1;

/** This process's own build. */
export interface BuildInfo {
  /** Thermite's version, from package.json. */
  version: string;
  /** The source commit the image was built from (THERMITE_COMMIT), or null when not given. */
  commit: string | null;
  /** The protocol this build speaks. */
  protocol: number;
  /** The oldest protocol of the other side this build works with. */
  oldest_protocol: number;
}

/** A build as another process reported it: any part it did not send, or sent malformed, is null. */
export interface ReportedBuild {
  version: string | null;
  commit: string | null;
  protocol: number | null;
  oldest_protocol: number | null;
}

/** The headers a supervisor sends its build in, on every call to control. */
export const BUILD_HEADERS = {
  version: "x-thermite-version",
  commit: "x-thermite-commit",
  protocol: "x-thermite-protocol",
  oldest_protocol: "x-thermite-oldest-protocol",
} as const;

const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const COMMIT = /^[0-9a-f]{7,64}$/;

const readVersion = (v: unknown): string | null =>
  typeof v === "string" && VERSION.test(v.trim()) ? v.trim() : null;
const readCommit = (v: unknown): string | null =>
  typeof v === "string" && COMMIT.test(v.trim().toLowerCase()) ? v.trim().toLowerCase() : null;
const readProtocol = (v: unknown): number | null => {
  const n = typeof v === "string" && /^\d{1,6}$/.test(v.trim()) ? Number(v.trim()) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 999_999 ? n : null;
};

/**
 * A build from the version in package.json and the commit in THERMITE_COMMIT, as given (this
 * process's own is read in common/build-info.ts). A version Thermite cannot report is refused.
 */
export function buildOf(version: unknown, commit: unknown): BuildInfo {
  const v = readVersion(version);
  if (!v) throw new Error("package.json has no version Thermite can report");
  return {
    version: v,
    commit: readCommit(commit),
    protocol: PROTOCOL,
    oldest_protocol: OLDEST_PROTOCOL,
  };
}

/** A build as headers, for the supervisor's calls to control. */
export function buildHeaders(b: BuildInfo): Record<string, string> {
  return {
    [BUILD_HEADERS.version]: b.version,
    ...(b.commit ? { [BUILD_HEADERS.commit]: b.commit } : {}),
    [BUILD_HEADERS.protocol]: String(b.protocol),
    [BUILD_HEADERS.oldest_protocol]: String(b.oldest_protocol),
  };
}

/** The build a request's headers carry; null when it carries none (a build before versions). */
export function buildFromHeaders(get: (name: string) => string | undefined): ReportedBuild | null {
  return readBuild({
    version: get(BUILD_HEADERS.version),
    commit: get(BUILD_HEADERS.commit),
    protocol: get(BUILD_HEADERS.protocol),
    oldest_protocol: get(BUILD_HEADERS.oldest_protocol),
  });
}

/** Reads a reported build loosely: a malformed part is unknown, never trusted. Null: none at all. */
export function readBuild(x: unknown): ReportedBuild | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const b: ReportedBuild = {
    version: readVersion(o.version),
    commit: readCommit(o.commit),
    protocol: readProtocol(o.protocol),
    oldest_protocol: readProtocol(o.oldest_protocol),
  };
  return b.version === null && b.protocol === null && b.commit === null ? null : b;
}

/**
 * Orders two Thermite versions (semantic versions: 0.2.0 is after 0.1.9, 0.2.0-rc.1 before 0.2.0).
 * Null when either is not a semantic version.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v);
    return m
      ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4]?.split(".") ?? [] }
      : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] as number) - (y.core[i] as number);
    if (d) return sign(d);
  }
  // A pre-release comes before its release.
  if (!x.pre.length || !y.pre.length) return sign(y.pre.length - x.pre.length);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return sign(Number(p) - Number(q));
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** "protocol 1", or "protocols 1 to 2". */
function range(oldest: number, newest: number): string {
  return oldest >= newest ? `protocol ${newest}` : `protocols ${oldest} to ${newest}`;
}

/**
 * Why `ours` cannot work with `theirs`, in plain words, or null when it can. A protocol that is
 * not known (a build from before versions, or a malformed one) is never a reason: only two known
 * protocols that do not meet are.
 */
export function incompatibility(
  ours: Pick<BuildInfo, "protocol" | "oldest_protocol">,
  theirs: Pick<ReportedBuild, "protocol" | "oldest_protocol"> | null,
): { reason: string; update: "rig" | "control" } | null {
  if (!theirs || theirs.protocol === null) return null;
  if (theirs.protocol < ours.oldest_protocol)
    return {
      reason: `speaks protocol ${theirs.protocol}, and control works with ${range(ours.oldest_protocol, ours.protocol)}`,
      update: "rig",
    };
  if (theirs.oldest_protocol !== null && theirs.oldest_protocol > ours.protocol)
    return {
      reason: `works with protocol ${theirs.oldest_protocol} or later, and control speaks protocol ${ours.protocol}`,
      update: "control",
    };
  return null;
}
