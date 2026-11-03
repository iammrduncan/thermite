import { every } from "../../common/health.ts";
import { inBackground } from "../background.ts";
import { issueCommand } from "../issue/index.ts";
import type { ControlParts } from "../parts.ts";
import type { ControlStore } from "../store/index.ts";
import { workOf } from "../views/index.ts";
import { updateRigImages } from "./images.ts";
import { applyResize, setClusterRigResources } from "./resize.ts";
import { IMAGES_REASON, RESIZE_REASON, rigWork, undrain, workWords } from "./rigs.ts";

/** How often the drain watch looks at a draining rig's report by default. */
const DRAIN_WATCH_MS = 10_000;

/** The owner calls the update off: the rig goes back to work on its images. */
export function cancelDrain(
  parts: ControlParts,
  rig: string,
  by: string,
): { ok: string } | { error: string } {
  const { store } = parts;
  const r = store.clusters.rig(rig);
  if (r?.status !== "draining") return { error: `${rig} is not draining.` };
  undrain(parts, rig, by);
  store.clusters.setRigStatus(rig, "running");
  if (r.pending) {
    store.rigHistory.add(
      rig,
      "drain",
      true,
      "called off: the rig goes back to work with its GPUs, CPUs and memory as they were",
    );
    return { ok: `${rig} goes back to work with its GPUs, CPUs and memory as they were.` };
  }
  store.rigHistory.add(rig, "drain", true, "called off: the rig goes back to work on its images");
  return { ok: `${rig} goes back to work on its images.` };
}

/** A drain as a rig's last report gives it, with what still runs; undefined when none. */
function drainOf(parts: ControlParts, rig: string) {
  const w = workOf(parts.store.reportedRigs.list().find((x) => x.id === rig)?.summary);
  return w?.draining ? { ...w, draining: w.draining } : undefined;
}

/** The step a drain's deadline leaves in its rig's history (goal 173). */
export const DEADLINE_STEP = "drain_deadline";

/**
 * A drain past its deadline (goal 173), as its harness reports it: the rig's history records the
 * step once, with what still runs, and Needs you asks the owner. Nothing is chosen for the owner:
 * the rig goes on starting nothing new.
 */
function noteDeadline(parts: ControlParts, rig: string): void {
  const d = drainOf(parts, rig);
  if (!d?.draining.deadline_reached) return;
  const since = Date.parse(d.draining.since);
  const noted = parts.store.rigHistory
    .list(rig)
    .some((s) => s.step === DEADLINE_STEP && Date.parse(s.at) >= since);
  if (noted) return;
  const minutes = Math.round((Date.parse(d.draining.deadline_reached) - since) / 60_000);
  parts.store.rigHistory.add(
    rig,
    DEADLINE_STEP,
    false,
    `its deadline passed after ${minutes} min, with ${workWords(d)} still at work: it starts nothing new until you choose, under Needs you or on its page`,
  );
}

/** What the owner's choice does at a drain's deadline, in words, before it is made (goal 173). */
export function drainChoices(
  store: ControlStore,
  rig: string,
): { apply: { label: string; does: string }; end: { label: string; does: string } } {
  const r = store.clusters.rig(rig);
  const onCluster = r?.status === "draining";
  return {
    apply: onCluster
      ? r.pending
        ? {
            label: "Change its size now",
            does: "Its pods restart now with the new GPUs, CPUs or memory. A trial in progress stops and its task goes back to its run's queue; the judge's job under way is taken back at the next start.",
          }
        : {
            label: "Update it now",
            does: "Its pods restart now on control's images. A trial in progress stops and its task goes back to its run's queue; the judge's job under way is taken back at the next start.",
          }
      : {
          label: "Stop what still runs",
          does: "Each trial the drain waits for stops: it ends as interrupted, and its task goes back to its run's queue. The judge's job under way ends as it would. The rig still drains, for the change you drained it for.",
        },
    end: {
      label: "End the drain",
      does: onCluster
        ? `The rig goes back to work as it is, and the ${r.pending ? "change of size" : "update"} is called off: ask for it again later.`
        : "The rig goes back to work, and starts new trials and judge's jobs again. Drain it again when you are ready for the change.",
    },
  };
}

/**
 * The owner's choice at a drain's deadline (goal 173), on any rig that drains. `apply`: the change
 * goes ahead now, stopping what still runs (a cluster rig's update or new size, or, on a rig whose
 * change is not control's, each trial the drain waits for); `end`: the rig goes back to work, and
 * the change waits. Each is a step in the rig's history.
 */
