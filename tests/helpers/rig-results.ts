import type { ControlStore } from "../../src/control/store/index.ts";
import { answerCommand } from "./control-store.ts";

/**
 * A rig's results as control sees them, for tests: the harness's signed answer to an export, and
 * the supervisor sending that export to control. Written straight into control's store, as the
 * rig's acknowledgements, reports and uploads would.
 */

/** An export's name, as the harness makes them. */
export const exportName = (n: number) => `20261020T12${String(n).padStart(4, "0")}Z-0123abcd`;

/** The rig's commands that wait for it, oldest first: [id, kind, payload]. */
export function pendingOf(store: ControlStore, rig: string) {
  return store.commands
    .pending(rig)
    .map((c) => ({ id: c.envelope.id, kind: c.envelope.kind, payload: c.envelope.payload }));
}

/** The harness applied every command waiting for the rig; an export_now makes the export `name`. */
export function harnessApplies(store: ControlStore, rig: string, name: string): void {
  for (const c of pendingOf(store, rig))
    answerCommand(store, rig, c.id, "delivered", {
      source: "harness",
      result: c.kind === "export_now" ? { export: name, through_event: 9 } : {},
    });
}

/** The harness refused the rig's waiting export_now, in its signed outcome. */
export function harnessRefusesExport(store: ControlStore, rig: string): void {
  for (const c of pendingOf(store, rig))
    answerCommand(
      store,
      rig,
      c.id,
      c.kind === "export_now" ? "failed" : "delivered",
      c.kind === "export_now"
        ? { source: "harness", error: "the disk is full" }
        : { source: "harness" },
    );
}

/** The supervisor's export figures in its report: it sends its exports to control. */
export function supervisorReports(
  store: ControlStore,
  rig: string,
  o: { waiting?: number; champions_waiting?: number; to?: "control" | "none" } = {},
): void {
  store.reportedRigs.setSupervisor(rig, {
    at: new Date().toISOString(),
    export: {
      remote: false,
      to: o.to ?? "control",
      exports: 1,
      pushed: [],
      last_push_at: null,
      uploaded: [],
      last_upload_at: null,
      waiting: o.waiting ?? 0,
      champions_waiting: o.champions_waiting ?? 0,
      last_error: null,
    },
  });
}

/** Control holds every file of export `name` from the rig, each checked: it has left the rig. */
export function exportOnControl(store: ControlStore, rig: string, name: string): void {
  store.exports.begin(rig, name, {
    manifest: { from_event: 0, through_event: 9, files: { a: "a".repeat(64) } },
    files: { a: { size: 1, sha256: "a".repeat(64) } },
    full: true,
    fromEvent: 0,
    throughEvent: 9,
  });
  store.exports.fileDone(rig, name, "a");
}
