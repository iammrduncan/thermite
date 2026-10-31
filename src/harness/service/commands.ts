import { errorText, Refusal } from "../../common/errors.ts";
import {
  CommandPayloads,
  type Envelope,
  OWNER_ONLY_KINDS,
  verifyCommand,
} from "../../core/commands.ts";
import { researchDirectionRefusal } from "../../core/directions.ts";
import { typesIntoTerminals } from "../../core/terminal-input.ts";
import { endWait } from "../agents/index.ts";
import { Conclusions } from "../conclusions.ts";
import { LedgerError } from "../ledger/index.ts";
import { receivePropagation } from "../propagation.ts";
import type { Experiment } from "../queue.ts";
import { RESEARCH_REVIEW, setHypothesisStatus } from "../research/index.ts";
import { Reviews } from "../reviews.ts";
import { assignCampaign } from "./assignment.ts";
import { approvePromotion, declinePromotion } from "./champion.ts";
import type { RigCheckRunner } from "./checks.ts";
import { askStop, drainCommand } from "./drain.ts";
import type { HarnessService } from "./index.ts";
import { invalidateEvidence } from "./invalidation.ts";
import { conflictCheck, unknownIn } from "./rules.ts";
import { decidingRun, openRun, pauseOthers, requireRun } from "./runs.ts";
import { requestWipe } from "./wipe.ts";

export type CommandOutcome =
  | { status: "applied" | "replayed"; accepted: boolean; result: unknown }
  | { status: "rejected"; reason: string }
  /** The same command is being applied by another request; ask again later. */
  | { status: "in_progress" };

/** What a queue command did, as its result: the experiment, its state and its place. */
const queueResult = (x: Experiment) => ({ experiment: x.id, state: x.state, position: x.place });

/**
 * Control's signed commands, as the harness applies them: each checked against control's key,
 * applied once, and recorded with its result (the service holds one).
 */
export class Commands {
  private readonly svc: HarnessService;
  private readonly controlPublicKeyPem: string;
  private readonly checks: RigCheckRunner;
  /** Commands being applied right now, so a concurrent re-send cannot run one twice. */
  private readonly inFlight = new Set<string>();

  constructor(svc: HarnessService, controlPublicKeyPem: string, checks: RigCheckRunner) {
    this.svc = svc;
    this.controlPublicKeyPem = controlPublicKeyPem;
    this.checks = checks;
  }

  /** Whether control signed the command for this rig, now, with a payload that fits its kind. */
  checkCommand(input: unknown): { ok: true } | { ok: false; reason: string } {
    const verified = verifyCommand(input, this.controlPublicKeyPem, this.svc.rig, this.svc.clock());
    return verified.ok ? { ok: true } : { ok: false, reason: verified.reason };
  }

  /**
   * A command checked before it is applied or recorded: its outcome when it is refused or was
   * recorded before, else its envelope and payload. A refusal is a `command_rejected` event.
   */
  private admit(
    input: unknown,
    actor: string,
  ): { outcome: CommandOutcome } | { envelope: Envelope; payload: unknown } {
    const svc = this.svc;
    const verified = verifyCommand(input, this.controlPublicKeyPem, svc.rig, svc.clock());
    if (!verified.ok && verified.authenticId) {
      // Authentic but expired (or otherwise late): if it was applied before, report that.
      const prior = svc.ledger.commands.get(verified.authenticId);
      if (prior) return { outcome: { status: "replayed", ...prior } };
    }
    if (!verified.ok) {
      // Its id when it has one, so control can match the refusal to the command it sent.
      const e = (input as { envelope?: { kind?: unknown; id?: unknown } })?.envelope;
      svc.ledger.appendEvent(actor, "command_rejected", null, {
        reason: verified.reason,
        kind: typeof e?.kind === "string" ? e.kind : null,
        id: typeof e?.id === "string" ? e.id : null,
      });
      return { outcome: { status: "rejected", reason: verified.reason } };
    }
    const { envelope, payload } = verified;
    const prior = svc.ledger.commands.get(envelope.id);
    if (prior) return { outcome: { status: "replayed", ...prior } };
    // After a wipe, commands signed for the old ledger are not applied to the new one.
    const notBefore = svc.ledger.notBefore();
    if (notBefore && Date.parse(envelope.issued_at) < Date.parse(notBefore)) {
      svc.ledger.appendEvent(actor, "command_rejected", null, {
        reason: "issued before this rig's state was wiped",
        kind: envelope.kind,
        id: envelope.id,
      });
      return {
        outcome: { status: "rejected", reason: "issued before this rig's state was wiped" },
      };
    }
    return { envelope, payload };
  }

