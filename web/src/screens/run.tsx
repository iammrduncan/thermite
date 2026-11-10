import { RUN_OVERVIEW, type RunOverviewAnswer } from "@core/api/control/dashboard.ts";
import { ArrowUpRightIcon, RadioIcon } from "lucide-react";
import { useRead } from "@/api.ts";
import { Button } from "@/components/ui/button";
import { CopyId } from "@/parts/copy-id.tsx";
import { GoalBar, StepChart } from "@/parts/figure.tsx";
import { Body, Header, Section } from "@/parts/header.tsx";
import { ModeAvatar } from "@/parts/mode-avatar.tsx";
import { EventRows, NeedRows, NowLines } from "@/parts/rows.tsx";
import { Failure, Loading, Nothing } from "@/parts/states.tsx";
import { StatusBadge } from "@/parts/status-badge.tsx";
import { toneText } from "@/parts/tone.ts";

/** A run's Overview: how it stands, what needs the owner, its result, what its agents do now. */
export function Run({ run }: { run: string }) {
  const { data, error, reload } = useRead(RUN_OVERVIEW, { run });
  return <RunScreen run={run} data={data} error={error} reload={reload} />;
}

/** The screen itself, from an answer already read: the gallery shows it on made-up answers. */
export function RunScreen({
  run,
  data,
  error,
  reload,
}: {
  run: string;
  data: RunOverviewAnswer | undefined;
  error: string;
  reload: () => void;
}) {
  const row = data?.row;
  return (
    <>
      <Header
        lead={row && <ModeAvatar mode={row.mode} />}
        title={
          row ? (
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">
                <a
                  href={`/ui/campaigns/${encodeURIComponent(row.campaign)}`}
                  title="The campaign's page is still on the current dashboard"
                  className="text-muted-foreground hover:underline max-sm:hidden"
                >
                  {row.campaign}
                </a>
                <span className="max-sm:hidden">{" › "}</span>
                {row.run}
              </span>
              <StatusBadge state={row.state} />
            </span>
          ) : (
            run
          )
        }
      >
        {data && (
          <>
            <Button variant="outline" asChild>
              <a href={`${data.page}/live`}>
                <RadioIcon /> <span className="max-sm:sr-only">Watch</span>
              </a>
            </Button>
            <Button variant="ghost" asChild>
              <a href={data.page} title="The run's other tabs are still on the current dashboard">
                <span className="max-sm:sr-only">All tabs</span> <ArrowUpRightIcon />
              </a>
            </Button>
          </>
        )}
      </Header>
      <Body>
        {error && <Failure said={error} again={reload} />}
        {!data && !error && <Loading what="Loading the run" />}
        {data && <RunBody run={data} />}
      </Body>
    </>
  );
}

function RunBody({ run }: { run: RunOverviewAnswer }) {
  const { row } = run;
  return (
    <>
      <div className="grid gap-2">
        <p className="text-base">{run.said}</p>
        {run.held && <p className={toneText.needs}>{run.held}</p>}
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            {row.campaign} · {row.mode_words} on {row.rig}
          </span>
          <CopyId id={row.run} label="the run's ID" />
        </p>
      </div>
      {run.needs.length > 0 && (
        <Section title="Needs you" count={run.needs.length}>
          <NeedRows needs={run.needs} />
        </Section>
      )}
      {row.mode === "hill_climb" && (
        <Section
          title={run.metric?.name ?? "The main metric"}
          hint={
            run.metric
              ? `${run.metric.better}${run.metric.unit ? ` · ${run.metric.unit}` : ""}`
              : undefined
          }
        >
          {row.figure.steps.length ? (
            <div className="grid gap-2 rounded-xl border p-3">
              <p>
                <span className="text-2xl font-medium tabular-nums">{row.figure.text}</span>{" "}
                <span className="text-muted-foreground">
                  over the starting point, by champion #{row.champion ?? 1}
                </span>
              </p>
              <StepChart steps={row.figure.steps} />
            </div>
          ) : (
            <Nothing>The judge has not measured the starting point yet.</Nothing>
          )}
        </Section>
      )}
      {row.mode === "goal" && (
        <Section title="Goals" count={row.figure.goals.length}>
          {row.figure.goals.length ? (
            <div className="grid gap-3">
              <p className="flex items-center gap-3">
                <GoalBar goals={row.figure.goals} />
                <span className="font-medium">{row.figure.text}</span>
              </p>
              <ul className="divide-y rounded-xl border">
                {row.figure.goals.map((g) => (
                  <li
                    key={g.goal}
                    className="grid gap-0.5 px-3 py-2 @md:grid-cols-[1fr_auto] @md:gap-3"
                  >
                    <span className="grid min-w-0 gap-0.5">
                      <span className="font-medium">{g.goal}</span>
                      {g.reasons && <span className="text-muted-foreground">{g.reasons}</span>}
                    </span>
                    <span>
                      <StatusBadge state={g.state} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <Nothing>The judge has not checked the goals yet.</Nothing>
          )}
        </Section>
      )}
      {row.mode === "research" && (
        <Section title="Questions" count={run.questions.length}>
          {run.questions.length ? (
            <ul className="divide-y rounded-xl border">
              {run.questions.map((q) => (
                <li key={q.index} className="grid gap-1 px-3 py-2">
                  <span className="flex flex-wrap items-baseline gap-2">
                    <span className="font-medium">{q.question}</span>
                    <StatusBadge state={q.state} />
                  </span>
                  {q.answer && <span className="text-muted-foreground">{q.answer}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <Nothing>The run has no digest of its questions yet.</Nothing>
          )}
        </Section>
      )}
      <Section title="Now">
        <div className="rounded-xl border p-3">
          <NowLines lines={row.now} />
        </div>
      </Section>
      <Section title="Recent" hint="newest first">
        {run.recent.length ? (
          <EventRows events={run.recent} rig={false} />
        ) : (
          <Nothing>Nothing yet.</Nothing>
        )}
      </Section>
      <Section title="The run">
        <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 rounded-xl border p-3">
          {run.facts.map((f) => (
            <div key={f.label} className="contents">
              <dt className="text-muted-foreground">{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </>
  );
}
