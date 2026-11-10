import type { Tone } from "@core/api/control/dashboard.ts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AddDialog } from "@/parts/add-dialog.tsx";
import { CopyId } from "@/parts/copy-id.tsx";
import { Body, Header, Section } from "@/parts/header.tsx";
import { Failure, Loading, Nothing } from "@/parts/states.tsx";
import { StatusBadge } from "@/parts/status-badge.tsx";
import { Tile, Tiles } from "@/parts/tile.tsx";
import { type Facet, Toolbar } from "@/parts/toolbar.tsx";
import { Home } from "@/screens/home.tsx";
import { RunScreen } from "@/screens/run.tsx";
import { Settings } from "@/screens/settings.tsx";
import { Frame } from "@/shell.tsx";
import { homeEmpty, homeFull, runs, session } from "./fixtures.ts";

/**
 * The gallery: the frame, each screen and each part on made-up answers, with a switch for each
 * state. It is for building a screen with no control behind it, and it is in a development build
 * only (`npm run web:dev`, then /next/dev).
 */

const SCREENS = [
  { id: "home", label: "Home" },
  { id: "hill", label: "Run: hill climb" },
  { id: "goal", label: "Run: goal" },
  { id: "research", label: "Run: research" },
  { id: "settings", label: "Settings" },
  { id: "parts", label: "Parts" },
] as const;
type ScreenId = (typeof SCREENS)[number]["id"];

const STATES = ["full", "empty", "loading", "error"] as const;
type State = (typeof STATES)[number];

const FAILED = "Control did not answer. It is tried again.";

/** One row of switches: the one chosen is filled. */
function Switch<T extends string>({
  name,
  choices,
  chosen,
  choose,
}: {
  name: string;
  choices: readonly { id: T; label: string }[];
  chosen: T;
  choose: (id: T) => void;
}) {
  return (
    <fieldset className="flex flex-wrap items-center gap-1">
      <legend className="float-left mr-2 text-xs text-muted-foreground">{name}</legend>
      {choices.map((c) => (
        <Button
          key={c.id}
          size="sm"
          variant={c.id === chosen ? "default" : "outline"}
          aria-pressed={c.id === chosen}
          onClick={() => choose(c.id)}
        >
          {c.label}
        </Button>
      ))}
    </fieldset>
  );
}

const STREAM = [
  { id: "alive", label: "alive" },
  { id: "down", label: "down" },
] as const;

export default function Gallery() {
  const [screen, setScreen] = useState<ScreenId>("home");
  const [state, setState] = useState<State>("full");
  const [stream, setStream] = useState<(typeof STREAM)[number]["id"]>("alive");
  const error = state === "error" ? FAILED : "";
  const again = () => setState("full");
  let shown: React.ReactNode;
  if (screen === "home")
    shown = (
      <Home
        home={state === "full" ? homeFull : state === "empty" ? homeEmpty : undefined}
        error={error}
        reload={again}
      />
    );
  else if (screen === "parts") shown = <Parts />;
  else if (screen === "settings")
    shown = <Settings tab="about" session={session} signOut={() => {}} />;
  else
    shown = (
      <RunScreen
        run={runs[screen].row.run}
        data={state === "full" ? runs[screen] : state === "empty" ? runs.new : undefined}
        error={error}
        reload={again}
      />
    );
  return (
    <Frame
      home={state === "full" ? homeFull : state === "empty" ? homeEmpty : undefined}
      path={screen === "home" ? "/" : screen === "settings" ? "/settings" : "/dev"}
      alive={stream === "alive"}
    >
      <div className="grid gap-2 border-b bg-muted/40 px-4 py-2">
        <Switch name="Screen" choices={SCREENS} chosen={screen} choose={setScreen} />
        <Switch
          name="State"
          choices={STATES.map((id) => ({ id, label: id }))}
          chosen={state}
          choose={setState}
        />
        <Switch name="Control's stream" choices={STREAM} chosen={stream} choose={setStream} />
      </div>
      {shown}
    </Frame>
  );
}

const TONES: { tone: Tone; word: string }[] = [
  { tone: "good", word: "met" },
  { tone: "needs", word: "waits for you" },
  { tone: "wrong", word: "failed" },
  { tone: "working", word: "running" },
  { tone: "none", word: "stopped" },
];

const MODES = [
  { value: "hill_climb", label: "hill climb", count: 2 },
  { value: "goal", label: "goal", count: 1 },
  { value: "research", label: "research", count: 1 },
];

/** Thermite's own parts, each as a screen uses it. */
function Parts() {
  const [search, setSearch] = useState("");
  const [modes, setModes] = useState<string[]>(["goal"]);
  const [states, setStates] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const facets: Facet[] = [
    { name: "Mode", choices: MODES, chosen: modes, choose: setModes },
    {
      name: "State",
      choices: [
        { value: "running", label: "running", count: 3 },
        { value: "done", label: "done", count: 1 },
      ],
      chosen: states,
      choose: setStates,
    },
  ];
  return (
    <>
      <Header title="Parts">
        <Button onClick={() => setOpen(true)}>
          <PlusIcon /> Add a thing
        </Button>
      </Header>
      <Body>
        <Section title="State badge" hint="four colours and grey">
          <p className="flex flex-wrap gap-2">
            {TONES.map((t) => (
              <StatusBadge key={t.tone} state={t} />
            ))}
          </p>
        </Section>
        <Section title="Tiles">
          <Tiles>
            <Tile figure="3" label="need you" tone="needs" />
            <Tile figure="2" label="runs at work" />
            <Tile figure="+23.7%" label="over the starting point" tone="good" />
            <Tile figure="2/3" label="rigs online" tone="wrong" />
          </Tiles>
        </Section>
        <Section title="List toolbar" hint="search, then each filter as a dropdown">
          <Toolbar
            search={search}
            onSearch={setSearch}
            placeholder="Search campaigns"
            facets={facets}
          />
        </Section>
        <Section title="Loading, nothing and a failure">
          <Loading what="Loading the campaigns" />
          <Nothing>No campaign yet. Make one with New campaign.</Nothing>
          <Failure said={FAILED} again={() => {}} />
        </Section>
        <Section title="An ID to copy">
          <p>
            <CopyId id="run-0007" label="the run's ID" />
          </p>
        </Section>
      </Body>
      <AddDialog
        open={open}
        onOpenChange={setOpen}
        title="Add a thing"
        description="A thing is added in a dialog like this one, and on a phone it takes the whole screen."
      >
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setOpen(false);
          }}
        >
          <label className="grid gap-1.5 text-sm font-medium">
            Name
            <Input placeholder="sorting-speed" />
            <span className="font-normal text-muted-foreground">
              One hint under a field says what it takes.
            </span>
          </label>
          <Button type="submit" className="justify-self-start">
            Add
          </Button>
        </form>
      </AddDialog>
    </>
  );
}