  /**
   * A command whose content its supervisor could not stage: checked as any command is, then
   * recorded as not applied, with the supervisor's reason as its result, so that its `command`
   * event tells control. One recorded before answers with its record; one being applied now
   * waits.
   */
  recordUnstaged(input: unknown, reason: string, actor: string): CommandOutcome {
    const admitted = this.admit(input, actor);
    if ("outcome" in admitted) return admitted.outcome;
    const { envelope } = admitted;
    if (this.inFlight.has(envelope.id)) return { status: "in_progress" };
    const result = { error: reason };
    this.svc.ledger.commands.record({
      id: envelope.id,
      kind: envelope.kind,
      envelope,
      signature: (input as { signature: string }).signature,
      accepted: false,
      result,
      actor: `control:${envelope.issued_by}`,
    });
    return { status: "applied", accepted: false, result };
  }

  async applyCommand(input: unknown, actor: string): Promise<CommandOutcome> {
    const svc = this.svc;
    const admitted = this.admit(input, actor);
    if ("outcome" in admitted) return admitted.outcome;
    const { envelope, payload } = admitted;
    if (this.inFlight.has(envelope.id)) return { status: "in_progress" };

    this.inFlight.add(envelope.id);
    let accepted = true;
    let result: unknown;
    try {
      result = await this.execute(envelope, payload);
    } catch (err) {
      accepted = false;
      result = { error: errorText(err) };
    } finally {
      this.inFlight.delete(envelope.id);
    }
    svc.ledger.commands.record({
      id: envelope.id,
      kind: envelope.kind,
      envelope,
      signature: (input as { signature: string }).signature,
      accepted,
      result,
      actor: `control:${envelope.issued_by}`,
    });
    return { status: "applied", accepted, result };
  }

