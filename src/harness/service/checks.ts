import { randomUUID } from "node:crypto";
import { log } from "../../common/env.ts";
import { errorText, Refusal } from "../../common/errors.ts";
import type { ControlRoute, ModelInfo, RigCheckReport } from "../agents/index.ts";
import type { Ledger } from "../ledger/index.ts";
import type { HarnessService } from "./index.ts";

/**
 * The rig checks (model, isolation, smoke): the controller wires in those the rig can run
 * (main.ts), and they run one at a time in the background, each reporting as an event. A new
 * model route is checked at once.
 */

export type RigCheckName = "model" | "isolation" | "smoke";

export interface RigCheck {
  /** Why the check cannot start now (for example a busy rig), if it cannot. */
  notNow?: (() => string | undefined) | undefined;
  run: (opts: { force: boolean }) => Promise<RigCheckReport>;
}

/** The checks as they run, one at a time (the service holds one). */
export class RigCheckRunner {
  private readonly svc: {
    ledger: Ledger;
    rigChecks: Partial<Record<RigCheckName, RigCheck>>;
  };
  private checking: string | undefined;

  constructor(svc: { ledger: Ledger; rigChecks: Partial<Record<RigCheckName, RigCheck>> }) {
    this.svc = svc;
  }

  start(p: { check: RigCheckName; force?: boolean | undefined }, by: string) {
    const check = this.svc.rigChecks[p.check];
    if (!check) throw new Refusal(`this rig cannot run the ${p.check} check`);
    if (this.checking) throw new Refusal(`the ${this.checking} check is still running`);
    const force = p.force === true;
    const notNow = force ? undefined : check.notNow?.();
    if (notNow) throw new Refusal(`not now: ${notNow}`);
    const id = `chk-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    this.checking = p.check;
    this.svc.ledger.appendEvent(by, "rig_check_started", null, { id, check: p.check, force });
    const finish = (r: RigCheckReport) => {
      // The details stay bounded: an isolation report lists every probe of every role.
      const detail = r.detail ? JSON.stringify(r.detail) : undefined;
      this.svc.ledger.appendEvent("harness", "rig_check_finished", null, {
        id,
        check: p.check,
        ok: r.ok,
        summary: r.summary.slice(0, 2000),
        ...(r.note ? { note: r.note } : {}),
        ...(detail
          ? { detail: detail.length > 60_000 ? `${detail.slice(0, 60_000)}…` : r.detail }
          : {}),
      });
    };
    this.checkRun = check
      .run({ force })
      .then(finish, (err: unknown) => finish({ ok: false, summary: errorText(err) }))
      .finally(() => {
        this.checking = undefined;
        // A model route that arrived during another check is checked now.
        if (this.modelCheckWaits && this.svc.rigChecks.model) {
          this.modelCheckWaits = false;
          this.start({ check: "model" }, "harness");
        }
      });
    return { check: p.check, id, started: true };
  }
  private checkRun: Promise<void> | undefined;
  private modelCheckWaits = false;

  /** A new model route: checked at once, or when the check that runs now ends. */
  checkNewModel(): void {
    if (this.checking) this.modelCheckWaits = true;
    else this.start({ check: "model" }, "harness");
  }

  /** Whether a rig check runs now (a model check would have to wait). */
  modelCheckRunning(): boolean {
    return this.checking !== undefined;
  }

  /**
   * Checks the workers' model now, unless a check runs or this rig has none (goal 079: the
   * scheduler checks again while the agents are stopped). True when it started one.
   */
  checkModelNow(by: string): boolean {
    if (!this.svc.rigChecks.model || this.checking) return false;
    try {
      this.start({ check: "model" }, by);
      return true;
    } catch (err) {
      log("harness", "the model check did not start", { error: String(err) });
      return false;
    }
  }

  /**
   * A check at start, run before anything else and awaited. Forced: at start no trial or judge
   * job of this controller can be running. Never fatal: its result is its own event.
   */
  async checkAtStart(check: RigCheckName): Promise<void> {
    if (!this.svc.rigChecks[check]) return;
    this.start({ check, force: true }, "harness");
    await this.checkRun;
  }
}

/**
 * Takes the model route control set for this rig, or (null) goes back to the rig's own
 * settings. The record names the route, never its key. New plans and trials use it.
 */
export function setModelRoute(
  svc: HarnessService,
  checks: RigCheckRunner,
  route: ControlRoute | null,
  by: string,
  planner?: ControlRoute | null | undefined,
): ModelInfo {
  if (!svc.models) throw new Refusal("this harness runs no agents");
  if (planner !== undefined) svc.models.setPlanner(planner);
  if (route) svc.models.set(route);
  else svc.models.clear();
  const info = svc.models.info();
  svc.ledger.appendEvent(by, route ? "model_route_set" : "model_route_cleared", null, {
    ...info,
  });
  // A new model is checked at once (unless a check is running): its result shows on the
  // settings page without anyone pressing Check.
  if (info.source !== "none" && svc.rigChecks.model) checks.checkNewModel();
  return info;
}

/**
 * After a restart: a check that was running when the controller stopped is over, and says so;
 * a smoke run it left open is closed. Runs the smoke paused stay paused for the operator.
 */
export function reconcileRigChecks(ledger: Ledger): void {
  const open = new Map<string, string>();
  for (const e of ledger.events.list(["rig_check_started", "rig_check_finished"])) {
    const { id, check } = e.body;
    if (e.kind === "rig_check_started" && id) open.set(id, check ?? "");
    if (e.kind === "rig_check_finished" && id) open.delete(id);
  }
  for (const [id, check] of open) {
    ledger.appendEvent("harness", "rig_check_finished", null, {
      id,
      check,
      ok: false,
      summary:
        "interrupted: the controller restarted during the check (runs it paused stay paused)",
    });
  }
  for (const r of ledger.runs.list()) {
    if (r.id.startsWith("check-smoke-") && r.status !== "closed")
      ledger.runs.setStatus(r.id, "closed", "its smoke check was interrupted", "harness");
  }
}
