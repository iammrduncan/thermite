import type { Hono } from "hono";
import { resourcesWords, rigWork, sizeWords, workWords } from "../../clusters/index.ts";
import {
  checkRow,
  checkRowsOf,
  commandFollowUrl,
  commandProgress,
  modelFollowUrl,
  takingModel,
} from "../../command-progress.ts";
import { exportLeft, removeWords, resultsLeft } from "../../results-left.ts";
import { controlAddress, controlImages } from "../../rigs/index.ts";
import { MIN_IDLE_STOP_MINUTES } from "../../runpod/index.ts";
import {
  type ClusterRig,
  fingerprint,
  type MachineRig,
  type TunnelRig,
} from "../../store/index.ts";
import { ago, esc, hardwareCard, icon, num } from "../../ui/components/index.ts";
import { exportMenu, exportsHref } from "../../ui/exports.ts";
import {
  cap,
  jobHtml,
  runBrief,
  runRow,
  type TimelineRow,
  timeline,
  waitingOn,
} from "../../ui/operator/index.ts";
import { checkRowHtml } from "../../ui/rigs/checks.ts";
import { diskBanner, diskFree } from "../../ui/rigs/disk.ts";
import { drainView } from "../../ui/rigs/drain.ts";
import { busKeysHtml } from "../../ui/rigs/keys.ts";
import { rigReachHtml, slotIngressWarning } from "../../ui/rigs/reach.ts";
import {
  HISTORY_FILTERS,
  podBlock,
  podLogBlock,
  podRows,
  podRuns,
  readySteps,
} from "../../ui/rigs/runpod.ts";
import { stateBanners, stateRows, stateSummary, versionFact } from "../../ui/rigs/states.ts";
import { runHref } from "../../ui/urls.ts";
import { span } from "../../ui/words/index.ts";
import { type RigView, runCampaign } from "../../views/index.ts";
import type { Ctx, Dashboard } from "../context.ts";
import {
  gpuRoles,
  PLACE_BUSY,
  placeFollowUrl,
  rigHelpers,
  splitWords,
  updateFollowUrl,
} from "./shared.ts";

/**
 * One rig's page, with the blocks its place adds: control's setup on a machine or a cluster, a
 * RunPod pod, pull mode or a join command.
 */
