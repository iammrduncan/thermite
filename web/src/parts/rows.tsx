import type { EventRow, NeedRow, NowLine, RunRow } from "@core/api/control/dashboard.ts";
import { ArrowUpRightIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { follow, to } from "@/nav.ts";
import { RunFigure } from "./figure.tsx";
import { ModeAvatar } from "./mode-avatar.tsx";
import { StatusBadge } from "./status-badge.tsx";
import { Since } from "./time.tsx";
import { toneBadge, toneDot, toneText } from "./tone.ts";

/** A run's own address in the app. */
export const runPath = (r: { campaign: string | null; run: string | null }) =>
  to(`/campaigns/${encodeURIComponent(r.campaign ?? "")}/runs/${encodeURIComponent(r.run ?? "")}`);

/** Where a thing is, as one line: its campaign and run, its rig, its lane. */
function Where({ where }: { where: NeedRow["where"] }) {
  const parts = [
    where.campaign && where.run ? `${where.campaign} › ${where.run}` : null,
    where.rig,
    where.lane,
  ].filter(Boolean);
  return <span className="truncate">{parts.join(" · ")}</span>;
}

/**
 * Something that waits for the owner, as one row: what kind, what it is about, why it waits,
 * where and since when. The row opens the decision; it does not decide.
 */
export function NeedRows({ needs }: { needs: NeedRow[] }) {
  return (
    <ul className="divide-y rounded-xl border">
      {needs.map((n) => (
        <li key={n.key}>
          <a
            href={n.page}
            className="grid gap-1 p-3 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring @2xl:grid-cols-[9rem_1fr_auto] @2xl:gap-3"
          >
            <span>
              <Badge variant="secondary" className={toneBadge[n.tone]}>
                {n.label}
              </Badge>
            </span>
            <span className="grid min-w-0 gap-0.5">
              <span className="font-medium">{n.headline}</span>
              <span className="text-muted-foreground">{n.why}</span>
              <span className="flex min-w-0 text-xs text-muted-foreground">
                <Where where={n.where} />
              </span>
            </span>
            <span className="flex items-start gap-2 text-xs whitespace-nowrap text-muted-foreground">
              {n.since && (
                <span>
                  waiting <Since at={n.since} />
                </span>
              )}
              <ArrowUpRightIcon className="size-4" aria-label="Opens on the current dashboard" />
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** What each agent of a run does now, one line each. */
export function NowLines({ lines }: { lines: NowLine[] }) {
  return (
    <ul className="grid gap-1">
      {lines.map((l) => (
        <li key={l.who} className="grid grid-cols-[4.5rem_1fr_auto] items-baseline gap-2">
          <span className="font-mono text-xs text-muted-foreground">{l.who}</span>
          <span className={l.busy ? "min-w-0" : `min-w-0 ${toneText[l.tone]}`}>{l.text}</span>
          <span className="text-xs whitespace-nowrap text-muted-foreground">
            <Since at={l.since} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A run at work, as one card: its name and rig, its result so far, and what its agents do now. */
export function RunCard({ run }: { run: RunRow }) {
  return (
    <article className="grid gap-3 rounded-xl border p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <ModeAvatar mode={run.mode} />
        <a
          href={runPath(run)}
          onClick={follow}
          className="min-w-0 truncate font-medium underline-offset-4 hover:underline"
        >
          {run.campaign} › {run.run}
        </a>
        <span className="text-xs text-muted-foreground">on {run.rig}</span>
        {run.judge_only && <Badge variant="outline">judge only</Badge>}
        <span className="ml-auto flex items-center gap-3">
          <RunFigure figure={run.figure} />
          <StatusBadge state={run.state} />
        </span>
      </div>
      <NowLines lines={run.now} />
      {run.needs > 0 && (
        <p className={`text-xs ${toneText.needs}`}>
          {run.needs} thing{run.needs === 1 ? "" : "s"} of this run need{run.needs === 1 ? "s" : ""}{" "}
          you.
        </p>
      )}
    </article>
  );
}

/** What happened, one sentence a row, newest first. */
export function EventRows({ events, rig = true }: { events: EventRow[]; rig?: boolean }) {
  return (
    <ul className="divide-y rounded-xl border">
      {events.map((e) => (
        <li
          key={`${e.at}:${e.rig}:${e.text}`}
          className="grid grid-cols-[4.5rem_auto_1fr_auto] items-baseline gap-2 px-3 py-2"
        >
          <span className="text-xs whitespace-nowrap text-muted-foreground">
            <Since at={e.at} />
          </span>
          <span className={`size-1.5 translate-y-[-1px] rounded-full ${toneDot[e.tone]}`} />
          <span className="min-w-0">{e.text}</span>
          {rig && <span className="font-mono text-xs text-muted-foreground">{e.rig}</span>}
        </li>
      ))}
    </ul>
  );
}
