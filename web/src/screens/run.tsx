import { RUN_OVERVIEW, type RunOverviewAnswer } from "@core/api/control/dashboard.ts";
import { ArrowUpRightIcon } from "lucide-react";
import { useRead } from "@/api.ts";
import { Chip } from "@/parts/chip.tsx";
import { CopyId } from "@/parts/copy-id.tsx";
import { GoalBar, StepChart } from "@/parts/figure.tsx";
import { Facts } from "@/parts/lists.tsx";
import { EventRows, NeedRows, NowLines } from "@/parts/rows.tsx";
import { RunActs, type RunTab, RunTabs } from "@/parts/run-top.tsx";
import { Screen, Section } from "@/parts/screen.tsx";
import { Failure, Loading, Nothing } from "@/parts/states.tsx";
import { toneText } from "@/parts/tone.ts";

/** A run's Summary: how it stands, what needs the owner, its result, what its agents do now. */
export function Run({ run }: { run: string }) {
  const { data, error, reload } = useRead(RUN_OVERVIEW, { run });
  return <RunScreen run={run} data={data} error={error} reload={reload} />;
}

/**
 * A run's other parts, and what its buttons do, are still on the run's page of the dashboard at
 * /ui (goal 247 builds them here): each leads there, and says so.
 */
const ELSEWHERE: Record<Exclude<RunTab, "summary">, { page: string; name: string }> = {
  explore: { page: "/attempts", name: "Explore" },
  usage: { page: "/stats", name: "Usage" },
  results: { page: "/history", name: "Results" },
  setup: { page: "/info", name: "Setup" },
};
const out = <ArrowUpRightIcon className="text-quiet" />;

/**
 * The screen itself, from an answer already read: the gallery shows it on made-up answers. It is
 * the screen of 2026-11-10 under the run's top; goal 247 builds it from its board.
 */
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
  const there = (what: string) => ({
    href: data?.page ?? "",
    title: `${what} is still on the run's page of the current dashboard`,
    after: out,
  });
  return (
    <Screen
      title={row?.run ?? run}
      crumbs={
        row
          ? [
              {
                label: row.campaign,
                href: `/ui/campaigns/${encodeURIComponent(row.campaign)}`,
                title: "The campaign's page is still on the current dashboard",
              },
            ]
          : []
      }
      state={row && <Chip state={row.state} />}
      actions={
        data && (
          <RunActs
            watch={{
              href: `${data.page}/live`,
              title: "Watch opens on the current dashboard",
              after: out,
            }}
            pause={there("Pause")}
            more={there("More")}
            tell={{ ...there("Tell the agents"), after: <ArrowUpRightIcon /> }}
          />
        )
      }
      tabs={
        data && (
          <RunTabs
            chosen="summary"
            where={(tab) =>
              tab === "summary"
                ? {}
                : {
                    href: `${data.page}${ELSEWHERE[tab].page}`,
                    title: `${ELSEWHERE[tab].name} is still on the current dashboard`,
                  }
            }
          />
        )
      }
      sentence={data?.said}
    >
      {error && <Failure said={error} again={reload} />}
      {!data && !error && <Loading what="Loading the run" />}
      {data && <RunBody run={data} />}
    </Screen>
  );
}

function RunBody({ run }: { run: RunOverviewAnswer }) {
  const { row } = run;
  return (
    <>
      <div className="grid gap-2">
        {run.held && <p className={`font-semibold ${toneText.needs}`}>{run.held}</p>}
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-quiet">
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
            <div className="grid gap-2 rounded-xl border p-4">
              <p>
                <span className="text-sentence tabular-nums">{row.figure.text}</span>{" "}
                <span className="text-quiet">
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
            <div className="grid gap-4">
              <p className="flex items-center gap-4">
                <GoalBar goals={row.figure.goals} />
                <span className="font-semibold">{row.figure.text}</span>
              </p>
              <ul className="divide-y rounded-xl border">
                {row.figure.goals.map((g) => (
                  <li
                    key={g.goal}
                    className="grid gap-1 px-4 py-2 @md:grid-cols-[1fr_auto] @md:gap-4"
                  >
                    <span className="grid min-w-0 gap-1">
                      <span className="font-semibold">{g.goal}</span>
                      {g.reasons && <span className="text-quiet">{g.reasons}</span>}
                    </span>
                    <span>
                      <Chip state={g.state} />
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
                <li key={q.index} className="grid gap-1 px-4 py-2">
                  <span className="flex flex-wrap items-baseline gap-2">
                    <span className="font-semibold">{q.question}</span>
                    <Chip state={q.state} />
                  </span>
                  {q.answer && <span className="text-quiet">{q.answer}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <Nothing>The run has no digest of its questions yet.</Nothing>
          )}
        </Section>
      )}
      <Section title="Now">
        <div className="rounded-xl border p-4">
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
        <Facts facts={run.facts} />
      </Section>
    </>
  );
}
