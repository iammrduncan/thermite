import { join } from "node:path";
import { type McpCaller, McpGateway } from "../../agents/mcp/index.ts";
import {
  type ModelConfig,
  modelStallMs,
  type ProviderErrorAnswer,
} from "../../agents/model/index.ts";
import type { Prompt } from "../../agents/prompt.ts";
import { buildInfo } from "../../common/build-info.ts";
import { Loops } from "../../common/health.ts";
import type { McpConnect } from "../../common/mcp-client.ts";
import type { InTurn } from "../../core/agents.ts";
import type { AdvisorQueueRequest } from "../../core/api/harness/advisors.ts";
import type { SubmitRequest } from "../../core/api/harness/proposer.ts";
import type { CardSubmission, PaperSubmission } from "../../core/api/harness/research.ts";
import type { AskOwner, KeyPairPem } from "../../core/commands.ts";
import type { Contract } from "../../core/contract.ts";
import type { Hardware } from "../../core/hardware.ts";
import { LiveLog } from "../../core/live.ts";
import { type McpUse, McpUses } from "../../core/mcp.ts";
import { PROGRAM_MODE_DEFAULT } from "../../core/rig-settings.ts";
import type { BuildInfo } from "../../core/version.ts";
import type { ControlRoute, ModelSource, TurnDelivery } from "../agents/index.ts";
import type { Compactions } from "../compactions.ts";
import type { DiskWatch } from "../disk.ts";
import { Journal } from "../journal.ts";
import { KbAsks, KbTools } from "../kb/index.ts";
import { Knowledge } from "../knowledge.ts";
import { type Ledger, LedgerError } from "../ledger/index.ts";
import { type AdvisorRole, OwnerMessages } from "../messages.ts";
import type { PreviewAsk } from "../prompts.ts";
import { ExperimentQueue } from "../queue.ts";
import { Cards, folderRootOf, Papers, SAVED_LANES_DIR } from "../research/index.ts";
import type { ReviewKind } from "../reviews.ts";
import { RigSettingsStore } from "../rig-settings.ts";
import { RunResearch } from "../run-research.ts";
import { HARNESS_NUMBERS } from "../settings.ts";
import { ModelUsage } from "../usage.ts";
import * as assignment from "./assignment.ts";
import * as attempts from "./attempts.ts";
import * as champion from "./champion.ts";
import * as checks from "./checks.ts";
import { type CommandOutcome, Commands } from "./commands.ts";
import { TerminalConsoles } from "./consoles.ts";
import * as decisions from "./decisions.ts";
import { type Draining, drainDeadline, endDrainAtStart, type Work, workNow } from "./drain.ts";
import { type CallCredential, noteModelStall, ProviderAnswers, ProxyCredentials } from "./proxy.ts";
import * as reports from "./reports.ts";
import * as research from "./research.ts";
import { requireRun } from "./runs.ts";
import * as steering from "./steering.ts";
import * as teachers from "./teachers.ts";
import * as trials from "./trials.ts";
import { TrialWatch, tellStreak } from "./watch.ts";

export type { SubmitResult } from "./attempts.ts";
export type { RigCheck, RigCheckName } from "./checks.ts";
export type { CommandOutcome } from "./commands.ts";
export { drainSpans } from "./drain.ts";
export { IdeaRequest } from "./trials.ts";
export { NOT_BEFORE_FILE, notBeforeOf, WIPE_MARKER, wipeIfRequested } from "./wipe.ts";

export interface HarnessPaths {
  stateDir: string;
  scratchDir: string;
  inboxDir: string;
  outboxDir: string;
}

