import { log, redact } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import type { BuildInfo } from "../../core/version.ts";
import { issueCommand } from "../issue/index.ts";
import type { ControlStore } from "../store/index.ts";
import { type RigView, rigView } from "../views/index.ts";

/**
 * Update to control's version (goal 012, the rig's page): a rig control set up, on a machine or on
 * a cluster, moves onto the images control deploys now. Its runs pause at a safe point first;
 * then its containers move onto the images; then control waits for a report from control's
 * version, runs the rig's isolation check, and resumes the runs it paused. Each step is a step in
 * the rig's history (rig_setup_event), so the rig's page shows them as they happen.
 *
 * A refused rig takes no command, so its runs are not paused: they go on from what the rig kept.
 * A rig that does not report gets the pause too late to matter: the update goes on without it.
 */

/** Where an update moves a rig: what control does there, in its own way. */
export interface UpdateTarget {
  /**
   * Moves the rig onto control's images and restarts it; resolves with what changed, in words.
   * Throws, in words, when it can't: the rig then keeps the images it had.
   */
  apply(): Promise<string>;
}

/** How long each wait of an update lasts at most. */
export interface UpdateWaits {
  /** For the rig to take the pause commands. */
  pause: number;
  /** For a report from control's version. */
  report: number;
  /** For the isolation check's result. */
  isolation: number;
}

export const UPDATE_WAITS: UpdateWaits = {
  pause: 5 * 60_000,
  report: 20 * 60_000,
  isolation: 30 * 60_000,
};

/** The step an update waits in, in words; the rig's page shows it under the steps done. */
type Phase = "pausing" | "applying" | "reporting" | "isolation" | "resuming";
const PHASE_WORDS: Record<Phase, string> = {
  pausing: "Waiting for the rig to pause its runs.",
  applying: "Moving its containers onto control's images.",
  reporting: "Waiting for a report from control's version.",
  isolation: "Waiting for the isolation check.",
  resuming: "Resuming its runs.",
};

/** A rig's version as its parts report it, in words: "0.1.0", or both when they differ. */
export function rigVersionWords(v: RigView["version"]): string {
  const h = v.harness?.version ?? null;
  const s = v.supervisor?.version ?? null;
  if (h && s && h !== s) return `harness ${h}, supervisor ${s}`;
  return h ?? s ?? "no version";
}

export class RigUpdates {
  private readonly o: {
    store: ControlStore;
    privateKeyPem: string;
    control: BuildInfo;
    staleAfterMs: number;
    offlineAfterMs?: number | undefined;
    waits: UpdateWaits;
    pollMs: number;
    sleep: (ms: number) => Promise<void>;
  };

