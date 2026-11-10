import type { HomeAnswer } from "@core/api/control/dashboard.ts";
import { Body, Header, Section } from "@/parts/header.tsx";
import { EventRows, NeedRows, RunCard } from "@/parts/rows.tsx";
import { Failure, Loading, Nothing } from "@/parts/states.tsx";
import { Tile, Tiles } from "@/parts/tile.tsx";

/**
 * Home: what needs the owner, then what is at work, then what happened. One scan, top to bottom.
 * Its data is read once for the whole app (app.tsx), since the navigation shows part of it.
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
    <>
      <Header title="Home" />
      <Body>
        {error && <Failure said={error} again={reload} />}
        {!home && !error && <Loading what="Loading Home" />}
        {home && <HomeBody home={home} />}
      </Body>
    </>
  );
}

function HomeBody({ home }: { home: HomeAnswer }) {
  const { counts } = home;
  return (
    <>
      <Tiles>
        <Tile
          figure={String(counts.needs)}
          label={counts.needs === 1 ? "needs you" : "need you"}
          tone={counts.needs ? "needs" : "none"}
        />
        <Tile
          figure={String(counts.running)}
          label={counts.running === 1 ? "run at work" : "runs at work"}
        />
        <Tile
          figure={String(counts.judging)}
          label={`judge${counts.judging === 1 ? "" : "s"} measuring${counts.queued ? ` · ${counts.queued} queued` : ""}`}
        />
        <Tile
          figure={`${counts.rigs - counts.offline}/${counts.rigs}`}
          label="rigs online"
          tone={counts.offline ? "wrong" : "none"}
        />
      </Tiles>
      <Section title="Needs you" count={home.needs.length}>
        {home.needs.length ? (
          <NeedRows needs={home.needs} />
        ) : (
          <Nothing>Nothing waits for you. The campaigns go on by themselves.</Nothing>
        )}
      </Section>
      <Section title="At work" count={home.at_work.length}>
        {home.at_work.length ? (
          <div className="grid gap-3">
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