/**
 * The harness's application service. It is the only code that changes harness state; the API
 * layer authenticates callers and delegates here.
 *
 * The class holds the service's state and is its interface. The bodies of most of its operations
 * are in service/, a module for each part, with their doc comments: commands.ts (control's signed
 * commands), assignment.ts, champion.ts (a win and the champion), wipe.ts, checks.ts (the rig
 * checks), proxy.ts (what the model proxy and the MCP gateway take), decisions.ts (the advisors'
 * packages and decisions), steering.ts (what they write into a run), teachers.ts (what the
 * teachers read), research.ts (answer cards and papers), attempts.ts, trials.ts and reports.ts.
 * runs.ts holds the checks of a run that they share.
 */
export class HarnessService {
  readonly rig: string;
  readonly ledger: Ledger;
  readonly paths: HarnessPaths;
  /** What each open trial is doing (goal 143): fed by every trial line the live log keeps. */
  readonly watch = new TrialWatch();
  /** What the agents and the judge are doing now, for control's live view (never judged). */
  readonly live = new LiveLog({
    onAppend: (e) => tellStreak(this.watch.saw(e), e, this.ledger, this.live),
  });
  /** The service's clock (tests give their own): the time in its records and reports. */
  readonly clock: () => Date;
  private readonly rigKeys: KeyPairPem | undefined;
  /** What the rig runs on, collected at start; it rides in every report's summary. */
  hardware: Hardware | undefined;
  /**
   * The harness's build (its Thermite version and commit, and the protocol it speaks): it rides
   * in every report's summary, so control can mark a rig that is behind and refuse one whose
   * protocol it cannot work with.
   */
  build: BuildInfo | undefined = buildInfo();
  /** Control's commands, applied once each (service/commands.ts). */
  private readonly commands: Commands;
  /** Trials whose submission is being recorded right now. */
  private readonly submitting = new Set<string>();
  /**
   * Each running code trial's workspace (set by the scheduler): the worker's file and shell tools
   * run there, as the lane's user, through the API with the trial's token.
   */
  readonly trialWorkspaces = new Map<string, { lane: string; repo: string; root: string }>();
  /** Each open trial's counters as its worker last reported them (kept if the trial dies). */
  readonly trialProgress = new Map<
    string,
    { turns: number; tool_calls: number; tokens_in: number; tokens_out: number }
  >();
  /** The rig's own settings (Edit rig): parts on or off, workers at once, limits, promotion. */
  readonly settings: RigSettingsStore;
  /** The owner's messages to the run's agents, and who read each one. */
  readonly messages: OwnerMessages;
  /** Each run's experiment queue: what to try next, in order, and what was tried. */
  readonly queue: ExperimentQueue;
  /** Each run's field notes: what its workers, planner and advisors write down as they work. */
  readonly journal: Journal;
  /** The model usage of each run's agents, one record for each call (goal 075). */
  readonly usage: ModelUsage;
  /** Past research in each run's research folder (knowledge/), as the supervisor syncs it. */
  readonly knowledge: Knowledge;
  /**
   * Each run's own research, read only, for its teachers (goal 098): sources, claims, hypotheses,
   * findings, notes and the files of its research folder, from the ledger and the lanes' saved
   * files.
   */
  readonly runResearch: RunResearch;
  /**
   * The MCP servers the runs' kits name (goal 068): workers and the planner call them through
   * here; their sign-in, from control by way of the supervisor, stays in this process's memory.
   */
  readonly mcp: McpGateway;
  /**
   * Thermite's knowledge base for every agent (goal 175): kb_search and kb_read, asked of control
   * through the supervisor's channel (kbAsks), and kb_write, kept in the run's ledger.
   */
  readonly kbAsks = new KbAsks();
  readonly kbTools: KbTools;
  /** A rig configured with its GPU set: how many cards, and how many the judge has now. */
  gpuSplit?: { set: number; judge: number } | undefined;
  /**
   * A subscription's usage windows as its runtime last reported them (Claude Code's 5-hour and
   * weekly windows), for the rig's report: no tokens, only percent used and reset times.
   */
  subscriptionUsage?:
    | {
        five_hour?: { utilization: number; resets_at: string } | undefined;
        seven_day?: { utilization: number; resets_at: string } | undefined;
        at: string;
      }
    | undefined;
  /** The newest error answer the model proxy saw for each trial (or "proxy"): goal 079. */
  private readonly providerAnswers = new ProviderAnswers();