export async function chooseAtDeadline(
  parts: ControlParts,
  rig: string,
  choice: "apply" | "end",
  by: string,
): Promise<{ ok: string } | { error: string }> {
  const { store } = parts;
  const r = store.clusters.rig(rig);
  const d = drainOf(parts, rig);
  if (r?.status === "draining") {
    if (choice === "end") return cancelDrain(parts, rig, by);
    store.rigHistory.add(rig, "drain", true, "at its deadline the owner chose to go ahead now");
    const done = r.pending
      ? await setClusterRigResources(parts, rig, {}, by, { wait: false, owner: true })
      : await updateRigImages(parts, rig, by, { wait: false });
    return "error" in done ? { error: done.error } : { ok: done.ok };
  }
  if (!d) return { error: `${rig} is not draining.` };
  if (choice === "end") {
    issueCommand(store, parts.privateKeyPem, {
      rig,
      kind: "drain_rig",
      payload: { drain: false, reason: "the owner ended the drain at its deadline" },
      issuedBy: by,
    });
    store.rigHistory.add(rig, "drain", true, "ended by the owner at its deadline: back to work");
    return { ok: `${rig} goes back to work.` };
  }
  const open = d.open ?? [];
  if (!open.length)
    return {
      ok: `${rig} runs no trial now${d.judge_jobs ? ": the judge's job under way ends as it would" : ""}. It still drains, for your change.`,
    };
  for (const t of open)
    issueCommand(store, parts.privateKeyPem, {
      rig,
      kind: "stop_trial",
      payload: { run: t.run, trial: t.trial, reason: "the drain reached its deadline" },
      issuedBy: by,
    });
  const n = open.length === 1 ? "1 trial" : `${open.length} trials`;
  store.rigHistory.add(rig, "drain", true, `at its deadline the owner stopped ${n}`);
  return {
    ok: `${n} of ${rig} stop${open.length === 1 ? "s" : ""} now, each with its task back in its run's queue. It still drains, for your change.`,
  };
}

/**
 * A draining rig's pods restart once its report says nothing runs any more (goal 079), on new
 * images or with the new size it waits for (goal 118); its report is looked at every `everyMs`.
 * A rig whose change is still being applied is not applied again. Each round also notes a drain
 * that reached its deadline, on any rig (goal 173). The watch is one of control's loops, and never
 * keeps control from exiting.
 */
export function watchDrains(parts: ControlParts, everyMs = DRAIN_WATCH_MS): void {
  const { store } = parts;
  /**
   * A harness keeps its drain in memory only: one that started again since it took the drain
   * reports none, and goes back to work. Asked again, it drains again: once the last ask is taken
   * and two reports after it say no drain. One is not enough: a report's summary can be read
   * before the drain took effect and reach control after the ask was taken.
   */
  const undrained = new Map<string, { ask: string; seen: string }>();
  const redrain = (rig: string) => {
    const last = store.commands.latest(rig, "drain_rig", 1)[0];
    if (last?.payload.drain !== true || last.status === "pending" || !last.acked_at) return;
    const seen = store.reportedRigs.list().find((x) => x.id === rig)?.last_seen;
    if (!seen || Date.parse(seen) <= Date.parse(last.acked_at)) return;
    const first = undrained.get(rig);
    if (first?.ask !== last.id) {
      undrained.set(rig, { ask: last.id, seen });
      return;
    }
    if (first.seen === seen) return;
    undrained.delete(rig);
    issueCommand(store, parts.privateKeyPem, {
      rig,
      kind: "drain_rig",
      payload: {
        drain: true,
        reason: store.clusters.rig(rig)?.pending ? RESIZE_REASON : IMAGES_REASON,
      },
      issuedBy: "control:drain",
    });
    store.rigHistory.add(
      rig,
      "drain",
      true,
      "its harness started again and was not draining: asked again",
    );
  };
  const moving = new Set<string>();
  every(parts.loops, "control", "drains", everyMs, () => {
    for (const u of store.reportedRigs.list()) noteDeadline(parts, u.id);
    for (const r of store.clusters.rigs().filter((x) => x.status === "draining")) {
      if (moving.has(r.rig)) continue;
      const w = rigWork(parts, r.rig);
      if (w && w.draining === null) redrain(r.rig);
      else undrained.delete(r.rig);
      if (!w || w.draining === null || w.trials > 0 || w.judge_jobs > 0) continue;
      store.rigHistory.add(r.rig, "drain", true, "nothing runs any more: its pods restart now");
      moving.add(r.rig);
      const move = r.pending
        ? applyResize(parts, r.rig, r.pending, "control:drain")
        : updateRigImages(parts, r.rig, "control:drain", { wait: false });
      void inBackground(store, "cluster", r.rig, r.pending ? "resources" : "images", move).finally(
        () => moving.delete(r.rig),
      );
    }
  });
}