  constructor(o: {
    store: ControlStore;
    privateKeyPem: string;
    control: BuildInfo;
    staleAfterMs: number;
    offlineAfterMs?: number | undefined;
    waits?: Partial<UpdateWaits> | undefined;
    /** How often a wait looks again (default 5 s). */
    pollMs?: number | undefined;
    sleep?: ((ms: number) => Promise<void>) | undefined;
  }) {
    this.o = {
      store: o.store,
      privateKeyPem: o.privateKeyPem,
      control: o.control,
      staleAfterMs: o.staleAfterMs,
      offlineAfterMs: o.offlineAfterMs,
      waits: { ...UPDATE_WAITS, ...(o.waits ?? {}) },
      pollMs: o.pollMs ?? 5000,
      // The waits never keep control (or a test) from exiting.
      sleep: o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref())),
    };
  }

  /** What the update under way on this rig waits for, in words; null when none is under way. */
  waiting(rig: string): string | null {
    const p = this.row(rig)?.phase as Phase | undefined;
    return p ? PHASE_WORDS[p] : null;
  }

  // The update under way on each rig is kept in the store, with the runs it paused (goal 165).
  private row(rig: string) {
    return this.o.store.rigUpdates.get(rig);
  }

  private setPhase(rig: string, phase: Phase, paused?: string[]): void {
    const at = new Date().toISOString();
    this.o.store.rigUpdates.setPhase(rig, phase, paused ? JSON.stringify(paused) : null, at);
  }

  /**
   * At control's start: an update a restart of control cut short ends, and the runs it paused
   * resume, with why in the rig's history (goal 165). Its target can't be asked again, so the
   * update is the owner's to ask again from the rig's page.
   */
  endUnfinished(): void {
    const left = this.o.store.rigUpdates.list();
    for (const u of left) {
      void this.resume(u.rig, JSON.parse(u.paused) as string[], u.requested_by).then(() => {
        const why = `control restarted while it was ${PHASE_WORDS[u.phase as Phase]?.toLowerCase().replace(/\.$/, "") ?? u.phase}: update the rig again from its page`;
        log("control", "rig update ended by a restart", { rig: u.rig, phase: u.phase });
        this.step(u.rig, "update_failed", false, why);
        this.o.store.rigUpdates.end(u.rig);
      });
    }
  }

  private view(rig: string): RigView | undefined {
    return rigView(this.o.store, rig, {
      staleAfterMs: this.o.staleAfterMs,
      offlineAfterMs: this.o.offlineAfterMs,
      control: this.o.control,
    });
  }

  private step(rig: string, step: string, ok: boolean, detail: string): void {
    this.o.store.rigHistory.add(rig, step, ok, detail);
  }

  private issue(
    rig: string,
    kind: "pause_run" | "resume_run" | "rig_check",
    payload: unknown,
    by: string,
    ttlMinutes = 60,
  ): string {
    return issueCommand(this.o.store, this.o.privateKeyPem, {
      rig,
      kind,
      payload,
      ttlMinutes,
      issuedBy: by,
    }).id;
  }

  /** Waits until `done` says so, or `ms` passed; true when it did. */
  private async until(ms: number, done: () => boolean): Promise<boolean> {
    const end = Date.now() + ms;
    for (;;) {
      if (done()) return true;
      if (Date.now() >= end) return false;
      await this.o.sleep(Math.min(this.o.pollMs, Math.max(1, end - Date.now())));
    }
  }

  /**
   * Begins the update of a rig; throws, in words, when one is under way already. The update runs
   * on in the background: the promise it returns ends with it (the tests wait for it).
   */
  begin(rig: string, by: string, target: UpdateTarget): Promise<void> {
    if (this.row(rig))
      throw new Error(`An update of ${rig} is under way: wait until its steps end.`);
    const at = new Date().toISOString();
    this.o.store.rigUpdates.begin(rig, by, at);
    return this.run(rig, by, target)
      .catch((err) => {
        const why = redact(errorText(err));
        log("control", "rig update failed", { rig, error: why }, "error");
        this.step(rig, "update_failed", false, why);
      })
      .finally(() => this.o.store.rigUpdates.end(rig));
  }

  private async run(rig: string, by: string, target: UpdateTarget): Promise<void> {
    const to = this.o.control.version;
    const before = this.view(rig);
    this.step(
      rig,
      "update_started",
      true,
      `from ${before ? rigVersionWords(before.version) : "no version"} to ${to}, asked by ${by}`,
    );
    // 1. Pause the running runs, when the rig can take a command.
    const refused = this.o.store.refusals.get(rig);
    let paused: string[] = [];
    if (refused)
      this.step(
        rig,
        "update_paused",
        true,
        "not paused: control sends no command to a refused rig, so its runs go on from what the rig kept",
      );
    else if (before?.state !== "reporting")
      this.step(
        rig,
        "update_paused",
        true,
        "not paused: the rig does not report, so a pause could not reach it",
      );
    else {
      const running = before.runs.filter((r) => r.status === "running").map((r) => r.id);
      const ids = running.map((run) =>
        this.issue(rig, "pause_run", { run, reason: `control updates the rig to ${to}` }, by),
      );
      paused = running;
      this.setPhase(rig, "pausing", paused);
      const took = await this.until(this.o.waits.pause, () =>
        ids.every((id) => this.o.store.commands.get(id)?.status !== "pending"),
      );
      this.step(
        rig,
        "update_paused",
        took,
        running.length === 0
          ? "no run was running"
          : took
            ? `runs paused: ${running.join(", ")}`
            : `the rig did not take the pause within ${Math.round(this.o.waits.pause / 60_000)} minutes: the update goes on, and the runs pause when it takes it`,
      );
    }
    // 2. Move its containers onto control's images.
    this.setPhase(rig, "applying");
    const appliedAt = Date.now();
    try {
      this.step(rig, "update_images", true, await target.apply());
    } catch (err) {
      const why = redact(errorText(err));
      this.step(rig, "update_images", false, `${why}. The rig keeps the images it had`);
      await this.resume(rig, paused, by);
      this.step(rig, "update_failed", false, "its containers could not move onto control's images");
      return;
    }
    // 3. A report from control's version.
    this.setPhase(rig, "reporting");
    let seen: RigView | undefined;
    const current = await this.until(this.o.waits.report, () => {
      seen = this.view(rig);
      return Boolean(
        seen &&
          Date.parse(seen.last_seen) >= appliedAt &&
          seen.version.state === "current" &&
          seen.version.harness?.version === to,
      );
    });
    if (!current) {
      const after = seen && Date.parse(seen.last_seen) >= appliedAt;
      this.step(
        rig,
        "update_reported",
        false,
        after && seen
          ? `it reports ${rigVersionWords(seen.version)}, not ${to}: the images control deploys may not be ${to}'s`
          : `no report from ${to} within ${Math.round(this.o.waits.report / 60_000)} minutes: it may not have started`,
      );
      await this.resume(rig, paused, by);
      this.step(rig, "update_failed", false, `no report from Thermite ${to}`);
      return;
    }
    this.step(rig, "update_reported", true, `it runs Thermite ${to}`);
    // 4. Its isolation check, on the new images.
    this.setPhase(rig, "isolation");
    // The check before this one, if any: the result wanted is a newer one (the rig's own clock
    // stamps it, so it is told apart by its start, not compared with control's time).
    const earlier = this.view(rig)?.checks.isolation?.started_at ?? null;
    try {
      const id = this.issue(rig, "rig_check", { check: "isolation" }, by);
      let summary = "";
      let passed: boolean | null = null;
      // The rig may refuse the check (a busy rig, say): its command then fails, with why.
      let refused: string | null = null;
      const ended = await this.until(this.o.waits.isolation, () => {
        const cmd = this.o.store.commands.get(id);
        if (cmd && cmd.status !== "pending" && cmd.status !== "delivered") {
          const why = (cmd.outcome as { error?: unknown } | null)?.error;
          refused = typeof why === "string" && why ? why : `its command ${cmd.status}`;
          return true;
        }
        const c = this.view(rig)?.checks.isolation;
        if (!c?.finished_at || c.started_at === earlier) return false;
        passed = c.ok === true;
        summary = c.summary ?? "";
        return true;
      });
      this.step(
        rig,
        "update_isolation",
        ended && !refused && passed === true,
        refused
          ? `not run: ${redact(refused)}`
          : !ended
            ? `no result within ${Math.round(this.o.waits.isolation / 60_000)} minutes`
            : `${passed ? "passed" : "failed"}${summary ? `: ${summary}` : ""}`,
      );
    } catch (err) {
      this.step(rig, "update_isolation", false, `not asked: ${redact(errorText(err))}`);
    }
    // 5. The runs it paused go on.
    await this.resume(rig, paused, by);
  }

  /** Resumes the runs the update paused; a step only when it paused some. */
  private async resume(rig: string, runs: string[], by: string): Promise<void> {
    if (!runs.length) return;
    this.setPhase(rig, "resuming");
    const done: string[] = [];
    const failed: string[] = [];
    for (const run of runs) {
      try {
        // A day to deliver: a rig that restarts takes it once it reports again.
        this.issue(rig, "resume_run", { run }, by, 24 * 60);
        done.push(run);
      } catch (err) {
        failed.push(`${run} (${errorText(err)})`);
      }
    }
    this.step(
      rig,
      "update_resumed",
      failed.length === 0,
      [
        done.length ? `runs resumed: ${done.join(", ")}` : "",
        failed.length ? `not resumed: ${failed.join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("; "),
    );
  }
}
