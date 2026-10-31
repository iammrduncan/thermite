import { clip } from "../../../core/kb-index.ts";
import { currentChampion } from "../facts.ts";
import { frozen } from "../sharing.ts";
import type { BaselineView } from "../types.ts";
import type { Handler, Handlers } from "./index.ts";

/**
 * Champions and promotions: a hill climb's starting point and its baseline, wins waiting for the
 * owner or an audit, champions promoted, reopened and published, and those received from other
 * rigs.
 */

/** A hill climb's baseline from its event's body (goal 115), each field checked. */
function baselineView(at: string, b: Record<string, unknown>): BaselineView {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const txt = (v: unknown, n = 200) => (typeof v === "string" ? clip(v, n) : "");
  const dir = (v: unknown) => (v === "min" ? "min" : "max");
  const p = (b.primary ?? null) as Record<string, unknown> | null;
  const cells = (b.cells ?? {}) as Record<string, Record<string, Record<string, unknown>>>;
  return {
    at,
    champion_seq: num(b.champion_seq) || 1,
    commit: txt(b.commit, 80),
    attempt: typeof b.attempt === "string" ? clip(b.attempt, 80) : null,
    blocks: num(b.blocks),
    runs_per_cell: num(b.runs_per_cell),
    primary:
      p && typeof p.metric === "string"
        ? { metric: txt(p.metric), direction: dir(p.direction) }
        : null,
    guards: (Array.isArray(b.guards) ? b.guards : []).slice(0, 50).flatMap((x) => {
      const g = (x ?? {}) as Record<string, unknown>;
      return typeof g.metric === "string"
        ? [
            {
              metric: txt(g.metric),
              direction: dir(g.direction),
              max_total_regression: num(g.max_total_regression),
            },
          ]
        : [];
    }),
    units: Object.fromEntries(
      Object.entries((b.units ?? {}) as Record<string, unknown>)
        .slice(0, 100)
        .map(([k, v]) => [clip(k, 200), txt(v, 40)]),
    ),
    cells: Object.entries(cells)
      .slice(0, 200)
      .map(([cell, metrics]) => ({
        cell: clip(cell, 200),
        metrics: Object.entries(metrics ?? {})
          .slice(0, 100)
          .map(([metric, v]) => ({
            metric: clip(metric, 200),
            median: num(v?.median),
            mad: num(v?.mad),
            n: num(v?.n),
          })),
      })),
    files: (Array.isArray(b.files) ? b.files : []).slice(0, 1000).flatMap((x) => {
      const f = (x ?? {}) as Record<string, unknown>;
      return typeof f.path === "string"
        ? [{ path: clip(f.path, 300), bytes: num(f.bytes), sha256: txt(f.sha256, 64) }]
        : [];
    }),
    bytes: num(b.bytes),
    summary: txt(b.summary, 1000),
  };
}

/** An audit's end, or the owner's: the attempt's newest audit in each run says how it ended. */
const auditEnded: Handler = (f, e, b) => {
  for (const v of f.runs.values()) {
    const a = v.audits.filter((x) => x.attempt === e.subject).at(-1);
    if (a) {
      a.decision =
        e.kind === "audit_overridden"
          ? "overridden by the owner"
          : e.kind === "promotion_declined"
            ? "declined by the owner"
            : String(b.decision);
      if (typeof b.reasons === "string") a.reasons = b.reasons;
    }
  }
};

/** Another rig's champion this rig's judge accepted or rejected. */
const propagationDecided: Handler = (f, e, b) => {
  const p = f.run(String(e.subject)).propagations.find((x) => x.attempt === b.attempt);
  if (p)
    p.result = e.kind === "propagation_accepted" ? "accepted" : `rejected (${String(b.verdict)})`;
};

