import {
  type BuildInfo,
  compareVersions,
  incompatibility,
  type ReportedBuild,
} from "../core/version.ts";
import type { ControlStore, RigComponent, RigRefusal, StoredBuild } from "./store/index.ts";

/**
 * Control's view of each rig's builds against its own: it records what the rig's harness and
 * supervisor report, marks a rig that runs an older or newer Thermite, and refuses a rig whose
 * protocol and control's do not meet. A part that reports no version (a build from before version
 * checks) is unknown: shown, never refused.
 */

/**
 * current: the rig runs control's version. behind or ahead: an older or a newer version that
 * control still works with. unknown: a part sends no version, or one control cannot compare.
 * refused: control cannot work with the rig, and refuses its reports and commands.
 */
export type VersionState = "current" | "behind" | "ahead" | "unknown" | "refused";

export interface RigVersions {
  state: VersionState;
  /** What the owner should know, in plain words; null when the rig runs control's version. */
  notice: string | null;
  /**
   * Why control refuses the rig, and since when, with how many of its calls control refused since
   * and when the last came; null when it does not.
   */
  refused: RigRefusal | null;
  /** Control's own build, which the rig is compared with. */
  control: BuildInfo;
  /** What each part last reported, and since when; null when it reported no version. */
  harness: StoredBuild | null;
  supervisor: StoredBuild | null;
}

const PARTS: readonly RigComponent[] = ["harness", "supervisor"];

/**
 * Why control cannot work with a rig whose parts report these builds, in plain words, or null
 * when it can. Only known protocols that do not meet are a reason.
 */
export function refusalFor(
  control: BuildInfo,
  builds: Partial<Record<RigComponent, ReportedBuild | null | undefined>>,
): string | null {
  for (const part of PARTS) {
    const why = incompatibility(control, builds[part] ?? null);
    if (why)
      return `Control cannot work with this rig: its ${part} ${why.reason}. ${
        why.update === "rig" ? "Update the rig's images." : "Update control."
      }`;
  }
  return null;
}

const plain = (b: ReportedBuild | null | undefined) =>
  b
    ? {
        version: b.version,
        commit: b.commit,
        protocol: b.protocol,
        oldest_protocol: b.oldest_protocol,
      }
    : null;

/** What the audit log keeps with a refusal: control's build and the rig's. */
function auditDetail(store: ControlStore, rig: string, control: BuildInfo) {
  return {
    control: plain(control),
    harness: plain(store.builds.ofRig(rig, "harness")),
    supervisor: plain(store.builds.ofRig(rig, "supervisor")),
  };
}

/**
 * Refuses the rig while its recorded builds and control's do not meet, or ends its refusal when
 * they do. Returns the reason, or null. `harness` stands in for the recorded harness build, and
 * `endRefusal: false` only adds a refusal: for a report, whose own harness build control checks
 * once the report verifies (ingest.ts).
 */
export function checkRig(
  store: ControlStore,
  rig: string,
  control: BuildInfo,
  opts: { harness?: ReportedBuild | null; endRefusal?: boolean } = {},
): string | null {
  const reason = refusalFor(control, {
    harness: "harness" in opts ? opts.harness : store.builds.ofRig(rig, "harness"),
    supervisor: store.builds.ofRig(rig, "supervisor"),
  });
  // Most calls change nothing: a rig that is not refused, and stays so.
  const change = reason ? store.refusals.get(rig)?.reason !== reason : opts.endRefusal !== false;
  if (change && (reason || store.refusals.get(rig)))
    store.refusals.set(rig, reason, auditDetail(store, rig, control));
  return reason;
}

/**
 * Checks every refused rig again against this control's build: after an update of control, a rig
 * it can now work with is no longer refused, before the rig calls again.
 */
export function recheckRefusals(store: ControlStore, control: BuildInfo): void {
  for (const rig of store.refusals.rigs()) checkRig(store, rig, control);
}

/** "harness 0.1.0, supervisor 0.1.0". */
function describe(builds: Record<RigComponent, StoredBuild | null>): string {
  return PARTS.map((p) => `${p} ${builds[p]?.version ?? "with no version"}`).join(", ");
}

/** A rig's builds against control's, with what the owner should know. */
export function rigVersions(store: ControlStore, rig: string, control: BuildInfo): RigVersions {
  const builds = {
    harness: store.builds.ofRig(rig, "harness") ?? null,
    supervisor: store.builds.ofRig(rig, "supervisor") ?? null,
  };
  const refused = store.refusals.get(rig) ?? null;
  const base = { refused, control, ...builds };
  if (refused) return { state: "refused", notice: refused.reason, ...base };
  const order = PARTS.map((p) => {
    const v = builds[p]?.version;
    return v ? compareVersions(v, control.version) : null;
  });
  const runs = `This rig runs`;
  const still = "Control still works with it.";
  if (order.includes(-1))
    return {
      state: "behind",
      notice: `${runs} an older Thermite than control: ${describe(builds)}. Control runs ${control.version}. ${still} Update the rig's images.`,
      ...base,
    };
  if (order.includes(null)) {
    const silent = PARTS.filter((p) => !builds[p]?.version);
    const odd = PARTS.filter((p, i) => builds[p]?.version && order[i] === null);
    const words: string[] = [];
    if (silent.length)
      words.push(
        silent.length === 2
          ? "The rig's harness and supervisor send no version. Their images are older than version checks."
          : `The rig's ${silent[0]} sends no version. Its image is older than version checks.`,
      );
    for (const p of odd)
      words.push(
        `The rig's ${p} reports version ${builds[p]?.version}. Control cannot compare it with its own version, ${control.version}.`,
      );
    return { state: "unknown", notice: `${words.join(" ")} ${still}`, ...base };
  }
  if (order.includes(1))
    return {
      state: "ahead",
      notice: `${runs} a newer Thermite than control: ${describe(builds)}. Control runs ${control.version}. ${still} Update control.`,
      ...base,
    };
  return { state: "current", notice: null, ...base };
}