export function rigPageRoutes(app: Hono, dash: Dashboard): void {
  const { cmdForm, control, csrf, offlineAfterMs, opts, page, parts, store, updates, views } = dash;
  const { joinedBlock, joinedPage, placeOf, placeProgress, setupSteps, updateProgress } =
    rigHelpers(dash);

  // ---------------------------------------------------------------- one rig
  /** A rig that never reported (its first report may wait for its key): no last report time. */
  const neverReported = (u: RigView) => !(Date.parse(u.last_seen) > 0);
  app.get("/ui/rigs/:rig", (c, next) => {
    // Rigs › Add a rig has its own page, registered further down.
    if (c.req.param("rig") === "add") return next();
    const now = Date.now();
    const vs = views();
    const u = vs.find((x) => x.id === c.req.param("rig"));
    const placed = store.machines.rig(c.req.param("rig"));
    const onCluster = store.clusters.rig(c.req.param("rig"));
    const joined = store.joinedRigs.get(c.req.param("rig"));
    const pulled = store.tunnels.get(c.req.param("rig"));
    const flashOk = c.req.query("ok");
    const flashError = dash.said(c);
    // A command the green line is about (Edit rig's settings): the page says how it stands.
    const flashCmd = flashOk ? store.commands.row(c.req.query("cmd") ?? "") : undefined;
    const flashing = flashCmd ? commandProgress(flashCmd, Date.now()) : undefined;
    const flash = flashError
      ? `<div class="card warn" style="margin-bottom:16px"><b class="bad">Not done.</b> ${esc(flashError)}</div>`
      : flashOk
        ? `<div class="card" style="margin-bottom:16px"${flashCmd && flashing && !flashing.final ? ` data-follow="${esc(commandFollowUrl(flashCmd.id))}" data-follow-state="${flashing.state}" data-say` : ""}><b class="ok">${esc(flashOk)}</b>${flashing ? ` <span class="${flashing.tone}" data-say>${esc(flashing.said)}</span>` : ""}</div>`
        : "";
    const retired = store.retired.get(c.req.param("rig"));
    const launched = opts.runpodRigs?.view(c.req.param("rig"));
    if (!u && retired)
      return page(
        c,
        {
          title: c.req.param("rig"),
          crumbs: [{ href: "/ui/rigs", text: "Rigs" }],
          summary: launched
            ? `<span class="muted">${launched.active ? "retired" : "terminated"}</span> · RunPod`
            : `<span class="muted">retired</span>`,
          active: "rigs",
        },
        `${flash}<div class="card"><p>Retired ${esc(ago(retired.at, now))} ago by ${esc(retired.by)}. It is out of the rig lists, its campaigns' pages and Needs you, and control refuses its reports. Its records stay.${launched && !launched.active ? ` Its pod is terminated. It cost <b>$${(launched.spend_usd ?? launched.spent_usd).toFixed(2)}</b> while it ran, as control counted it.` : ""}</p>
<form method="post" action="/ui/rigs/${encodeURIComponent(c.req.param("rig"))}/bring-back" class="row" style="gap:8px"><input type="hidden" name="csrf" value="${csrf(c)}"><button>Bring it back</button><span class="muted small">It shows again, and its reports are taken again. A token control made for it stays ended: give it a new one if it needs one.</span></form></div>${launched ? `${podSection(c, c.req.param("rig"), now)}${podHistory(undefined, c.req.param("rig"), [], now)}` : ""}`,
        vs,
      );
    if (!u && onCluster)
      return page(
        c,
        {
          title: onCluster.rig,
          crumbs: [{ href: "/ui/rigs", text: "Rigs" }],
          summary: `on ${esc(onCluster.cluster)} · ${esc(onCluster.status)}`,
          active: "rigs",
        },
        `<p class="run-said">Control is setting ${esc(onCluster.rig)} up on ${esc(onCluster.cluster)}. Its page fills in once the rig reports for the first time.</p>${flash}${clusterPlacedBlock(onCluster, csrf(c))}`,
        vs,
      );
    if (!u && joined) return joinedPage(c, joined, flash);
    if (!u && pulled && launched)
      return page(
        c,
        {
          title: pulled.rig,
          crumbs: [{ href: "/ui/rigs", text: "Rigs" }],
          summary: `${podSummary(launched)} · ${pulled.enrolled_at ? "enrolled" : "not enrolled yet"}`,
          active: "rigs",
        },
        `<p class="run-said">${podSaid(launched, now)} Its page fills in once the rig reports for the first time.</p>${flash}<div class="card" style="margin-bottom:16px"><div class="card-head"><span class="title">Getting it ready</span></div>${readySteps(launched, false)}</div>${podLogSection(c, pulled.rig, now, true)}${podSection(c, pulled.rig, now)}<div class="cols run-cols"><div>${podHistory(undefined, pulled.rig, [], now)}</div><div class="side">${pullBlock(pulled, now)}</div></div>`,
        vs,
      );
    if (!u && pulled)
      return page(
        c,
        {
          title: pulled.rig,
          crumbs: [{ href: "/ui/rigs", text: "Rigs" }],
          summary: `pull mode · ${pulled.enrolled_at ? "enrolled" : "not enrolled"}`,
          active: "rigs",
        },
        `<p class="run-said">Control connects to ${esc(pulled.rig)} through RunPod's proxy. Its page fills in once the rig reports for the first time.</p>${flash}${pullBlock(pulled, now)}`,
        vs,
      );
    if (!u && placed)
      return page(
        c,
        {
          title: placed.rig,
          crumbs: [{ href: "/ui/rigs", text: "Rigs" }],
          summary: `on ${esc(placed.machine)} · ${esc(placed.status)}`,
          active: "rigs",
        },
        `<p class="run-said">Control is setting ${esc(placed.rig)} up on ${esc(placed.machine)}. Its page fills in once the rig reports for the first time.</p>${flash}${placedBlock(placed, csrf(c))}`,
        vs,
      );
    if (!u)
      return page(
        c,
        { title: "Not found", active: "rigs" },
        `<div class="card"><div class="empty">No such rig.</div></div>`,
        vs,
      );
    const t = csrf(c);
    const key = store.reportedRigs.key(u.id);
    const back = `/ui/rigs/${encodeURIComponent(u.id)}`;
    const place = placeOf(u.id);
    const rp = u.runpod;
    const podStopped = Boolean(rp?.active && rp.status === "EXITED");
    const steps = store.rigHistory.list(u.id);
    const stateIn = {
      u,
      place,
      control,
      controlSince: store.builds.controlSince(),
      staleAfterMs: opts.staleAfterMs,
      offlineAfterMs,
      steps,
      updating: updates.waiting(u.id),
      podStopped,
      csrf: t,
      now,
    };
    const refusedNow = u.version.state === "refused";
    const sup = u.supervisor as Record<string, unknown> | null;
    const obj = (x: unknown) => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});
    const ex = obj(sup?.export);
    /** A model file the supervisor downloads or downloaded, as its report says. */
    const modelLine = (x: unknown) => {
      const m = obj(x);
      const size = (b: unknown) => {
        const n = Number(b);
        return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
      };
      const name = `<b>${esc(String(m.name ?? "?"))}</b>`;
      if (m.state === "done") return `${name}: ${size(m.bytes)}, its SHA-256 checked`;
      if (m.state === "refused")
        return `${name}: <span class="bad">refused. Its SHA-256 did not match. The file was deleted.</span>`;
      if (m.state === "failed")
        return `${name}: <span class="bad">stopped. ${esc(String(m.error ?? "").slice(0, 300))}</span>`;
      const total = typeof m.total === "number" ? m.total : null;
      return `${name}: downloading, ${size(m.bytes)}${total ? ` of ${size(total)} (${Math.floor((100 * Number(m.bytes)) / Math.max(1, total))}%)` : ""}`;
    };
    const adv = sup?.advisors ? obj(sup.advisors) : null;
    // A drain under way (goal 136): a sentence, a card, and each trial it waits for by its lane.
    const drain = drainView(u, {
      store,
      now,
      csrf: t,
      cluster: onCluster?.status === "draining",
      form: (f) => cmdForm(c, { rig: u.id, back, ...f }),
    });
    const live = u.runs.filter((i) => i.status === "running");
    const runsNow = live
      .map((i) =>
        runBrief(store, u, i, now, {
          heading: true,
          detail: true,
          waiting: waitingOn(i, u),
          lane: drain?.lanes(i.id),
        }),
      )
      .join("");
    const checks: [string, string, string][] = [
      [
        "model",
        "Model route",
        "One short request through the rig's model route, as its workers and planner make them; it must come back as a correct tool call. Run it after the model server or its settings change, before resuming runs.",
      ],
      [
        "isolation",
        "Isolation",
        "Each role's user tries to reach what it must not: the judge's files, secrets, other roles' work, devices outside its grant. Needs an idle rig: pause its runs first, because each probe ends that role's processes.",
      ],
      [
        "smoke",
        "Judge smoke",
        "Known candidates (a real win, a no-op, broken changes, ways to cheat) must each get their expected verdict on this rig's own target. Minutes on a CPU, up to an hour on a GPU; its running runs are paused for it and resumed after.",
      ],
    ];
    const failed = checks.filter(([k]) => u.checks[k]?.finished_at && u.checks[k]?.ok === false);
    const j = u.judge.now;
    const queued = u.judge.queued.length;
    // The rig in a few sentences: is it reporting, what runs on it, its judge, what is wrong.
    const said = [
      rp ? podSaid(rp, now) : "",
      refusedNow
        ? `<b class="bad">Control refuses ${esc(u.id)}: it takes none of its reports.</b>`
        : podStopped
          ? "Its pod is stopped: its runs are paused, and only its volume costs money."
          : u.stale
            ? `<b class="bad">${esc(u.id)} has ${neverReported(u) ? "not reported yet" : `not reported for ${esc(span(u.last_seen, now))}`}.</b>`
            : `${esc(u.id)} is live; it reported ${esc(ago(u.last_seen, now))} ago.`,
      drain?.said ?? "",
      u.unreadable
        ? `<b class="bad">Control can't read its events now.</b>`
        : live.length
          ? `It runs ${live.map((i) => `<a href="${runHref(i)}">${esc(runCampaign(i))} › ${esc(i.id)}</a>`).join(" and ")}.`
          : u.runs.length
            ? "No run is at work on it."
            : "No campaign is assigned to it.",
      j
        ? `The judge is ${jobHtml(u, j)}${queued ? `, with ${queued} more queued` : ""}.`
        : `The judge is idle${queued ? `, with ${queued} queued` : ""}.`,
      failed.length
        ? `<b class="bad">Its ${failed.map(([, n]) => n.toLowerCase()).join(" and ")} check${failed.length > 1 ? "s" : ""} failed.</b>`
        : "",
      key.pending ? `<b class="warn">Its report key waits for your acceptance.</b>` : "",
      pulled?.error
        ? `<b class="bad">Control's last connection to its pod failed: ${esc(pulled.error)}</b>`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    // Each check's row in its state now: sent, running, its result, or why it did not run (goal 080).
    const rows = checkRowsOf(store, u.id, u.checks, now);
    const checkRows = refusedNow
      ? `<div class="empty">Control sends no command to a refused rig, so its checks can't run. Update it first.</div>`
      : checks
          .map(([k, name, what]) =>
            checkRowHtml({
              rig: u.id,
              check: k,
              name,
              what,
              row: rows[k] ?? checkRow(k, undefined, undefined, now),
              now,
              button: (label, disabled) =>
                cmdForm(c, {
                  rig: u.id,
                  kind: "rig_check",
                  fields: { check: k },
                  label,
                  back,
                  disabled,
                }),
            }),
          )
          .join("");
    const runRows = u.runs.map((i) => runRow(u, i, now, "campaign")).join("");
    const jobs = u.judge.jobs
      .slice(-8)
      .reverse()
      .map((x) => {
        const tone =
          x.state === "running"
            ? "info"
            : x.state === "done"
              ? "ok"
              : x.state === "queued"
                ? ""
                : "bad";
        const tag =
          x.state === "running"
            ? ` <span class="chip info">now</span>`
            : x.state === "queued"
              ? ` <span class="chip">queued</span>`
              : x.state !== "done"
                ? ` <span class="chip bad">${esc(x.state ?? "?")}</span>`
                : "";
        return `<div class="tl-row"><span class="tl-t">${esc(ago(x.finished_at ?? x.started_at ?? x.queued_at, now))}</span><span class="dot ${tone}"></span><span class="tl-s">${cap(jobHtml(u, x))}${tag}</span></div>`;
      })
      .join("");
    const h = u.hardware;
    const gib = (mib: number) => `${Math.round(mib / 1024)} GiB`;
    const hw = h
      ? [
          [
            "Judge",
            esc(
              h.devices
                .filter((d) => d.role !== "dev")
                .map((d) => d.name)
                .join(", ") || "the CPU",
            ),
          ],
          [
            "Dev runs",
            esc(
              h.device_mode === "dedicated"
                ? h.devices
                    .filter((d) => d.role === "dev")
                    .map((d) => d.name)
                    .join(", ")
                : h.device_mode === "shared"
                  ? "share the judge's device, and wait for it"
                  : "on the CPU",
            ),
          ],
          ["CPU", esc(`${h.cpu.quota ?? h.cpu.usable} of the host's ${h.cpu.host}`)],
          ["Memory", esc(gib(h.memory.limit_mib ?? h.memory.host_mib))],
          // Each report's reading against the rig's floor (goal 173), else the start's.
          ["Disk free", diskFree(u)],
        ]
          .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`)
          .join("")
      : "";
    const refusal = u.version.refused;
    const rigFacts = [
      [
        "Last report",
        neverReported(u)
          ? "none yet"
          : `${esc(ago(u.last_seen, now))} ago, at ${esc(u.last_seen.slice(11, 16))} UTC${refusedNow ? " (the last one control took)" : ""}`,
      ],
      ...(refusal
        ? [
            [
              "Calls refused",
              `${refusal.calls} in the last ${esc(span(refusal.since, now))}${refusal.last_at ? ` · the last one ${esc(ago(refusal.last_at, now))} ago` : ""}`,
            ],
          ]
        : []),
      ...(place.words ? [["Placed on", esc(place.words)]] : []),
      ["Key", `<code>${esc(key.pubkey ? fingerprint(key.pubkey) : "not pinned")}</code>`],
      ["Keys on the bus", busKeysHtml(store, u.id, now)],
      ["Ledger", `<code>${esc(u.ledger_id ?? "")}</code>`],
      ...(sup
        ? [
            [
              "Results",
              `${num(ex.exports)} exports${
                ex.remote === true
                  ? ` · <span title="${esc(ex.last_push_at ?? "")}">pushed ${esc(ago(String(ex.last_push_at ?? ""), now) || "?")} ago</span>`
                  : ex.to === "control"
                    ? `${
                        ex.last_upload_at
                          ? ` · <span title="${esc(ex.last_upload_at)}">sent to control ${esc(ago(String(ex.last_upload_at), now) || "?")} ago</span>`
                          : " · sent to control: none yet"
                      } · <a href="${exportsHref(u.id)}">its exports on control</a>`
                    : " · no results repository"
              }${typeof ex.waiting === "number" && ex.waiting > 0 ? ` · ${num(ex.waiting)} waiting to leave the rig` : ""}${ex.last_error ? `<div class="bad xs">${esc(String(ex.last_error).slice(0, 300))}</div>` : ""}`,
            ],
            ...(Array.isArray(sup.models) && sup.models.length
              ? [["Models", (sup.models as unknown[]).slice(0, 5).map(modelLine).join("<br>")]]
              : []),
            [
              "Advisors",
              adv
                ? `${num(adv.teacher_runs)} teacher rounds · ${num(adv.directive_sets)} directive sets · ${num(adv.audits)} audits · ${num(adv.errors)} errors · $${num(adv.usd).toFixed(2)}`
                : "none configured",
            ],
          ]
        : []),
    ]
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`)
      .join("");
    const events = rp
      ? podHistory(u, u.id, stateRows(stateIn), now)
      : `<div class="block"><div class="head"><h2>Recent</h2><span class="right">newest first</span></div>${timeline(
          u.recent.map((e) => ({ u, e })),
          now,
          { limit: 12, extra: stateRows(stateIn) },
        )}</div>`;
    const keyCard = key.pending
      ? `<div class="card warn" style="margin-bottom:16px"><div class="card-head">${icon.key}<span class="title">${key.pubkey ? "This rig now signs its reports with a different key" : "This rig's first report key waits for your acceptance"}</span></div>
<p class="small">Its reports are refused until you accept the key. A full reset keeps a rig's key: a change is expected only when the rig's identity was rebuilt on purpose. Check the fingerprint with the rig's deployment before accepting.</p>
<div class="row"><code>${esc(fingerprint(key.pending))}</code><span class="grow"></span><form class="inline" method="post" action="/ui/rigs/${encodeURIComponent(u.id)}/key/accept"><input type="hidden" name="csrf" value="${t}"><input type="hidden" name="fingerprint" value="${esc(fingerprint(key.pending))}"><button class="primary">Accept this key</button></form></div></div>`
      : "";
    const retireForm = `<form method="post" action="/ui/rigs/${encodeURIComponent(u.id)}/retire" class="stack" style="gap:8px"><input type="hidden" name="csrf" value="${t}">
<div class="small"><b>Retire it.</b> <span class="muted">For a rig that is gone: it leaves the rig lists and Needs you, and control refuses its reports. Its runs stay on their campaigns' pages, under Earlier runs. Its records stay, and you can bring it back. It stops nothing where the rig runs.</span>${rp?.active ? ` <b class="warn">Its pod keeps running at RunPod, and costs money: terminate it instead, under The pod.</b>` : ""}</div>
<input name="confirm" placeholder="type: retire ${esc(u.id)}" data-confirm="retire ${esc(u.id)}" aria-label="Type retire ${esc(u.id)} to confirm"><button class="danger" style="justify-content:center">Retire it</button></form>`;
    const actions = `<a class="btn" href="/ui/rigs/${encodeURIComponent(u.id)}/edit">Edit rig</a><a class="btn" href="/ui/rigs/${encodeURIComponent(u.id)}/live">${icon.terminal}Live</a>
${exportMenu({ csrf: t, rig: u.id, back })}
<details class="menu"><summary class="btn">${icon.dots}</summary><div class="menu-body">
${
  rp
    ? `<div class="muted small">Stop, start, restart, full reset and terminate are on the page, under The pod.</div>`
    : `${opts.driver ? `<form method="post" action="/ui/rigs/${encodeURIComponent(u.id)}/restart"><input type="hidden" name="csrf" value="${t}"><button style="width:100%;justify-content:center">Restart the rig's containers</button></form>` : `<div class="muted small">No deployment driver: restarts are not available.</div>`}
<div class="divider" style="margin:2px 0"></div>
<form method="post" action="/ui/rigs/${encodeURIComponent(u.id)}/reset" class="stack" style="gap:8px"><input type="hidden" name="csrf" value="${t}">
<div class="small"><b>Full reset.</b> <span class="muted">Pause, export, verify the push, then wipe after your confirmation.</span></div>
<input name="confirm" placeholder="type: reset ${esc(u.id)}" data-confirm="reset ${esc(u.id)}" aria-label="Type reset ${esc(u.id)} to confirm"><button class="danger" style="justify-content:center">Start the full reset</button></form>`
}
<div class="divider" style="margin:2px 0"></div>
${retireForm}</div></details>`;
    return page(
      c,
      {
        title: u.id,
        crumbs: [{ href: "/ui/rigs", text: "Rigs" }],
        summary: `${stateSummary(stateIn)}${rp ? ` · RunPod${podRuns(rp) && rp.price_per_hr !== null ? ` · $${rp.price_per_hr.toFixed(2)}/h` : ""}` : ""}`,
        actions,
        active: "rigs",
      },
      `<p class="run-said" data-part="said">${said}</p>
${flash}${u.unreadable ? `<div class="card warn" style="margin-bottom:16px"><b class="bad">Control can't read ${esc(u.id)}'s events now.</b> ${esc(u.unreadable)}. Until it can, its runs, checks and the judge's jobs are not shown here; the rest of this page is from its last report. Every other rig's pages are as they were.</div>` : ""}<div data-part="banners"${stateIn.updating ? ` data-follow="${esc(updateFollowUrl(u.id))}" data-follow-state="${esc(updateProgress(u.id).state)}"` : ""}>${stateBanners(stateIn)}${diskBanner(u, now)}${drain?.banner ?? ""}</div>${keyCard}
${rp ? podSection(c, u.id, now) : ""}
<div data-part="at-work">${runsNow ? `<div class="block"><div class="head"><h2>At work</h2><span class="n">${live.length}</span></div>${runsNow}</div>` : ""}</div>
<div class="cols run-cols"><div>
<div class="block" data-part="checks"${takingModel(u.model, store.agentModels.byRig()[u.id]) ? ` data-follow="${esc(modelFollowUrl(u.id))}" data-follow-state="taking"` : ""}><div class="head"><h2>Checks</h2><span class="right">run by the rig itself; each result also goes to its history</span></div><div class="card flat cks">${checkRows}</div></div>
<div class="block" data-part="runs"><div class="head"><h2>Runs on this rig</h2><span class="n">${u.runs.length}</span>${u.state !== "reporting" || refusedNow ? `<span class="right">as of its last report${neverReported(u) ? "" : `, ${esc(ago(u.last_seen, now))} ago`}</span>` : ""}</div>${runRows ? `<div class="card flat">${runRows}</div>` : `<div class="card"><div class="empty">No campaign assigned.</div></div>`}</div>
${rp ? events : ""}
<div class="block" data-part="jobs"><div class="head"><h2>The judge's last jobs</h2></div>${jobs ? `<div class="card flat tl">${jobs}</div>` : `<div class="card"><div class="empty">No job yet.</div></div>`}</div>
${rp ? podLogSection(c, u.id, now, false) : ""}
</div><div class="side">
<div class="block"><div class="head"><h2>What it runs on</h2></div>${h ? `<div class="card"><dl class="facts">${hw}</dl></div><details class="card flat matrix" data-k="hw-${esc(u.id)}" style="margin-top:10px"><summary>Every detail</summary>${hardwareCard(h, now)}</details>` : hardwareCard(h, now)}</div>
<div class="block" data-part="rig"><div class="head"><h2>The rig</h2></div><div class="card"><dl class="facts">${versionFact(stateIn)}${rigFacts}</dl>${sup ? `<div class="muted xs" style="margin-top:8px">The supervisor reports its figures itself (unsigned).</div>` : ""}</div></div>
${placed ? placedBlock(placed, t) : ""}${onCluster ? clusterPlacedBlock(onCluster, t) : ""}${joined ? joinedBlock(joined, t, undefined, true) : ""}${pulled ? pullBlock(pulled, now) : ""}
${rp ? "" : events}
</div></div>`,
      vs,
    );
  });

  // The blocks a rig's place adds to its page: control's setup, on a cluster or a machine, and
  // pull mode.
  /** A rig control set up on a cluster: where, its setup history, and its controls. */
  const clusterPlacedBlock = (r: ClusterRig, t: string) => {
    const rName = encodeURIComponent(r.rig);
    const act = (action: string, label: string, extra = "", cls = "sm") =>
      `<form class="inline" method="post" action="/ui/rigs/${rName}/cluster/${action}"${action === "remove" ? "" : " data-act"}><input type="hidden" name="csrf" value="${t}">${extra}<button class="${cls}">${label}</button></form>`;
    const s = r.spec;
    const manage =
      r.status === "removed" || r.status === "deploying"
        ? ""
        : `<div class="act" style="margin-top:10px">${r.status === "stopped" ? act("start", "Start its pods") : act("stop", "Stop its pods")}${act("restart", "Restart them")}</div>
<details style="margin-top:8px"><summary class="small">Remove it from ${esc(r.cluster)}</summary><div class="small muted" style="margin:6px 0">${r.placement === "created" ? "Deletes its namespace, with everything in it," : "Deletes its deployments, service, volume claim and secret from the slot,"} and retires its token. ${esc(removeWords(r.rig))}</div>${act("remove", "Remove the rig", `<input name="confirm" placeholder="type: remove ${esc(r.rig)}" style="margin-right:6px">`, "sm danger")}</details>`;
    const want = controlImages(parts, s.gpus);
    const keeps =
      "Its volume, tokens, runs and results stay. Running trials and the judge's job under way finish first: the rig starts nothing new meanwhile. Update now skips the wait: a trial in progress then stops, and its experiment goes back to the queue.";
    // New images; or the same ones after a failed update (a retry); or a new address for control.
    // Draining for an update (goal 079): what it waits for, and the two ways out.
    const work = rigWork(parts, r.rig);
    const waits = `${work ? `It waits for ${esc(workWords(work))} to finish, and starts nothing new.` : "It waits for its next report."} Its pods restart as soon as nothing runs.`;
    const draining =
      r.status === "draining" && r.pending
        ? `<div class="small" style="margin-top:12px">Draining before its pods restart with ${esc(sizeWords(r.pending))}.</div><div class="small muted" style="margin:4px 0 6px">${waits} Its volume, tokens, runs and results stay.</div>${act("resources-now", "Change now, without waiting")}${act("drain-cancel", "Call the change off")}`
        : r.status === "draining" && typeof want !== "string"
          ? `<div class="small" style="margin-top:12px">Draining before its pods restart on control's images:<div class="mono">${esc(want.harness)}<br>${esc(want.supervisor)}</div></div><div class="small muted" style="margin:4px 0 6px">${waits}</div>${act("images-now", "Update now, without waiting")}${act("drain-cancel", "Call the update off")}`
          : "";
    const update = draining
      ? draining
      : !manage || typeof want === "string"
        ? ""
        : want.harness !== s.images.harness || want.supervisor !== s.images.supervisor
          ? `<div class="small" style="margin-top:12px">Control now deploys other images:<div class="mono">${esc(want.harness)}<br>${esc(want.supervisor)}</div></div><div class="small muted" style="margin:4px 0 6px">Its pods restart on these images. ${keeps} After a newer harness has opened its ledger, an older image may not open it.</div>${act("images", "Update to these images")}`
          : r.status === "failed"
            ? `<div class="small" style="margin-top:12px">The last change to its pods failed (see the steps above). Try it again on control's images:<div class="mono">${esc(want.harness)}<br>${esc(want.supervisor)}</div></div><div class="small muted" style="margin:4px 0 6px">${keeps}</div>${act("images", "Try the update again")}`
            : s.controlUrl && controlAddress(parts) && s.controlUrl !== controlAddress(parts)
              ? `<div class="small" style="margin-top:12px">Control's address for rigs changed: the rig reports to <span class="mono">${esc(s.controlUrl)}</span>, control is now at <span class="mono">${esc(controlAddress(parts) ?? "")}</span>.</div><div class="small muted" style="margin:4px 0 6px">Its pods restart with the new address, on the same images. ${keeps}</div>${act("images", "Give it control's new address")}`
              : "";
    return `<div class="block" ${placeAttrs(r.rig, r.status)}><div class="head"><h2>Set up by control</h2><span class="right">${esc(r.status)}</span></div><div class="card"><dl class="facts"><dt>Cluster</dt><dd><a href="/ui/settings">${esc(r.cluster)}</a> (Providers)</dd><dt>Namespace</dt><dd>${esc(r.namespace)} <span class="muted">(${r.placement === "created" ? "made by control" : "a slot"})</span></dd><dt>GPUs</dt><dd>${s.gpus ? `${s.gpus} through ${s.gpuMode === "dra" ? `DRA (${esc(s.deviceClass ?? "")})` : "NVIDIA's device plugin"}: ${splitWords(s.gpus, s.judgeGpus)}` : "none: it measures on the CPU"}${s.node ? ` · on ${esc(s.node)}` : ""}</dd><dt>CPUs and memory</dt><dd>${s.resources ? esc(resourcesWords(s.resources)) : "the namespace's defaults"}${manage ? ` · <a href="/ui/rigs/${rName}/edit">change on Edit rig</a>` : ""}</dd><dt>Storage</dt><dd>${s.storageGi} GB${s.storageClass ? ` · ${esc(s.storageClass)}` : ""}</dd><dt>Its harness reaches</dt><dd>${rigReachHtml(r, store.reachable.list())}</dd><dt>Images</dt><dd class="mono small">${esc(s.images.harness)}<br>${esc(s.images.supervisor)}</dd></dl>${slotIngressWarning(r)}
<div class="tl" style="margin-top:10px">${setupSteps(r.rig) || `<div class="muted small">No step yet.</div>`}</div>${manage}${update}</div></div>`;
  };
  /** A rig in pull mode: its pod, its enrollment, control's last connection and the refusals. */
  const pullBlock = (r: TunnelRig, now: number) => {
    const state = !r.pod
      ? "waiting for its pod"
      : r.enrolled_at
        ? "enrolled"
        : "waiting for enrollment";
    const enrollment = r.enrolled_at
      ? `Enrolled ${esc(ago(r.enrolled_at, now))} ago. Control pinned the pod's keys, and the code is spent.`
      : r.code_expires_at
        ? Date.parse(r.code_expires_at) < now
          ? `<span class="bad">The code expired ${esc(ago(r.code_expires_at, now))} ago. Launch the rig again.</span>`
          : `Not yet. The code expires in ${esc(span(new Date(now).toISOString(), Date.parse(r.code_expires_at)))}.`
        : "Not yet. The code does not expire.";
    // Where control's bus reaches the pod's leaf node, as RunPod gives it (bus/leaf.ts).
    const bus = !r.leaf_ca
      ? `<span class="muted">Not on it: launched before the pod's leaf node. It reports through this connection.</span>`
      : r.leaf_address
        ? `Control's bus dials the pod's leaf node at <span class="mono">${esc(r.leaf_address)}</span>, the address RunPod gave it ${esc(ago(r.leaf_address_at ?? "", now))} ago.`
        : `<span class="muted">No address from RunPod now: the pod is starting or stopped. Its reports wait for one.</span>`;
    return `<div class="block"><div class="head"><h2>Pull mode</h2><span class="right">${esc(state)}</span></div><div class="card"><p class="small" style="margin-top:0">Control connects to this rig through RunPod's proxy. The rig never connects to control. The pod answers only requests that control signed.</p><dl class="facts"><dt>Pod</dt><dd>${r.pod ? esc(r.pod) : `<span class="muted">not launched yet</span>`}</dd>${r.url ? `<dt>Address</dt><dd class="mono small">${esc(r.url)}</dd>` : ""}<dt>Enrollment</dt><dd>${enrollment}</dd><dt>Message bus</dt><dd>${bus}</dd><dt>Last exchange</dt><dd>${r.last_exchange_at ? `${esc(ago(r.last_exchange_at, now))} ago` : `<span class="muted">none yet</span>`}</dd><dt>Refused requests</dt><dd>${r.refused_total}${r.refused_total ? ` <span class="muted small">Requests that control did not sign. The pod gave each one an empty 404.</span>` : ""}</dd>${r.error ? `<dt>Last error</dt><dd class="bad">${esc(r.error)}</dd>` : ""}</dl></div></div>`;
  };
  const placeAttrs = (rig: string, status: string) =>
    `data-part="placed"${PLACE_BUSY.has(status) ? ` data-follow="${esc(placeFollowUrl(rig))}" data-follow-state="${esc(placeProgress(rig).state)}"` : ""}`;
  /** A rig control set up: where, its setup history, and stop, start, restart and remove. */
  const placedBlock = (r: MachineRig, t: string) => {
    const rName = encodeURIComponent(r.rig);
    const steps = setupSteps(r.rig);
    const act = (action: string, label: string, extra = "", cls = "sm") =>
      `<form class="inline" method="post" action="/ui/rigs/${rName}/machine/${action}"${action === "remove" ? "" : " data-act"}><input type="hidden" name="csrf" value="${t}">${extra}<button class="${cls}">${label}</button></form>`;
    const manage =
      r.status === "removed" || r.status === "deploying"
        ? ""
        : `<div class="act" style="margin-top:10px">${r.status === "stopped" ? act("start", "Start its services") : act("stop", "Stop its services")}${act("restart", "Restart them")}</div>
<details style="margin-top:8px"><summary class="small">Remove it from ${esc(r.machine)}</summary><div class="small muted" style="margin:6px 0">Stops its services and deletes its units, files and volumes on the machine, and retires its token. ${esc(removeWords(r.rig))}</div>${act("remove", "Remove the rig", `<input name="confirm" placeholder="type: remove ${esc(r.rig)}" style="margin-right:6px">`, "sm danger")}</details>`;
    return `<div class="block" ${placeAttrs(r.rig, r.status)}><div class="head"><h2>Set up by control</h2><span class="right">${esc(r.status)}</span></div><div class="card"><dl class="facts"><dt>Machine</dt><dd><a href="/ui/settings">${esc(r.machine)}</a> (Providers)</dd><dt>GPUs</dt><dd>${r.gpus.length ? gpuRoles(r.gpus, r.judge_gpus) : "none: it measures on the CPU"}</dd><dt>Images</dt><dd class="mono small">${esc(r.images.harness)}<br>${esc(r.images.supervisor)}</dd></dl>
<div class="tl" style="margin-top:10px">${steps || `<div class="muted small">No step yet.</div>`}</div>${manage}</div></div>`;
  };

  // RunPod rigs (goals 022, 023): their pod's blocks on the rig's page.
  /** "rp-1 is a RunPod pod with 1 × A100 PCIe, on Secure cloud in EU-RO-1. It has cost $9.80…" */
  const podSaid = (v: NonNullable<RigView["runpod"]>, now: number) => {
    const spent = v.spend_usd ?? v.spent_usd;
    if (!v.active || v.status === "TERMINATED")
      return `${esc(v.rig)}'s pod is terminated. It cost <b>$${spent.toFixed(2)}</b> in all.`;
    return `${esc(v.rig)} is a RunPod pod with ${v.gpu_count} × ${esc(v.gpu_name)}, on ${v.cloud_type === "SECURE" ? "Secure" : "Community"} cloud${v.datacenter ? ` in ${esc(v.datacenter)}` : ""}. It has cost <b>$${spent.toFixed(2)}</b> since it was launched ${esc(ago(v.launched_at, now))} ago.`;
  };
  const podSummary = (v: NonNullable<RigView["runpod"]>) =>
    !v.active || v.status === "TERMINATED"
      ? `<span class="muted">terminated</span> · RunPod`
      : v.status === "EXITED"
        ? `<span class="muted">stopped</span> · RunPod`
        : `<span class="${v.status === "RUNNING" ? "ok" : "warn"}">${esc(v.status.toLowerCase())}</span> · RunPod${v.price_per_hr !== null ? ` · $${v.price_per_hr.toFixed(2)}/h` : ""}`;
  /** A RunPod rig's pod block: its cost, limits, lifecycle and the results still in it. */
  const podSection = (c: Ctx, rig: string, now: number) => {
    const v = opts.runpodRigs?.view(rig);
    if (!v) return "";
    const name = v.op?.export ?? v.last_export ?? null;
    return podBlock({
      v,
      t: csrf(c),
      now,
      results: resultsLeft(store, rig),
      lastExport: name ? { name, left: exportLeft(store, rig, name) } : null,
      resetOpen: Boolean(store.fullResets.open(rig)),
      minIdle: MIN_IDLE_STOP_MINUTES,
    });
  };
  /**
   * A RunPod rig's pod log, as last read (Read again reads it now). `auto`: before the rig's first
   * report, the page reads it once as it opens when nothing was read yet. None for a pod that is
   * gone: RunPod keeps no log of it.
   */
  const podLogSection = (c: Ctx, rig: string, now: number, auto: boolean) => {
    const v = opts.runpodRigs?.view(rig);
    if (!v?.active || v.status === "TERMINATED") return "";
    return podLogBlock({ rig, kept: opts.runpodRigs?.lastLog(rig), t: csrf(c), now, auto });
  };
  /** A RunPod rig's history: the pod's steps, the rig's events and its state's lines, filtered. */
  const podHistory = (u: RigView | undefined, rig: string, extra: TimelineRow[], now: number) =>
    `<div class="block"><div class="head"><h2>History</h2><span class="right">newest first</span></div>${HISTORY_FILTERS}${timeline(
      u ? u.recent.map((e) => ({ u, e })) : [],
      now,
      {
        limit: 40,
        kinds: true,
        extra: [...podRows(store.rigHistory.list(rig)), ...extra],
        id: "hist",
      },
    )}</div>`;
}