  private async execute(envelope: Envelope, payload: unknown): Promise<unknown> {
    const svc = this.svc;
    const by = `control:${envelope.issued_by}`;
    // The owner's gates: control signs who issued a command, and only the owner (not an agent
    // with an API or MCP token) approves promotions, accepts reviews and endings, and wipes.
    if (
      OWNER_ONLY_KINDS.has(envelope.kind) &&
      envelope.issued_by !== "owner" &&
      !envelope.issued_by.startsWith("owner:")
    ) {
      throw new Refusal(`${envelope.kind} is the owner's to issue, not ${envelope.issued_by}'s`);
    }
    switch (envelope.kind) {
      case "assign_campaign":
        return assignCampaign(svc, CommandPayloads.assign_campaign.parse(payload), by);
      case "rig_check":
        return this.checks.start(CommandPayloads.rig_check.parse(payload), by);
      case "drain_rig":
        return drainCommand(svc, CommandPayloads.drain_rig.parse(payload), by, svc.clock());
      case "stop_trial":
        return askStop(svc.ledger, CommandPayloads.stop_trial.parse(payload), by);
      // The owner ends a run's wait for its provider's limit: new trials and plans start at once.
      case "end_wait": {
        const p = CommandPayloads.end_wait.parse(payload);
        if (requireRun(svc.ledger, p.run).status === "closed")
          throw new Refusal(`run ${p.run} is closed`);
        const r = endWait(svc.ledger, p.run, by, svc.clock().getTime());
        if (r.ended)
          svc.live.append({
            source: "planner",
            kind: "status",
            text: `the wait for the provider's limit (until ${r.until}) was ended by hand: new trials and plans start again`,
            run: p.run,
          });
        return r;
      }
      // The owner's input into a trial's terminal (goal 169): the owner's own, never an operator's.
      case "terminal_input":
        if (!typesIntoTerminals(envelope.issued_by))
          throw new Refusal(
            `terminal_input is the owner's own to issue, not ${envelope.issued_by}'s: an operator may message the agents instead`,
          );
        return svc.consoles.input(CommandPayloads.terminal_input.parse(payload), envelope.id, by);
      case "pause_run": {
        const p = CommandPayloads.pause_run.parse(payload);
        // A closed run stays closed: a pause would let a resume open it again.
        if (requireRun(svc.ledger, p.run).status === "closed")
          throw new Refusal(`run ${p.run} is closed`);
        svc.ledger.runs.setStatus(p.run, "paused", p.reason, by);
        return { run: p.run, status: "paused" };
      }
      case "resume_run": {
        const p = CommandPayloads.resume_run.parse(payload);
        const inst = requireRun(svc.ledger, p.run);
        if (inst.status === "closed") throw new Refusal(`run ${p.run} is closed`);
        // One running run per rig: resuming one pauses the others.
        svc.ledger.tx(() => {
          pauseOthers(svc.ledger, p.run, by);
          svc.ledger.runs.setStatus(p.run, "running", null, by);
        });
        return { run: p.run, status: "running" };
      }
      case "close_run": {
        // The owner ends a run for good (goal 087), as goal completion does: the run is closed
        // with the reason. The scheduler stops its trials and planner call as for a pause, the
        // judge leases only running runs' jobs, and a closed run is never resumed.
        const p = CommandPayloads.close_run.parse(payload);
        const inst = requireRun(svc.ledger, p.run);
        if (inst.status === "closed")
          throw new LedgerError(
            "conflict",
            `run ${p.run} is already closed${inst.pause_reason ? ` (${inst.pause_reason})` : ""}: there is nothing to close`,
          );
        svc.ledger.runs.setStatus(p.run, "closed", p.reason, by);
        return { run: p.run, status: "closed", was: inst.status };
      }
      case "redirect": {
        const p = CommandPayloads.redirect.parse(payload);
        openRun(svc.ledger, p.run);
        conflictCheck(p.directives);
        // A direction the run doesn't have yet is the planner's to design at its next round
        // (goal 066). A research run's planner designs no direction: it takes only its task kinds.
        const known = svc.queue.directions(p.run);
        const unknown = unknownIn(p.directives, known);
        if (unknown.length && svc.contractFor(p.run).mode === "research")
          throw new LedgerError("invalid", researchDirectionRefusal(unknown));
        const ids = svc.ledger.directives.addSet(p.run, by, p.directives, p.replace);
        return {
          run: p.run,
          directives: ids,
          ...(unknown.length ? { new_directions: unknown } : {}),
        };
      }
      case "message_agent":
        return svc.messages.send(CommandPayloads.message_agent.parse(payload), by);
      case "unkeep_message": {
        const p = CommandPayloads.unkeep_message.parse(payload);
        requireRun(svc.ledger, p.run);
        return svc.messages.unkeep(p.run, p.message, by);
      }
      // The owner's changes to a run's experiment queue: each refused in plain words when the
      // experiment is unknown or in the wrong state.
      case "queue_add": {
        const p = CommandPayloads.queue_add.parse(payload);
        openRun(svc.ledger, p.run);
        const x = svc.queue.add(
          p.run,
          {
            title: p.title,
            details: p.details,
            family: p.family,
            why: p.why,
            by: "owner",
            position: p.position,
          },
          by,
        );
        return queueResult(x);
      }
      case "queue_move": {
        const p = CommandPayloads.queue_move.parse(payload);
        openRun(svc.ledger, p.run);
        return queueResult(svc.queue.move(p.run, p.id, { by: "owner", position: p.position }, by));
      }
      case "queue_edit": {
        const p = CommandPayloads.queue_edit.parse(payload);
        openRun(svc.ledger, p.run);
        const { run, id, ...change } = p;
        return queueResult(svc.queue.edit(run, id, change, { by: "owner" }, by));
      }
      case "queue_drop": {
        const p = CommandPayloads.queue_drop.parse(payload);
        openRun(svc.ledger, p.run);
        return queueResult(svc.queue.drop(p.run, p.id, { by: "owner", why: p.why }, by));
      }
      case "queue_accept": {
        const p = CommandPayloads.queue_accept.parse(payload);
        openRun(svc.ledger, p.run);
        return queueResult(
          svc.queue.accept(p.run, p.id, { by: "owner", position: p.position }, by),
        );
      }
      case "drop_directive": {
        const p = CommandPayloads.drop_directive.parse(payload);
        openRun(svc.ledger, p.run);
        svc.ledger.directives.drop(p.run, p.id, by);
        return { run: p.run, dropped: p.id };
      }
      // A research run's hypothesis promoted, returned to the pool or retired (goal 117): the
      // planner's changes go through the same function.
      case "hypothesis_status": {
        const p = CommandPayloads.hypothesis_status.parse(payload);
        openRun(svc.ledger, p.run);
        if (svc.contractFor(p.run).mode !== "research")
          throw new LedgerError(
            "invalid",
            `run ${p.run} is not a research run: only a research run has hypotheses to promote or retire`,
          );
        const r = setHypothesisStatus(
          svc.ledger,
          p.run,
          { id: p.id, status: p.status, reason: p.reason },
          by,
        );
        if (r.changed) svc.researchChanged?.(p.run);
        return { run: p.run, ...r };
      }
      case "reset_workers": {
        // The scheduler acts on the event: it kills the run's running trials, clears the
        // lane bests and ends the epoch, so lanes start again from the champion.
        const p = CommandPayloads.reset_workers.parse(payload);
        requireRun(svc.ledger, p.run);
        if (p.reseed_commit)
          throw new Refusal("re-seeding lanes is not available in this version; reset without it");
        svc.ledger.appendEvent(by, "workers_reset", p.run, {});
        return { run: p.run, reset: true };
      }
      case "propagate":
        return receivePropagation(svc, CommandPayloads.propagate.parse(payload), by);
      case "export_now": {
        const p = CommandPayloads.export_now.parse(payload);
        const r = await svc.export(by, p);
        return {
          export: r.dir.split("/").pop(),
          export_id: r.id,
          through_event: svc.ledger.exports.last()?.through_event ?? 0,
          attempts: r.attempts,
          events: r.events,
        };
      }
      case "wipe_state":
        return requestWipe(svc, CommandPayloads.wipe_state.parse(payload), by, envelope.issued_at);
      case "approve_promotion":
        return approvePromotion(svc, CommandPayloads.approve_promotion.parse(payload), by);
      case "rig_settings": {
        const change = CommandPayloads.rig_settings.parse(payload);
        const now = svc.settings.set(change);
        svc.ledger.appendEvent(by, "rig_settings_changed", null, { change, settings: now });
        return { settings: now };
      }
      case "decline_promotion":
        return declinePromotion(svc.ledger, CommandPayloads.decline_promotion.parse(payload), by);
      case "accept_review": {
        const p = CommandPayloads.accept_review.parse(payload);
        decidingRun(svc.ledger, p.run, "accept_review");
        const row = new Reviews(svc.ledger).ownerDecision(p.review, p.run, p.accept, p.note, by);
        // A research review (goals 112 and 117): accepted, the run writes its paper and ends once
        // its running trials end; not accepted, it goes on, and the review panel is asked again
        // only when an item has no standing decision. The owner's word goes in the run's journal.
        if (row.goal === RESEARCH_REVIEW) {
          const note = p.note?.trim();
          svc.journal.writeAll(
            p.run,
            [
              {
                kind: "decision",
                text: (p.accept
                  ? `The owner accepted review ${p.review}: every question has an end and every required hypothesis a verdict. The run writes its paper and final report, and ends once its running trials end.${note ? ` The owner's note: ${note}` : ""}`
                  : `The owner did not accept review ${p.review}. The run goes on; the review panel is asked again when a question's answer card changes.${note ? ` The owner's note: ${note}` : ""}`
                ).slice(0, 2000),
              },
            ],
            { by: "owner", actor: by, source: "supervisor" },
          );
          return { review: p.review, decision: p.accept ? "accepted" : "rejected" };
        }
        // The goal tree is checked again with the owner's word.
        svc.ledger.jobs.enqueue({
          kind: "validate",
          priority: 40,
          spec: { run: p.run },
          actor: by,
        });
        return { review: p.review, decision: p.accept ? "accepted" : "rejected" };
      }
      case "conclude": {
        const p = CommandPayloads.conclude.parse(payload);
        decidingRun(svc.ledger, p.run, "conclude");
        return new Conclusions(svc.ledger).decide(p.run, p.proposal, p.accept, p.note, by);
      }
      // The owner withdraws bad evidence (goal 174): a preview, or the withdrawal it previewed.
      case "invalidate_evidence":
        return invalidateEvidence(
          svc,
          CommandPayloads.invalidate_evidence.parse(payload),
          envelope.issued_by,
          by,
        );
    }
  }
}