export const CHAMPIONS: Handlers = {
  champion_promoted(f, e, b) {
    const v = f.run(String(e.subject));
    const attempt = (b.attempt as string | null) ?? null;
    // A setup change that became the starting point (goal 115): the gain starts again.
    const setup = b.setup === true;
    const delta = attempt && !setup ? (f.confirmDelta.get(attempt) ?? null) : null;
    const prev = currentChampion(v);
    v.champion.push({
      seq: Number(b.seq),
      attempt,
      commit: String(b.commit ?? ""),
      at: e.at,
      delta,
      cumulative: setup ? 1 : (prev?.cumulative ?? 1) * (1 + (delta ?? 0)),
      reopened: false,
      ...(setup ? { setup: true } : {}),
    });
    v.pending_promotions = v.pending_promotions.filter((p) => p !== attempt);
  },
  // The owner withdrew evidence (goal 174): what it reached, in its run's view.
  invalidation(f, e, b) {
    const subject = String(e.subject ?? "");
    const run = typeof b.run === "string" && b.run ? b.run : (f.attempts.get(subject)?.run ?? null);
    if (!run) return;
    const list = (v: unknown) => (Array.isArray(v) ? v : []);
    f.run(run).invalidations.push({
      id: typeof b.id === "number" ? b.id : 0,
      at: e.at,
      by: e.actor,
      kind: b.kind === "job" ? "job" : "attempt",
      subject: clip(subject, 80),
      reason: clip(String(b.reason ?? ""), 2000),
      attempts: list(b.attempts)
        .slice(0, 1000)
        .map((x) => clip(String(x), 80)),
      verdicts: list(b.verdicts).length,
      champions: list(b.champions).map(Number),
      champion: null,
    });
  },
  champion_moved_back(f, e, b) {
    const v = f.run(String(e.subject));
    const i = v.invalidations.find((x) => x.id === Number(b.invalidation));
    if (i)
      i.champion = {
        from: Number(b.from),
        to: Number(b.to),
        attempt: typeof b.attempt === "string" ? b.attempt : null,
      };
  },
  champion_reopened(f, e, b) {
    const v = f.run(String(e.subject));
    const step = v.champion.find((c) => c.seq === Number(b.seq));
    if (step) step.reopened = true;
    // A published champion withdrawn (goal 174): the run's published one is the newest that
    // stands, or none, so neither its download nor a propagation offers the withdrawn one.
    if (v.published?.seq === Number(b.seq)) {
      const standing = new Set(v.champion.filter((c) => !c.reopened).map((c) => c.seq));
      const back = v.published_patches.filter((p) => standing.has(p.seq)).at(-1);
      v.published = back
        ? {
            seq: back.seq,
            repo: back.repo,
            base_commit: back.base_commit,
            tree: v.published_trees[back.seq] ?? "",
            sha256: back.sha256,
            path: back.path,
          }
        : null;
    }
    // A starting point withdrawn takes its baseline with it (goal 115).
    if (v.baseline?.champion_seq === Number(b.seq)) v.baseline = null;
  },
  // A hill climb's baseline (goal 115): the judge measured its starting point.
  baseline(f, e, b) {
    const v = f.run(String(e.subject));
    v.baseline = baselineView(e.at, b);
    v.setup = null;
    v.baseline_waiting = false;
  },
  // The judge could not measure the starting point: the run is in setup.
  baseline_failed(f, e, b) {
    const v = f.run(String(e.subject));
    v.baseline = null;
    v.baseline_waiting = false;
    v.setup = {
      at: e.at,
      champion_seq: Number(b.champion_seq ?? 1),
      commit: String(b.commit ?? ""),
      reasons: clip(String(b.reasons ?? ""), 4000),
      summary: clip(String(b.summary ?? ""), 1000),
    };
  },
  promotion_pending(f, e, b) {
    const v = f.run(String(b.run));
    if (!v.pending_promotions.includes(String(e.subject))) {
      v.pending_promotions.push(String(e.subject));
    }
    v.promotion_waits[String(e.subject)] = {
      expected_seq: typeof b.expected_seq === "number" ? b.expected_seq : null,
      reason: typeof b.reason === "string" ? b.reason : null,
      at: e.at,
    };
  },
  audit_requested(f, e, b) {
    f.run(String(b.run)).audits.push({
      attempt: String(e.subject),
      reason: String(b.reason ?? ""),
      decision: null,
      at: e.at,
      expected_seq: typeof b.expected_seq === "number" ? b.expected_seq : null,
      reasons: null,
    });
  },
  audit_skipped(f, e, b) {
    // No auditor decides it (goal 079): the run's own rules did.
    const a = f
      .run(String(b.run))
      .audits.filter((x) => x.attempt === e.subject)
      .at(-1);
    if (a && a.decision === null) {
      a.decision = "skipped";
      a.reasons = String(b.why ?? "this rig has no auditor");
    }
  },
  audit_decided: auditEnded,
  audit_overridden: auditEnded,
  promotion_declined: auditEnded,
  champion_published(f, e, b) {
    f.run(String(e.subject)).published_trees[Number(b.seq)] = String(b.tree);
    f.run(String(e.subject)).published_patches.push(
      frozen({
        seq: Number(b.seq),
        sha256: String(b.sha256 ?? ""),
        base_commit: String(b.base_commit ?? ""),
        repo: (b.repo as string | null) ?? null,
        path: String(b.path ?? ""),
      }),
    );
    f.run(String(e.subject)).published = {
      seq: Number(b.seq),
      repo: (b.repo as string | null) ?? null,
      base_commit: String(b.base_commit),
      tree: String(b.tree),
      sha256: String(b.sha256),
      path: String(b.path),
    };
  },
  propagation_received(f, e, b) {
    f.run(String(e.subject)).propagations.push({
      attempt: (b.attempt as string | null) ?? null,
      source_rig: String(b.source_rig),
      source_run: String(b.source_run),
      source_seq: Number(b.source_seq),
      tree: (b.tree as string | undefined) ?? null,
      result: String(b.result ?? "judging"),
    });
  },
  propagation_accepted: propagationDecided,
  propagation_rejected: propagationDecided,
};
