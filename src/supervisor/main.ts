import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { log, optionalSecretFromFile, requireEnv, secretFromFile } from "../common/env.ts";
import { numberSetting, secondsSetting } from "../common/settings.ts";
import { untoldKinds } from "../core/kb.ts";
import type { McpUse } from "../core/mcp.ts";
import { buildHeaders, buildInfo } from "../core/version.ts";
import { modelStallMs } from "../harness/agents/model-stall.ts";
import { McpGateway } from "../harness/mcp-gateway.ts";
import { type AdviseState, adviseOnce, emptyAdviseState, teachersCalled } from "./advise.ts";
import { type ControlAdvisors, fetchControlAdvisors, mergeAdvisors } from "./advisor-routes.ts";
import { AdvisorsConfig, advisorsFileReport } from "./advisors.ts";
import { type ChampionUpload, championsIn, uploadChampions } from "./champions.ts";
import { type UploadState, uploadExportsOnce } from "./export-upload.ts";
import { type ExportState, exportOnce } from "./git-export.ts";
import { harnessAdvisors } from "./harness-advisors.ts";
import { emptyKbSyncState, type KbSyncState, syncKnowledgeOnce } from "./kb-sync.ts";
import { relayLive, supervisorLive } from "./live.ts";
import { syncMcpServers } from "./mcp-sync.ts";
import { ModelDownloads } from "./model-download.ts";
import { syncModelRouteRound } from "./model-route.ts";
import { RelayError, type RelayState, relayCommandsOnce, relayOnce } from "./relay.ts";
import { dailyReport } from "./report.ts";
import { stageCommand } from "./staging.ts";
import { waitForHarness } from "./startup.ts";
import { startPullMode } from "./tunnel-pod.ts";

function load<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
}

function save(path: string, value: unknown): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(value));
  renameSync(`${path}.tmp`, path);
}

/** Exports in the outbox the exporter has not taken yet. */
function notYetExported(outboxDir: string, state: ExportState): number {
  if (!existsSync(outboxDir)) return 0;
  const done = new Set(state.done);
  return readdirSync(outboxDir).filter((n) => !n.startsWith(".") && !done.has(n)).length;
}

/** An interval whose 0 turns its loop off. */
const OFF_AT_ZERO = { aboveMin: false, zeroMeans: "off" };

/**
 * Supervisor entry point: the 60-second report and command relay loop (with content staging,
 * model downloads among it), exports (pushed to the results repository, or, without one, sent to
 * control), supervisor figures and a daily report to control, and, when advisors are configured,
 * the teachers, auditor and review panel in a loop of their own.
 */