  noteProviderAnswer(who: string, a: ProviderErrorAnswer, now = Date.now()): void {
    this.providerAnswers.noteProviderAnswer(who, a, now);
  }

  /**
   * How long a model call's stream may send no data before the model proxy breaks it off (ms;
   * goal 079): THERMITE_MODEL_STALL_SECONDS, 600 s by default. Undefined: never.
   */
  modelStallMs: number | undefined = modelStallMs();

  noteModelStall(trial: { id: string; run: string; lane: string } | undefined, ms: number): void {
    noteModelStall(this.live, trial, ms);
  }

  providerAnswerSince(who: string, since: number): ProviderErrorAnswer | undefined {
    return this.providerAnswers.providerAnswerSince(who, since);
  }

  /** A research run's folder as files, for its export (main.ts sets it). */
  researchFolder?: ((run: string) => { root: string; files: string[] }) | undefined;
  /**
   * The prompt a role would be sent next in a run, rendered with no side effect (goal 166; the
   * controller sets it, from its scheduler).
   */
  promptPreview?: ((run: string, ask: PreviewAsk) => Prompt) | undefined;
  /**
   * Each compaction of an agent's conversation (goal 070): the conversation kept in the run's
   * research folder, and the record of it (main.ts sets it, with the research folder).
   */
  compactions?: Compactions | undefined;
  /**
   * The rig drains (goal 079): no new trial, plan or judge job starts, and those running end as
   * they would. Kept in memory only: the restart it prepares for ends it (`service/drain.ts`).
   */
  draining: Draining | undefined;
  /**
   * The rig's disk against its floor (goal 173; main.ts sets it): at the floor no trial, plan,
   * judge's job or export starts. None: no floor (tests).
   */
  disk: DiskWatch | undefined;
  /** How long a drain waits before its deadline when its command gives none (main.ts sets it). */
  drainMinutes: number = HARNESS_NUMBERS.drainMinutes.fallback;

  /** A drain past its deadline records the step once (service/drain.ts). */
  drainDeadline(): boolean {
    return drainDeadline(this, this.clock());
  }
  /** The controller's loops and when each last came around, for the health route (goal 173). */
  loops = new Loops();

  /** What still runs, for the rig's report, with each open trial and what it is doing (workNow). */
  work(): Work {
    const w = workNow(this.ledger, this.clock(), this.draining, (t) => this.watch.facts(t));
    // A planner's call in its own terminal, for Live (goal 169).
    const terminals = this.consoles.openCalls();
    return terminals.length ? { ...w, terminals } : w;
  }

  /** The promotion policy: what happens to a confirmed win (and to one an audit cleared). */
  get promotion(): "auto" | "owner_approval" {
    return this.settings.get().promotion;
  }
  /** The rig's target type (cpu, cuda-gpu, ...): an assigned campaign's kit must measure on it. */
  readonly targetType: string | undefined;

