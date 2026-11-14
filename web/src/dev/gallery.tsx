import { CircleXIcon, ClockIcon, DownloadIcon, RefreshCwIcon, UsersIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Act, TextLink } from "@/parts/act.tsx";
import { Chip } from "@/parts/chip.tsx";
import { Confirm, Undo } from "@/parts/opens.tsx";
import { RunActs, type RunTab, RunTabs } from "@/parts/run-top.tsx";
import { Screen, Section } from "@/parts/screen.tsx";
import { Nothing } from "@/parts/states.tsx";
import { Home } from "@/screens/home.tsx";
import { RunScreen } from "@/screens/run.tsx";
import { Settings } from "@/screens/settings.tsx";
import { SignIn } from "@/screens/sign-in.tsx";
import { Frame } from "@/shell.tsx";
import { homeEmpty, homeFull, runs, session } from "./fixtures.ts";
import { DataGallery } from "./gallery-data.tsx";
import { PartsGallery } from "./gallery-parts.tsx";

/**
 * The gallery: the frame, each screen and each part on made-up answers, with a switch for each
 * state. It is where the brand is looked at beside the brand guide's boards, and where a screen
 * is built with no control behind it. It is in a development build only (`npm run web:dev`, then
 * /next/dev).
 */

const SCREENS = [
  { id: "parts", label: "Components" },
  { id: "data", label: "Data" },
  { id: "top", label: "A run's top" },
  { id: "sign-in", label: "Sign in" },
  { id: "home", label: "Home" },
  { id: "hill", label: "Run: hill climb" },
  { id: "goal", label: "Run: goal" },
  { id: "research", label: "Run: research" },
  { id: "settings", label: "Setup" },
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
      <legend className="float-left mr-2 w-28 text-xs text-quiet">{name}</legend>
      {choices.map((c) => (
        <button
          key={c.id}
          type="button"
          aria-pressed={c.id === chosen}
          onClick={() => choose(c.id)}
          className={cn(
            "inline-flex h-7 items-center rounded-md px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
            c.id === chosen
              ? "bg-chosen font-semibold text-foreground"
              : "text-quiet hover:bg-chosen",
          )}
        >
          {c.label}
        </button>
      ))}
    </fieldset>
  );
}

const STREAM = [
  { id: "alive", label: "alive" },
  { id: "down", label: "down" },
] as const;

export default function Gallery() {
  const [screen, setScreen] = useState<ScreenId>("parts");
  const [state, setState] = useState<State>("full");
  const [stream, setStream] = useState<(typeof STREAM)[number]["id"]>("alive");
  const error = state === "error" ? FAILED : "";
  const again = () => setState("full");
  const switches = (
    <div className="grid flex-none gap-1 border-b bg-sidebar px-4 py-2">
      <Switch name="Screen" choices={SCREENS} chosen={screen} choose={setScreen} />
      <Switch
        name="State"
        choices={STATES.map((id) => ({ id, label: id }))}
        chosen={state}
        choose={setState}
      />
      <Switch name="Control's stream" choices={STREAM} chosen={stream} choose={setStream} />
    </div>
  );
  // The sign-in page has nothing around it: no frame.
  if (screen === "sign-in")
    return (
      <>
        {switches}
        <SignIn days={30} onSignedIn={() => setScreen("home")} />
      </>
    );
  let shown: React.ReactNode;
  if (screen === "home")
    shown = (
      <Home
        home={state === "full" ? homeFull : state === "empty" ? homeEmpty : undefined}
        error={error}
        reload={again}
      />
    );
  else if (screen === "parts") shown = <PartsGallery />;
  else if (screen === "data") shown = <DataGallery />;
  else if (screen === "top") shown = <RunTop />;
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
      signOut={() => setScreen("sign-in")}
    >
      {switches}
      {shown}
    </Frame>
  );
}

/**
 * A run's top as its board draws it, with its buttons working in place: Pause is done at once
 * and offers Undo, More is a menu whose red line asks first, and each tab is chosen in place.
 */
function RunTop() {
  const [tab, setTab] = useState<RunTab>("summary");
  const [paused, setPaused] = useState(false);
  const [said, setSaid] = useState("");
  const [closing, setClosing] = useState(false);
  const pause = () => {
    setPaused(!paused);
    setSaid(paused ? "" : "pn-prefill-2 is paused. Its 2 trials stopped.");
  };
  return (
    <Screen
      kind="detail"
      title="pn-prefill-2"
      crumbs={[{ label: "pn-prefill", href: "#" }]}
      state={
        <>
          <Chip
            state={paused ? { word: "Paused", tone: "none" } : { word: "At work", tone: "working" }}
          />
          {paused && (
            <TextLink href="#" className="text-xs">
              Add a reason
            </TextLink>
          )}
        </>
      }
      actions={
        <RunActs
          paused={paused}
          watch={{ onClick: () => setSaid("") }}
          pause={{ onClick: pause }}
          more={{
            lines: [
              { label: "Add hours", icon: ClockIcon, onChoose: () => {} },
              { label: "Restart the workers", icon: RefreshCwIcon, onChoose: () => {} },
              { label: "Ask the teachers", icon: UsersIcon, onChoose: () => {} },
              { label: "Export now", icon: DownloadIcon, onChoose: () => {} },
              {
                label: "Close the run",
                icon: CircleXIcon,
                red: true,
                onChoose: () => setClosing(true),
              },
            ],
          }}
          tell={{ onClick: () => setSaid("") }}
        />
      }
      tabs={<RunTabs chosen={tab} onChoose={setTab} />}
      sentence="57% faster than its start, and still winning."
    >
      {said && (
        <div>
          <Undo
            onUndo={() => {
              setPaused(false);
              setSaid("");
            }}
          >
            {said}
          </Undo>
        </div>
      )}
      <Section title={tab === "summary" ? "Summary" : `The run's ${tab}`}>
        <Nothing>
          The top is the same on every screen of a run: where it is, its name and state, four
          buttons with the flame one last, five tabs, then its one sentence.
        </Nothing>
        <p>
          <Act onClick={() => setClosing(true)} look="red">
            Close the run
          </Act>
        </p>
      </Section>
      <Confirm
        open={closing}
        onOpenChange={setClosing}
        title="Close pn-prefill-2?"
        text="Its workers stop now, and the 2 changes the judge measures are dropped. Its results and its best change stay."
        keep="Keep it running"
        lose="Close the run"
        onLose={() => setSaid("")}
      />
    </Screen>
  );
}
