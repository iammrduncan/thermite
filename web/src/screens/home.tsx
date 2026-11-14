import type { HomeAnswer } from "@core/api/control/dashboard.ts";
import { EventRows, NeedRows, RunCard } from "@/parts/rows.tsx";
import { Screen, Section } from "@/parts/screen.tsx";
import { Stat, Stats } from "@/parts/stat.tsx";
import { Failure, Loading, Nothing } from "@/parts/states.tsx";

/**
 * Home: what needs the owner, then what is at work, then what happened. One scan, top to bottom.
 * Its data is read once for the whole app (app.tsx), since the navigation shows part of it.
 *
 * It is the screen of 2026-11-10 in the brand's parts; goal 246 builds Home from its board, and
 * gives it its budget.
 */
export function Home({
  home,
  error,
  reload,
}: {
  home: HomeAnswer | undefined;
  error: string;
  reload: () => void;
}) {
  return (
    <Screen title="Home">
      {error && <Failure said={error} again={reload} />}
      {!home && !error && <Loading what="Loading Home" />}
      {home && <HomeBody home={home} />}
    </Screen>
  );
}

function HomeBody({ home }: { home: HomeAnswer }) {
  const { counts } = home;
  return (
    <>
      <Stats>
        <Stat label={counts.needs === 1 ? "needs you" : "need you"} number={String(counts.needs)} />
        <Stat
          label={counts.running === 1 ? "run at work" : "runs at work"}
          number={String(counts.running)}
        />
        <Stat
          label={`judge${counts.judging === 1 ? "" : "s"} measuring${counts.queued ? ` · ${counts.queued} queued` : ""}`}
          number={String(counts.judging)}
        />
        <Stat label="rigs online" number={`${counts.rigs - counts.offline}/${counts.rigs}`} />
      </Stats>
      <Section title="Needs you" count={home.needs.length}>
        {home.needs.length ? (
          <NeedRows needs={home.needs} />
        ) : (
          <Nothing>Nothing waits for you. The campaigns go on by themselves.</Nothing>
        )}
      </Section>
      <Section title="At work" count={home.at_work.length}>
        {home.at_work.length ? (
          <div className="grid gap-4">
            {home.at_work.map((run) => (
              <RunCard key={`${run.rig}:${run.run}`} run={run} />
            ))}
          </div>
        ) : (
          <Nothing>No run is at work. Start one from a campaign, or make a new campaign.</Nothing>
        )}
      </Section>
      <Section title="What happened" hint="newest first">
        {home.happened.length ? (
          <EventRows events={home.happened} />
        ) : (
          <Nothing>Nothing yet.</Nothing>
        )}
      </Section>
    </>
  );
}