  constructor(input: {
    rig: string;
    ledger: Ledger;
    paths: HarnessPaths;
    controlPublicKeyPem: string;
    clock?: (() => Date) | undefined;
    /** The rig's report-signing key (generated once, kept in the private state). */
    rigKeys?: KeyPairPem | undefined;
    promotion?: "auto" | "owner_approval" | undefined;
    /** The rig's target type (cpu, cuda-gpu, ...): an assigned campaign's kit must measure on it. */
    targetType?: string | undefined;
    /** The rig's settings; none: defaults in memory, with this promotion policy. */
    settings?: RigSettingsStore | undefined;
    /** How the MCP gateway reaches MCP servers (tests give their own). */
    mcpConnect?: McpConnect | undefined;
  }) {
    this.rigKeys = input.rigKeys;
    this.targetType = input.targetType;
    this.settings =
      input.settings ??
      new RigSettingsStore({
        judge: true,
        workers: true,
        lanes: 1,
        planner: true,
        auditor: true,
        teachers: true,
        review: true,
        exports: true,
        trial_minutes: null,
        max_turns: null,
        quiet_minutes: null,
        program_mode: PROGRAM_MODE_DEFAULT,
        // Hands-off by default (goal 079).
        promotion: input.promotion ?? "auto",
        judge_gpus: null,
      });
    this.rig = input.rig;
    this.clock = input.clock ?? (() => new Date());
    this.ledger = input.ledger;
    endDrainAtStart(this.ledger, "harness");
    this.paths = input.paths;
    this.commands = new Commands(this, input.controlPublicKeyPem, this.checkRunner);
    this.messages = new OwnerMessages({
      ledger: this.ledger,
      live: this.live,
      clock: this.clock,
      settings: () => this.settings.get(),
      contractFor: (run) => this.contractFor(run),
    });
    this.queue = new ExperimentQueue(this.ledger);
    this.journal = new Journal({ ledger: this.ledger, live: this.live, clock: this.clock });
    this.usage = new ModelUsage(this.ledger);
    // The same folders as the research folder's (main.ts): scratch/research/<run>/knowledge.
    this.knowledge = new Knowledge({
      stateRoot: join(this.paths.stateDir, "knowledge"),
      folderRoot: (run) => folderRootOf(join(this.paths.scratchDir, "research"), run),
    });
    // The lanes' files where the research folder saves them (main.ts): stateDir/research-work.
    this.runResearch = new RunResearch({
      ledger: this.ledger,
      savedLanes: join(this.paths.stateDir, SAVED_LANES_DIR),
    });
    this.kbTools = new KbTools({
      ledger: this.ledger,
      outboxDir: this.paths.outboxDir,
      contractFor: (run) => this.contractFor(run),
      asks: this.kbAsks,
    });
    this.mcp = new McpGateway({
      uses: (run) => this.mcpUses(run),
      // A server that fails or comes back: in the run's history, once each time.
      record: (run, kind, body) => {
        this.ledger.appendEvent("harness", kind, run, body);
      },
      say: (source, run, text) => this.live.append({ source, kind: "status", text, run }),
      connect: input.mcpConnect,
    });
  }

  /** A run's promotion policy: its own, chosen when it was assigned, or the rig's default. */
  promotionFor(run: string): "auto" | "owner_approval" {
    return this.ledger.runs.get(run)?.promotion ?? this.promotion;
  }

  /** What else a run asks the owner about (goal 079): nothing unless it was set to ask. */
  askFor(run: string): AskOwner {
    return this.ledger.runs.get(run)?.ask_owner ?? {};
  }

  ownerAsks(run: string, attempt: Record<string, unknown>, delta: number | null) {
    return champion.ownerAsks(this, run, attempt, delta);
  }

  /**
   * The supervisor's advisors, as it last said (goal 079): whether an auditor decides this rig's
   * audits, how many reviewers its review panel has, and whether a final writer writes research
   * papers (goal 112; a supervisor from before it does not say, which reads as none). Unknown
   * until it says.
   */
  advisors: { auditor: boolean; review_panel: number; writer: boolean; at: string } | undefined;

  setAdvisors(
    a: { auditor: boolean; review_panel: number; writer?: boolean | undefined },
    by: string,
  ) {
    return decisions.setAdvisors(this, a, by);
  }

  /** A research run's folder follows a change the research service did not make (main.ts sets it). */
  researchChanged?: ((run: string) => void) | undefined;

  // ------------------------------------------------------------ research: service/research.ts

  /** Research runs' answer cards (goal 117): one per question, written by the synthesizer. */
  get cards(): Cards {
    return new Cards(this.ledger, (run) => this.contractFor(run));
  }

