import { z } from "zod";
import type { CommandKind } from "../../core/commands.ts";
import { ADD_HOURS_MAX } from "../../core/contract.ts";
import { TERMINAL_KEYS } from "../../core/terminal-input.ts";
import { briefingFromKb } from "../briefing.ts";
import { queueFromRecords } from "../campaigns/index.ts";
import {
  addRunHours,
  commandRig,
  issueWaking,
  propagateChampion,
  startTeachersRound,
} from "../issue/index.ts";
import type { ToolContext } from "./context.ts";

/**
 * Signed commands: one issued and a champion propagated (every token but the reader's), and a
 * command's status (every token).
 */
export function registerCommands(tools: ToolContext): void {
  const { server, store, opts, actor, role, canCommand, kinds, audited } = tools;

  if (canCommand) {
    server.registerTool(
      "issue_command",
      {
        title: "Issue a signed command",
        description: `Queue a command for a rig; control signs it and the rig's supervisor relays it. A kind about one run (its payload's run: every kind but assign_campaign, rig_check and export_now) goes to the rig the run is on, which control knows: leave out rig, or give the run's own. Kinds: ${kinds.join(", ")}. The payload must match the kind (for example pause_run {run, reason}; redirect {run, directives:[{kind: avoid|try|mandate|priority|lane_count|trial_minutes|keep_working|open_attempts|planner_note, direction? (the direction, in plain words or as :name:, such as :shared memory tiling:; one the run doesn't have yet is designed by the planner at its next round; run_queue lists the run's directions), value? (lane_count: lanes; trial_minutes: one trial's length in minutes, 1 to 1440, over the contract's; keep_working: on or off, whether lanes keep working while the judge works, over the contract's; open_attempts: how many changes may wait for the judge before the lanes start no new trial, 1 to 1000, over the contract's max_open_attempts, the owner's and an operator's alone), rationale, citations}], replace?: false (add to the rules in force)}; approve_promotion {run, attempt}; export_now {run} (that run alone, with its rig) or {full: true} (the rig's full export, with a snapshot of its ledger), never both; ${role === "owner" ? `close_run {run, reason} (the owner's token only: the run ends for good, nothing more starts and it can't be resumed; its results stay); hypothesis_status {run, id, status: promoted|pool|retired, reason} (the owner's token only: a research run's hypothesis promoted, so the review panel must give it a verdict, back to the pool, or retired; get_run lists them); invalidate_evidence {run, attempt or job, reason, preview: true} (the owner's token only: withdraw bad evidence, an attempt for good with every attempt built on it, or a judge job's measurements, whose attempts are judged again; the preview changes nothing, and its command_status result gives what it would reach, in words, and its sha; then send it again with reach: that sha and no preview to withdraw it; nothing is deleted); terminal_input {run, trial, text or keys: [${TERMINAL_KEYS.join("|")}], wait?: queue|now, confirm?: true, follow_up?: true} (the owner's token only: typed into a running trial's terminal, or a planner's call's, trial planner-RUN-N, while the planner plans round N in its own terminal, text then Enter; while its program waits for its usage window it waits for the reset unless wait is now; text starting with ! or naming /login, /logout, /config or /permissions needs confirm; a worker in Pi takes it in its Pi view: text steers the agent before its next model call, or with follow_up waits until it would stop, the key esc stops its reply, and /status, /compact, /mcp, /mcp reconnect [server] and /skill:NAME are its commands; command_status gives the outcome: typed, queued, or refused with why); ` : ""}${role === "agent" ? "" : "message_agent {run, to: all|lane-N|trial:ID|planner|advisors|teachers|auditor|review_panel, text, keep?: true (all or a lane: kept in force until unkeep_message {run, message})}; queue_add {run, title, details?, direction?, why?, tries?: 1 to 10 (how many trials it gets: a try that ends without a win sends it back to the top, to a lane that has not tried it while one has not; a win ends it), position?: top|end|index (0 first)}; queue_move {run, id, position}; queue_edit {run, id, title?, details?, direction?, why?, tries?}; queue_drop {run, id, why}; queue_accept {run, id, position?} (a lane's idea into the queue); lane_limits {run, limits: {dev_run_rss_mib?, run_rss_mib?, workspace_mib?, dev_run_timeout_s?, run_timeout_s?, processes?}, reason, preview?: true} (a running run's lane limits changed in place, from the next lane command and development run, each within the contract's bounds, or null to go back to the contract's; get_run gives none of them yet: History says each change); acceptance {run, acceptance: {min_effects?: {METRIC: fraction or null}, confirm_blocks?: 2 to 20 or null, futility?: 0.5 to 0.99 or null}, reason, preview?: true} (a running hill climb's acceptance changed in place, from the judge's next screen or confirmation: each metric's minimum effect, such as {prefill_tps: 0.007}, a confirmation's blocks, and the early stop that ends a screen once the primary's one-sided upper bound at that confidence is under its minimum effect, leaving its lower priorities to decide; null goes back to the contract's; History says each change); kit_commit {run, imports: [{kind: kit_bundle, repo: the contract's project.kit.repo, commit, path: an inbox path such as kits/NAME-COMMIT.bundle, source: {control: \"kits/NAME\"} for a kit control keeps (kits lists them) or {git: URL}}], reason, preview?: true} (a running run moved onto a later commit of its kit, from the judge's next job: the rig's supervisor fetches it as an assignment's kit; refused when the commit does not come after the one the run measures with, does not fit the contract, or names other MCP servers; a job under way keeps its kit; History says it); queue_retry {run, id, why, position?: top|end|index, preview?: true} (a tried experiment back to up next, such as one a fault of Thermite's cut short: its trial kept as an earlier try, one more try when its tries are used; refused for one still with the judge and in a research run; with preview: true, it changes nothing and its command_status result says what it would do, in words); drop_directive {run, id} (a rule in force, whoever set it); stop_trial {run, trial, reason?} (one running trial ends as interrupted, and its experiment goes back to the top of the queue; run_queue's at_work gives each lane's trial); end_wait {run} (ends the run's wait for its provider's limit now, which get_run gives as agents_wait: its new trials and plans start at once; a trial waiting in its own conversation goes on at its own time); start_teachers_round {run} (the run's teachers review it now: see the start_teachers_round tool); add_run_hours {run, hours} (more hours of work for the run: see the add_run_hours tool); log_level {part: harness|supervisor, level: debug|info|warn|error, or null for the part's THERMITE_LOG_LEVEL}, with its rig (one part's log level from now on, until another log_level changes it or the part restarts; control_log_level gives control's own); "}assign_campaign {run, contract, contract_sha, seed, imports}, where an import may name a source the rig's supervisor fetches: {git: URL} for a project or kit commit, {url: URL} for a model.${role === "owner" ? "" : " With this token, its contract's role_additions and kb_writes must be those of the campaign's saved version (the one the contract names, else the newest), as the owner saved them."} \`thermite assign --print\` builds an assign_campaign payload). Returns the command id. On a rig launched on RunPod whose pod is stopped, assign_campaign and resume_run start the pod first (the owner's token only; another token is refused), and the answer's woke says so in words. Poll command_status: a source that cannot be fetched fails the command with the reason.`,
        inputSchema: {
          rig: z.string().min(1).optional(),
          kind: z.enum(kinds as unknown as [CommandKind, ...CommandKind[]]),
          payload: z.record(z.string(), z.unknown()),
          ttl_minutes: z.number().int().min(1).max(10080).default(60),
        },
      },
      audited(
        "issue_command",
        async (a: { rig?: string; kind: CommandKind; payload: unknown; ttl_minutes: number }) => {
          // A kind about one run goes to the run's rig, which the caller may leave out (goal 170).
          const rig = commandRig(store, a.kind, a.rig, a.payload);
          // During the owner's full reset of a rig, agents do not steer it.
          if (role === "agent" && store.fullResets.open(rig))
            throw new Error(`${rig} is being reset by the owner`);
          // A briefing takes the knowledge base's own words (goal 065); the queue's come next.
          if (a.kind === "assign_campaign") a.payload = briefingFromKb(store, a.payload);
          // A run assigned or resumed on a stopped RunPod pod starts the pod first: the owner's
          // token only, as for a launch and a start. `woke` says so, only then.
          const { id, woke } = await issueWaking(store, opts.privateKeyPem, opts.runpodRigs, {
            rig,
            kind: a.kind,
            payload:
              a.kind === "assign_campaign" ? await queueFromRecords(store, a.payload) : a.payload,
            ttlMinutes: a.ttl_minutes,
            issuedBy: actor,
            owner: role === "owner",
            agent: role === "agent",
          });
          return woke ? { id, woke } : { id };
        },
      ),
    );
  }

  if (canCommand) {
    server.registerTool(
      "propagate_champion",
      {
        title: "Propagate a champion to another rig",
        description:
          "Send one run's published champion (run) to another run of the same campaign on another rig (to_run); control knows the rig each run is on. The receiving rig's own judge screens and confirms it; if it wins there, the source result becomes cross-verified.",
        inputSchema: { run: z.string().min(1), to_run: z.string().min(1) },
      },
      audited("propagate_champion", (a: { run: string; to_run: string }) =>
        propagateChampion(store, opts.privateKeyPem, {
          run: a.run,
          toRun: a.to_run,
          issuedBy: actor,
          staleAfterMs: opts.staleAfterMs,
          agent: role === "agent",
        }),
      ),
    );
  }

  // A teachers' round now (goal 194): the owner's and operators', never an agent's.
  if (role === "owner" || role === "operator") {
    server.registerTool(
      "start_teachers_round",
      {
        title: "Start a teachers' round",
        description:
          "Ask a running run's teachers for a round now, the same round their timer starts: they review the run from its brief and give their advice, and the next timed round counts from this one. The owner's messages to them stay as they are. Control knows the rig the run is on. Returns {started, id, rig, said}; follow id with command_status. A request while a round is under way waits for it to end; at the rig's spending limit for the day, the teachers review the run after midnight UTC. Refused in words before it is signed: a run that is not running (a paused one: resume it first), a rig with no teachers (give them a model with set_rig_model), or a rig with its teachers off (set_rig_settings with teachers: true).",
        inputSchema: { run: z.string().min(1) },
      },
      audited("start_teachers_round", (a: { run: string }) =>
        startTeachersRound(store, opts.privateKeyPem, { run: a.run, issuedBy: actor }),
      ),
    );
  }

  // More hours for a run (goal 198): the owner's and operators', never an agent's.
  if (role === "owner" || role === "operator") {
    server.registerTool(
      "add_run_hours",
      {
        title: "Add hours to a run",
        description: `Give a run more hours of work: its stop time (the contract's budget.wall_hours) grows by hours, 1 to ${ADD_HOURS_MAX}, counted as the stop time counts them, only while the run works. A run that its hours paused ("the wall-time budget is spent") resumes; another run keeps its status. Control knows the rig the run is on. Returns {id, rig, said}; follow id with command_status, whose result gives the run's hours now (total) and whether it resumed. Refused in words: a closed run, a run with no stop time, and hours that would still leave the run past its hours.`,
        inputSchema: {
          run: z.string().min(1),
          hours: z.number().positive().max(ADD_HOURS_MAX),
        },
      },
      audited("add_run_hours", (a: { run: string; hours: number }) =>
        addRunHours(store, opts.privateKeyPem, { ...a, issuedBy: actor }),
      ),
    );
  }

  server.registerTool(
    "command_status",
    {
      title: "Command status",
      description: "Delivery status and outcome of one command.",
      inputSchema: { id: z.string().min(1) },
    },
    audited("command_status", (a: { id: string }) => {
      const c = store.commands.get(a.id);
      if (!c) throw new Error(`no command ${a.id}`);
      return c;
    }),
  );
}