async function main(): Promise<void> {
  const env = process.env;
  // How long the advisors' model calls may send no data (goal 079): a bad value stops it here.
  modelStallMs(env);
  const home = env.THERMITE_SUPERVISOR_HOME ?? "/var/lib/thermite-supervisor";
  mkdirSync(home, { recursive: true });
  const statePath = join(home, "relay-state.json");
  let state: RelayState = load(statePath, { cursor: 0 });
  const rig = requireEnv("THERMITE_RIG_ID");
  const harnessUrl = requireEnv("HARNESS_URL").replace(/\/$/, "");
  const harnessToken = secretFromFile("THERMITE_HARNESS_TOKEN_FILE");
  // Pull mode (a rig on RunPod): this rig never connects to control. Control connects to the
  // tunnel's port; the supervisor's calls go to the tunnel's local port and wait there for it.
  const pull = await startPullMode(env, rig, home);
  const controlUrl = pull?.controlUrl ?? env.CONTROL_URL?.replace(/\/$/, "");
  const controlToken = pull?.controlToken ?? optionalSecretFromFile("THERMITE_CONTROL_TOKEN_FILE");
  // A full reset keeps the tunnel's keys and enrollment: control's trust in the pod stays.
  const keepOnWipe = new Set(
    (pull?.dirs ?? []).filter((d) => dirname(d) === home).map((d) => basename(d)),
  );
  const remote = env.THERMITE_RESULTS_REMOTE || undefined;
  const sshKeyFile = env.THERMITE_RESULTS_KEY_FILE || undefined;
  const knownHostsFile = env.THERMITE_RESULTS_KNOWN_HOSTS || undefined;
  const inboxDir = env.THERMITE_INBOX_DIR ?? "/inbox";
  // Gated models on Hugging Face: the supervisor's own token, sent to Hugging Face only.
  const hfToken = optionalSecretFromFile("THERMITE_HF_TOKEN_FILE");
  // Model downloads, in the report to control and in the live view.
  const models = new ModelDownloads({
    live: (text, run) => supervisorLive.append({ source: "supervisor", kind: "status", text, run }),
  });
  let wipeRequested = false;
  const cfg = {
    rig,
    harnessUrl,
    harnessToken,
    controlUrl,
    controlToken,
    held: new Map(),
    staging: new Set<string>(),
    stage: (cmd: Parameters<typeof stageCommand>[1]) =>
      stageCommand(
        {
          rig,
          inboxDir,
          resultsRepo: join(home, "results.git"),
          sourcesDir: join(home, "sources"),
          controlUrl,
          controlToken,
          remote,
          sshKeyFile,
          knownHostsFile,
          models,
          hfToken,
        },
        cmd,
      ),
    onDelivered: (kind: string, accepted: boolean) => {
      if (kind === "wipe_state" && accepted) wipeRequested = true;
    },
  };
  const intervalMs = secondsSetting(env, "THERMITE_POLL_SECONDS", 60);
  const exportPath = join(home, "export-state.json");
  let exportState: ExportState = load(exportPath, { done: [] });
  // Champion patches waiting to reach control (kept across restarts).
  const championQueuePath = join(home, "champion-uploads.json");
  let championQueue: ChampionUpload[] = load(championQueuePath, []);
  // Without a results repository, exports leave the rig as uploads to control (export-upload.ts).
  const uploadToControl = !remote && Boolean(controlUrl && controlToken);
  const uploadPath = join(home, "export-uploads.json");
  let uploadState: UploadState = load(uploadPath, { queue: [], uploaded: [] });
  const exportCfg = {
    rig,
    outboxDir: env.THERMITE_OUTBOX_DIR ?? "/outbox",
    workDir: home,
    remote,
    sshKeyFile,
    knownHostsFile,
  };
  // The advisors' MCP servers (goal 068): the supervisor calls them for the advisors, with the
  // sign-in control gives it (kept in memory), and tells the harness when one fails or comes back.
  const advisorMcpUses = new Map<string, McpUse[]>();
  const advisorMcp = {
    uses: advisorMcpUses,
    gateway: new McpGateway({
      uses: (run) => advisorMcpUses.get(run) ?? [],
      record: (run, kind, body) => {
        void fetch(`${harnessUrl}/v1/mcp-events`, {
          method: "POST",
          headers: { authorization: `Bearer ${harnessToken}`, "content-type": "application/json" },
          body: JSON.stringify({
            run,
            server: body.server,
            ok: kind === "mcp_server_back",
            ...(typeof body.error === "string" ? { error: body.error } : {}),
          }),
        })
          .then((res) => {
            if (!res.ok) log("supervisor", "MCP event not recorded", { run, status: res.status });
          })
          .catch((err) => log("supervisor", "MCP event not recorded", { run, error: String(err) }));
      },
      say: (_source, run, text) =>
        supervisorLive.append({ source: "supervisor", kind: "status", text, run }),
    }),
  };
  const advisorsFile = env.THERMITE_ADVISORS_FILE;
  const fileAdvisors = advisorsFile
    ? AdvisorsConfig.parse(JSON.parse(readFileSync(advisorsFile, "utf8")))
    : undefined;
  // The roles control gives models (the owner's choice per rig) over the file's; read each round.
  let controlAdvisors: ControlAdvisors = {};
  let advisors = mergeAdvisors(fileAdvisors, controlAdvisors);
  const refreshAdvisors = async () => {
    if (controlUrl && controlToken) {
      try {
        controlAdvisors = await fetchControlAdvisors({ rig, controlUrl, controlToken });
      } catch (err) {
        // Control unreachable: the last roles it gave stay.
        log("supervisor", "advisor routes unavailable", { error: String(err).slice(0, 300) });
      }
    }
    advisors = mergeAdvisors(fileAdvisors, controlAdvisors);
    return advisors;
  };
  const advisePath = join(home, "advise-state.json");
  let adviseState: AdviseState = load(advisePath, emptyAdviseState());
  const reportPath = join(home, "report-state.json");
  let reportState = load<{ lastDailyAt?: string }>(reportPath, {});
  log("supervisor", "starting", {
    rig,
    build: buildInfo(),
    interval_ms: intervalMs,
    control: Boolean(controlUrl),
    pull_mode: Boolean(pull),
    results_remote: Boolean(remote),
    results_to: remote ? "repository" : uploadToControl ? "control" : "none",
    hf_token: Boolean(hfToken),
    ste_checker: Boolean(env.THERMITE_STE_CHECKER),
    advisors: advisors
      ? {
          teachers: advisors.teachers.length,
          merged_by: Boolean(advisors.merged_by),
          auditor: Boolean(advisors.auditor),
          review_panel: advisors.review_panel.length,
        }
      : null,
  });
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("supervisor", "stopping", { signal, pull_mode: Boolean(pull) });
    // Pull mode: a call waits at the tunnel's local port until control's next exchange takes it
    // (up to two minutes). On a stop, those calls end at once (503), so every loop ends now and
    // the supervisor exits within its host's grace time, whether or not control is connected.
    pull?.tunnel
      .stop()
      .catch((err) =>
        log("supervisor", "pull mode's ports did not close on the stop", { error: String(err) }),
      );
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  const toControl = async (path: string, body: unknown) => {
    if (!controlUrl || !controlToken) return;
    const res = await fetch(`${controlUrl}/v1/rigs/${encodeURIComponent(rig)}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${controlToken}`,
        "content-type": "application/json",
        ...buildHeaders(),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
  };

  // The harness may still be starting: wait for it once, before the relays begin.
  await waitForHarness(harnessUrl, () => stopping);

  // The rig's settings and which advisors decide, from and to the harness.
  const harnessLink = harnessAdvisors(harnessUrl, harnessToken);
  const { tell: tellAdvisors, retell } = harnessLink;
  // How often the pause between advisor rounds looks for a new owner's message to the teachers.
  const ownerCheckMs = 5000;
  // Advisors run on their own: a teacher round can take many minutes.
  const advising = async () => {
    while (!stopping) {
      const advisors = await refreshAdvisors();
      if (!advisors) {
        // No role has an advisor: look again later (the owner may give one a model).
        await tellAdvisors({ auditor: false, panel: 0, writer: false });
        const until = Date.now() + Math.max(intervalMs, 30_000);
        while (!stopping && Date.now() < until) {
          await new Promise((r) => setTimeout(r, 250));
          await retell();
        }
        continue;
      }
      const before = { ...adviseState.stats };
      try {
        // Only the roles both configured and switched on in the rig's settings (Edit rig).
        const on = await harnessLink.settings();
        const active = {
          ...advisors,
          teachers: on.teachers ? advisors.teachers : [],
          merged_by: on.teachers ? advisors.merged_by : undefined,
          auditor: on.auditor ? advisors.auditor : undefined,
          review_panel: on.review ? advisors.review_panel : [],
        };
        await tellAdvisors({
          auditor: Boolean(active.auditor),
          panel: active.review_panel.length,
          writer: active.teachers.length > 0,
        });
        adviseState = await adviseOnce(
          {
            harnessUrl,
            harnessToken,
            home,
            advisors: active,
            // Each step of a round (a teacher's review, the directives and why, an audit, a
            // review) is a line in the live view, with its run.
            live: (line) => supervisorLive.append({ source: "supervisor", ...line }),
            mcp: advisorMcp,
            // The deployment's STE checker for research papers (goal 112), when it gives one.
            steChecker: env.THERMITE_STE_CHECKER || undefined,
          },
          adviseState,
        );
        save(advisePath, adviseState);
        const a = adviseState.stats;
        const did = {
          teachers: a.teacher_runs - before.teacher_runs,
          sets: a.directive_sets - before.directive_sets,
          audits: a.audits - before.audits,
          reviews: a.reviews - before.reviews,
          papers: (a.papers ?? 0) - (before.papers ?? 0),
          cards: (a.cards ?? 0) - (before.cards ?? 0),
          errors: a.errors - before.errors,
        };
        // A round that did nothing says nothing: the live view is for what happens.
        const n = (k: number, what: string) => `${k} ${what}${k === 1 ? "" : "s"}`;
        if (Object.values(did).some((k) => k > 0))
          supervisorLive.append({
            source: "supervisor",
            kind: "status",
            text: `advisor round done: ${n(did.teachers, "teacher run")}, ${n(did.sets, "directive set")}, ${n(did.audits, "audit")}, ${n(did.reviews, "review")}, ${did.papers ? `${n(did.papers, "research paper")}, ` : ""}${did.cards ? `${n(did.cards, "answer card")}, ` : ""}${n(did.errors, "error")}`,
          });
      } catch (err) {
        log("supervisor", "advisor loop error", { error: String(err) });
        supervisorLive.append({
          source: "supervisor",
          kind: "status",
          text: `advisor round failed: ${String(err).slice(0, 300)}`,
        });
      }
      // The pause between rounds ends early when the owner writes to the teachers: its
      // round starts at once (checked every few seconds), not at the next hour.
      const until = Date.now() + Math.max(intervalMs, 30_000);
      let checked = Date.now();
      while (!stopping && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 250));
        await retell();
        if (Date.now() - checked < ownerCheckMs || !advisors.teachers.length) continue;
        checked = Date.now();
        const called = await teachersCalled(
          { harnessUrl, harnessToken, advisors },
          adviseState,
        ).catch(() => false);
        if (called && harnessLink.last().teachers) break;
      }
    }
  };
  const advisingDone = advising();

  // The live view: the harness's live log (signed) and the supervisor's own lines, every few
  // seconds. Independent of the 60 s report relay, once that relay's first report went through.
  const liveMs = numberSetting(env, "THERMITE_LIVE_INTERVAL_MS", 3000, {
    unit: "ms",
    zeroMeans: "off",
  });
  let reported = false;
  const livingDone =
    controlUrl && liveMs > 0
      ? relayLive(
          { rig, harnessUrl, harnessToken, controlUrl, controlToken },
          { intervalMs: liveMs, stopped: () => stopping, reported: () => reported },
        )
      : Promise.resolve();

  // Commands on their own short interval: a pause or a message should not wait for the next
  // report. The report loop below leaves commands to this one.
  const commandMs = secondsSetting(env, "THERMITE_COMMAND_POLL_SECONDS", 5, {
    aboveMin: false,
    zeroMeans: "with each report",
  });
  const commanding = async () => {
    let failing = false;
    while (!stopping && controlUrl && commandMs > 0) {
      try {
        await relayCommandsOnce(cfg);
        failing = false;
      } catch (err) {
        if (!failing) log("supervisor", "command relay error", { error: String(err) });
        failing = true;
      }
      if (wipeRequested) break;
      const until = Date.now() + commandMs;
      while (!stopping && !wipeRequested && Date.now() < until)
        await new Promise((r) => setTimeout(r, 250));
    }
  };
  const commandingDone = commanding();

  // The agents' model route, from control's settings page: checked every half minute.
  const routeMs = secondsSetting(env, "THERMITE_MODEL_ROUTE_POLL_SECONDS", 30, OFF_AT_ZERO);
  const pause = async (ms: number) => {
    const until = Date.now() + ms;
    while (!stopping && !wipeRequested && Date.now() < until)
      await new Promise((r) => setTimeout(r, 250));
  };
  // The MCP servers control gives the rig (goal 068), read on the same beat: the harness gets
  // its workers' and planner's share, and the advisors' share stays here, in memory.
  let mcpFailing = false;
  const syncMcp = async () => {
    try {
      const r = await syncMcpServers({
        rig,
        controlUrl: controlUrl as string,
        controlToken: controlToken as string,
        harnessUrl,
        harnessToken,
      });
      advisorMcp.gateway.set(
        r.servers.filter((c) => c.agents.includes("advisors")),
        r.unavailable,
      );
      mcpFailing = false;
    } catch (err) {
      // Control or the harness unreachable: the servers they gave last stay.
      if (!mcpFailing) log("supervisor", "MCP servers error", { error: String(err).slice(0, 300) });
      mcpFailing = true;
    }
  };
  const routing = async () => {
    let failing = false;
    while (!stopping && controlUrl && controlToken && routeMs > 0) {
      try {
        // A failure is tried again after 5 s before it is logged (control may still be starting).
        await syncModelRouteRound(
          { rig, controlUrl, controlToken, harnessUrl, harnessToken },
          Math.min(5000, routeMs),
          pause,
        );
        failing = false;
      } catch (err) {
        if (!failing) log("supervisor", "model route error", { error: String(err) });
        failing = true;
      }
      await syncMcp();
      await pause(routeMs);
    }
  };
  const routingDone = routing();

  // Past research for each running run, from control's knowledge base into the run's research
  // folder (knowledge/), every few minutes. The cursor of each run is kept here.
  const kbPath = join(home, "kb-state.json");
  let kbState: KbSyncState = load(kbPath, emptyKbSyncState());
  const kbMs = secondsSetting(env, "THERMITE_KB_SYNC_SECONDS", 180, OFF_AT_ZERO);
  const syncingKb = async () => {
    let failing = false;
    // Kinds of item from a newer control that this build left out: each is logged once.
    const toldKinds = new Set<string>();
    while (!stopping && controlUrl && controlToken && kbMs > 0) {
      try {
        const r = await syncKnowledgeOnce(
          { rig, controlUrl, controlToken, harnessUrl, harnessToken },
          kbState,
        );
        if (JSON.stringify(r.state) !== JSON.stringify(kbState)) save(kbPath, r.state);
        kbState = r.state;
        if (r.items) log("supervisor", "past research synced", { items: r.items });
        for (const [kind, items] of untoldKinds(toldKinds, r.unknownKinds))
          log("supervisor", "past research of an unknown kind left out", {
            kind,
            items,
            why: "control is newer than this rig: update the rig's images to get these items",
          });
        if (r.errors.length && !failing)
          log("supervisor", "past research sync error", { errors: r.errors.slice(0, 5) });
        failing = r.errors.length > 0;
      } catch (err) {
        if (!failing) log("supervisor", "past research sync error", { error: String(err) });
        failing = true;
      }
      const until = Date.now() + kbMs;
      while (!stopping && !wipeRequested && Date.now() < until)
        await new Promise((r) => setTimeout(r, 250));
    }
  };
  const syncingKbDone = syncingKb();

  while (!stopping) {
    try {
      const next = await relayOnce({ ...cfg, skipCommands: commandMs > 0 }, state);
      reported = true;
      if (next.cursor !== state.cursor || next.ledgerId !== state.ledgerId) {
        save(statePath, next);
        log("supervisor", "reported", { cursor: next.cursor });
      }
      state = next;
    } catch (err) {
      // Reporting failed; commands were still relayed. Keep whatever progress the round made.
      if (err instanceof RelayError) state = err.state;
      log("supervisor", "relay error", { error: String(err) });
    }
    if (wipeRequested) {
      // A full reset: the harness accepted its wipe. The supervisor wipes its own home too
      // (relay cursor, export record, local results repository, advisor records) and restarts.
      log("supervisor", "wiping the supervisor's state (full reset)");
      for (const name of readdirSync(home))
        if (!keepOnWipe.has(name)) rmSync(join(home, name), { recursive: true, force: true });
      process.exit(0);
    }
    try {
      const before = exportState.done.length;
      const next = await exportOnce(exportCfg, exportState);
      // Champions in the exports just made go to control too (downloadable from the dashboard).
      const fresh = next.done.filter((n) => !exportState.done.includes(n));
      if (fresh.length) {
        championQueue.push(...championsIn(exportCfg.outboxDir, fresh));
        save(championQueuePath, championQueue);
        if (uploadToControl) {
          uploadState = { ...uploadState, queue: [...uploadState.queue, ...fresh] };
          save(uploadPath, uploadState);
        }
      }
      if (next.done.length !== before || next.lastError !== exportState.lastError) {
        save(exportPath, next);
        log("supervisor", "exported", {
          exports: next.done.length - before,
          pushed: Boolean(exportCfg.remote),
          error: next.lastError ?? null,
        });
      }
      // Exports safe in the results repository (or on control, or, with neither, committed here)
      // leave the harness's outbox.
      const safe = remote
        ? (next.pushed ?? []).filter((n) => !(exportState.pushed ?? []).includes(n))
        : uploadToControl
          ? []
          : next.done.filter((n) => !exportState.done.includes(n));
      exportState = next;
      if (uploadToControl && uploadState.queue.length && controlUrl && controlToken) {
        const before = uploadState;
        uploadState = await uploadExportsOnce(
          { rig, outboxDir: exportCfg.outboxDir, controlUrl, controlToken },
          uploadState,
        );
        if (JSON.stringify(uploadState) !== JSON.stringify(before)) {
          save(uploadPath, uploadState);
          log("supervisor", "exports sent to control", {
            sent: uploadState.uploaded.filter((n) => !before.uploaded.includes(n)).length,
            waiting: uploadState.queue.length,
            error: uploadState.lastError ?? null,
          });
        }
        safe.push(...uploadState.uploaded.filter((n) => !before.uploaded.includes(n)));
      }
      if (safe.length) {
        await fetch(`${harnessUrl}/v1/exports/done`, {
          method: "POST",
          headers: { authorization: `Bearer ${harnessToken}`, "content-type": "application/json" },
          body: JSON.stringify({ names: safe }),
        }).catch((err) => log("supervisor", "outbox cleanup error", { error: String(err) }));
      }
    } catch (err) {
      log("supervisor", "export error", { error: String(err) });
    }
    if (championQueue.length && controlUrl && controlToken) {
      const left = await uploadChampions(
        { rig, controlUrl, controlToken, resultsRepo: join(home, "results.git") },
        championQueue,
      );
      if (left.length !== championQueue.length) save(championQueuePath, left);
      championQueue = left;
    }
    try {
      // Supervisor figures for control: git sync, advisors, relay.
      await toControl("/supervisor", {
        at: new Date().toISOString(),
        relay: { cursor: state.cursor },
        export: {
          remote: Boolean(remote),
          to: remote ? "repository" : uploadToControl ? "control" : "none",
          exports: exportState.done.length,
          pushed: exportState.pushed ?? [],
          pushed_commit: exportState.pushedCommit ?? null,
          last_push_at: exportState.lastPushAt ?? null,
          uploaded: uploadState.uploaded.slice(-50),
          last_upload_at: uploadState.lastUploadAt ?? null,
          // What has not left the rig: exports not yet taken from the outbox, and those taken
          // but not yet pushed (or sent to control).
          waiting:
            notYetExported(exportCfg.outboxDir, exportState) +
            (remote
              ? (exportState.unpushed?.length ?? 0)
              : uploadToControl
                ? uploadState.queue.length
                : 0),
          champions_waiting: championQueue.length,
          last_error:
            ((!remote && uploadState.lastError) || exportState.lastError)?.slice(0, 900) ?? null,
        },
        models: models.list(),
        advisors: advisors
          ? {
              ...adviseState.stats,
              // Which roles are configured and on, so control can say whether an audit will be
              // decided. Control reads these keys from every version of the supervisor: the
              // merged by model is `combiner` and the review panel `panel` here (goal 074).
              roles: {
                teachers: harnessLink.last().teachers ? advisors.teachers.length : 0,
                combiner: harnessLink.last().teachers && Boolean(advisors.merged_by),
                auditor: harnessLink.last().auditor && Boolean(advisors.auditor),
                panel: harnessLink.last().review ? advisors.review_panel.length : 0,
              },
              // What the rig's advisors file sets up for each role, so that Edit rig can say what
              // an advisor with no model from control uses (goal 074). No key, token or address.
              // With no advisor from the file or from control, `advisors` is null: none in it.
              file: advisorsFileReport(fileAdvisors),
            }
          : null,
      });
      const lastDaily = reportState.lastDailyAt ? Date.parse(reportState.lastDailyAt) : 0;
      if (Date.now() - lastDaily >= 24 * 3_600_000) {
        const body = await dailyReport({
          rig,
          harnessUrl,
          harnessToken,
          exportState,
          uploadState: uploadToControl ? uploadState : undefined,
          adviseState,
        });
        await toControl("/reports", { kind: "daily", body });
        reportState = { lastDailyAt: new Date().toISOString() };
        save(reportPath, reportState);
      }
    } catch (err) {
      log("supervisor", "control report error", { error: String(err) });
    }
    const until = Date.now() + intervalMs;
    // A wipe the command loop delivered is acted on at once, not at the next report.
    while (!stopping && !wipeRequested && Date.now() < until)
      await new Promise((r) => setTimeout(r, 250));
  }
  await advisingDone;
  await livingDone;
  await commandingDone;
  await routingDone;
  await syncingKbDone;
  process.exit(0);
}

main().catch((err) => {
  log("supervisor", "fatal", { error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