  cardPackages() {
    return research.cardPackages(this);
  }

  submitCards(run: string, input: CardSubmission, by: string) {
    return research.submitCards(this, run, input, by);
  }

  /** Research runs' final papers (goal 112). */
  get papers(): Papers {
    return new Papers(this.ledger, (run) => this.contractFor(run));
  }

  paperPackages() {
    return research.paperPackages(this);
  }

  submitPaper(run: string, input: PaperSubmission, by: string) {
    return research.submitPaper(this, run, input, by);
  }

  // ------------------------------------------------------------ advisors: service/decisions.ts

  recordReviewTry(id: number, attempt: number, error: string, by: string) {
    return decisions.recordReviewTry(this, id, attempt, error, by);
  }

  recordReviewPanel(id: number, results: decisions.PanelResult[], by: string) {
    return decisions.recordReviewPanel(this, id, results, by);
  }

  takeConclusion(run: string, proposal: number) {
    return decisions.takeConclusion(this, run, proposal);
  }

  releaseHeldAudits(by: string) {
    return decisions.releaseHeldAudits(this, by);
  }

  mirrorFor(repo: string): string {
    return join(this.paths.stateDir, "git", `${repo}.git`);
  }

  // ------------------------------------------------------------ commands: service/commands.ts

  applyCommand(input: unknown, actor = "supervisor"): Promise<CommandOutcome> {
    return this.commands.applyCommand(input, actor);
  }

  /** A signed command checked, not applied (commands.ts). */
  checkCommand(input: unknown): { ok: true } | { ok: false; reason: string } {
    return this.commands.checkCommand(input);
  }

  /** A command whose content the supervisor could not stage, recorded as not applied (commands.ts). */
  recordUnstaged(input: unknown, reason: string, actor = "supervisor"): CommandOutcome {
    return this.commands.recordUnstaged(input, reason, actor);
  }

  // ------------------------------------------------------------ assignment: service/assignment.ts

  assignLocal(input: assignment.LocalAssignment, by: string) {
    return assignment.assignLocal(this, input, by);
  }

  /** The MCP servers a run's kit names, with the agents that get each (none: an empty list). */
  mcpUses(run: string): McpUse[] {
    return (
      McpUses.safeParse(this.ledger.latestEventBody("mcp_servers", run)?.servers ?? []).data ?? []
    );
  }

  // ------------------------------------------------------------ promotion: service/champion.ts

  promoteAttempt(input: champion.Promotion) {
    return champion.promoteAttempt(this, input);
  }

  syncChampionRef(run: string) {
    return champion.syncChampionRef(this, run);
  }

  // ------------------------------------------------------------ full reset: service/wipe.ts

  /** Called when a wipe was requested (the controller exits; tests observe it). */
  onWipe?: () => void;

  // ------------------------------------------------------------ rig checks: service/checks.ts

  /**
   * The checks this rig can run, wired in by the controller (main.ts): each may say why it
   * cannot start now (a busy rig), and runs in the background, reporting as an event.
   */
  rigChecks: Partial<Record<checks.RigCheckName, checks.RigCheck>> = {};

  /** Where the agents' model route comes from (control's route, else the rig's settings). */
  models: ModelSource | undefined;

  /** The checks as they run, one at a time. */
  private readonly checkRunner = new checks.RigCheckRunner(this);

  setModelRoute(route: ControlRoute | null, by: string, planner?: ControlRoute | null | undefined) {
    return checks.setModelRoute(this, this.checkRunner, route, by, planner);
  }

  reconcileRigChecks(): void {
    checks.reconcileRigChecks(this.ledger);
  }

  modelCheckRunning(): boolean {
    return this.checkRunner.modelCheckRunning();
  }

  checkModelNow(by: string): boolean {
    return this.checkRunner.checkModelNow(by);
  }

  checkAtStart(check: checks.RigCheckName): Promise<void> {
    return this.checkRunner.checkAtStart(check);
  }

  // ------------------------------------------------------------ credentials: service/proxy.ts

  /** Credentials the model proxy and the MCP gateway take besides trials' tokens. */
  private readonly credentials = new ProxyCredentials();

  mintProxyToken(model?: ModelConfig | undefined, ms = 15 * 60_000): string {
    return this.credentials.mintProxyToken(model, ms);
  }

  proxyTokenValid(token: string): boolean {
    return this.credentials.proxyTokenValid(token);
  }

  proxyTokenModel(token: string): ModelConfig | undefined {
    return this.credentials.proxyTokenModel(token);
  }

  mintMcpToken(caller: McpCaller, ms = 15 * 60_000): string {
    return this.credentials.mintMcpToken(caller, ms);
  }

  mcpTokenCaller(token: string): McpCaller | undefined {
    return this.credentials.mcpTokenCaller(token);
  }

  /** A credential bound to one call in its own terminal, until endCall (goal 169). */
  mintCallToken(c: CallCredential): string {
    return this.credentials.mintCallToken(c);
  }

  callOf(token: string): CallCredential | undefined {
    return this.credentials.callOf(token);
  }

  endCall(token: string): void {
    this.credentials.endCall(token);
  }

  // ------------------------------------------------------ audits and reviews: service/decisions.ts

  auditPackages() {
    return decisions.auditPackages(this);
  }

  reviewPackages(kinds: readonly ReviewKind[] = ["goal"]) {
    return decisions.reviewPackages(this, kinds);
  }

  decideAudit(input: decisions.AuditorDecision): Promise<unknown> {
    return decisions.decideAudit(this, input);
  }

  // ------------------------------------------------------ the teachers' reads: service/teachers.ts

  queueState(run: string) {
    return teachers.queueState(this, run);
  }

  queueLow(run: string) {
    return teachers.queueLow(this, run);
  }

  codeFiles(run: string, folder: string) {
    return teachers.codeFiles(this, run, folder);
  }

  codeFile(run: string, path: string, offset?: number, limit?: number) {
    return teachers.codeFile(this, run, path, offset, limit);
  }

  attemptDiff(run: string, attempt: string, offset?: number) {
    return teachers.attemptDiff(this, run, attempt, offset);
  }

  evidence(run: string, attempt?: string): unknown {
    return teachers.evidence(this, run, attempt);
  }

  brief(run: string): unknown {
    return teachers.brief(this, run);
  }

  // ----------------------------------------------------- the advisors' writes: service/steering.ts

  /**
   * Low-power steering from the teachers: one structured directive set, which
   * replaces the supervisor's previous set. Every directive needs a citation, and free-text notes
   * (planner only) are limited. Nothing here can touch a verdict, a contract or a worker's brief.
   */
  addDirectives(run: string, directives: unknown, author: string): number[] {
    return this.setAdvisorRules(run, directives, author).ids;
  }

  setAdvisorRules(run: string, directives: unknown, author: string) {
    return steering.setAdvisorRules(this, run, directives, author);
  }

  advisorQueue(input: AdvisorQueueRequest) {
    return steering.advisorQueue(this, input);
  }

  advisorNotes(input: { run: string; role: AdvisorRole; by: string; notes: unknown[] }) {
    return steering.advisorNotes(this, input);
  }

  writeKnowledge(run: string, items: unknown[], collections?: string[] | undefined) {
    return steering.writeKnowledge(this, run, items, collections);
  }

  advisorMessages(input: steering.AdvisorReceipts) {
    return steering.advisorMessages(this, input);
  }

  // ------------------------------------------------------------ attempts: service/attempts.ts

  contractFor(run: string): Contract {
    const inst = requireRun(this.ledger, run);
    const c = this.ledger.contracts.get(inst.campaign, inst.version);
    if (!c) throw new LedgerError("not_found", `contract for ${run} missing`);
    return c;
  }

  submitAttempt(req: SubmitRequest, actor: string): Promise<attempts.SubmitResult> {
    return attempts.submitAttempt(this, req, actor);
  }

  submitForTrial(token: string, req: attempts.TrialPatch): Promise<attempts.SubmitResult> {
    return attempts.submitForTrial(this, this.submitting, token, req);
  }

  trialSubmission(trialId: string) {
    return attempts.trialSubmission(this.ledger, trialId);
  }

  attemptStatus(id: string): unknown {
    return attempts.attemptStatus(this.ledger, id);
  }

  // ------------------------------------------------------------ trials: service/trials.ts

  proposeIdea(token: string, input: unknown) {
    return trials.proposeIdea(this, token, input);
  }

  writeTrialNote(token: string, input: unknown) {
    return trials.writeTrialNote(this, token, input);
  }

  /** The owner's messages each trial is given, and those its brief carries. */
  private readonly inboxes = new trials.TrialInboxes(this);

  trialInbox(trial: { id: string; run: string; lane: string }) {
    return this.inboxes.trialInbox(trial);
  }

  briefed(trial: { id: string; run: string; lane: string }, ids: number[]): void {
    this.inboxes.briefed(trial, ids);
  }

  trialAtWork(id: string): void {
    this.inboxes.trialAtWork(id);
  }

  /** The owner's consoles into the agents' terminals, and their screens (goal 169). */
  readonly consoles = new TerminalConsoles(this);

  /** A running trial's way to take the owner's messages inside its turn (goal 169). */
  inTurn(id: string, d: TurnDelivery | undefined): void {
    this.inboxes.inTurn(id, d);
  }

  turnOffer(id: string, at: InTurn): { offer: string; text: string } | undefined {
    return this.inboxes.turnOffer(id, at);
  }

  turnTaken(id: string, offer: string): number[] {
    return this.inboxes.turnTaken(id, offer);
  }

  /** A trial ended. Its brief's messages are read only if its agent ever got to work. */
  trialEnded(id: string, atWork: boolean): void {
    if (atWork) this.trialAtWork(id);
    this.inboxes.forget(id);
    this.consoles.ended(id);
    this.watch.forget(id);
  }

  trialReport(trial: { id: string; run: string; lane: string }, r: trials.TrialLines): void {
    trials.trialReport(this, trial, r);
  }

  trialWait(
    trial: { id: string; run: string; lane: string; source?: string | undefined },
    w: { until: string; kind: string; words: string },
  ): void {
    trials.trialWait(this, trial, w);
  }

  /** Trials whose worker reports its own session's counters and waits (Pi's), while they run. */
  private readonly ownSessions = new Set<string>();

  /** The trial's worker reports its counters and waits itself; the function it returns ends that. */
  reportsOwnSession(id: string): () => void {
    this.ownSessions.add(id);
    return () => this.ownSessions.delete(id);
  }

  /** Whether the trial's worker may send its counters and waits on the trial's route. */
  ownSession(id: string): boolean {
    return this.ownSessions.has(id);
  }

  takeMessages(trial: { id: string; run: string; lane: string }): string[] {
    return trials.takeMessages(this, trial);
  }

  takePlannerMessages(run: string): string[] {
    return trials.takePlannerMessages(this, run);
  }

  // ------------------------------------------------------- reports and exports: service/reports.ts

  liveMessages(after: number, limit: number): unknown {
    return reports.liveMessages(this, this.rigKeys, after, limit);
  }

  snapshot(cursor: number, limit: number): unknown {
    return reports.snapshot(this, this.rigKeys, cursor, limit);
  }

  removeExports(names: string[]): number {
    return reports.removeExports(this, names);
  }

  export(actor: string, o: { full?: boolean; run?: string | undefined } = {}) {
    return reports.exportForSupervisor(this, actor, o);
  }
}
