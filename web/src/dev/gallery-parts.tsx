import type { Tone } from "@core/api/control/dashboard.ts";
import {
  CircleXIcon,
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  EyeIcon,
  PencilIcon,
  PlayIcon,
} from "lucide-react";
import { useState } from "react";
import { Act, IconAct, TextLink } from "@/parts/act.tsx";
import { Change } from "@/parts/change.tsx";
import { Chip, Count, Dot } from "@/parts/chip.tsx";
import { CopyId } from "@/parts/copy-id.tsx";
import { type QueryHow, Views } from "@/parts/explorer.tsx";
import { Field, Fold, Group, Segmented, Select, TextArea, TextInput } from "@/parts/field.tsx";
import { NeedCard } from "@/parts/need-card.tsx";
import { Confirm, Menu, Undo } from "@/parts/opens.tsx";
import { Screen, Section } from "@/parts/screen.tsx";
import { Empty, Failure, Loading, Nothing, Wrong } from "@/parts/states.tsx";
import { Tabs } from "@/parts/tabs.tsx";

/**
 * The brand guide's board of components, in the app's own parts, with the board's words: the
 * buttons, the states and changes, the fields, the tabs and views, what opens, what asks and
 * what is empty. Each part works here as it does on a screen.
 */

const CHIPS: { tone: Tone; words: string[] }[] = [
  { tone: "good", words: ["Kept", "Complete"] },
  { tone: "working", words: ["At work", "Judging"] },
  { tone: "needs", words: ["Needs you"] },
  { tone: "wrong", words: ["Failed", "Broken"] },
  { tone: "none", words: ["Paused", "Stopped", "Lost"] },
];

const MODES = [
  { value: "hill", label: "Hill climb" },
  { value: "goal", label: "Goal" },
  { value: "research", label: "Research" },
] as const;

const TABS = ["Summary", "Explore", "Usage", "Results", "Setup"].map((label) => ({
  id: label,
  label,
}));

/** A caption under an example, as the board has them. */
function Shown({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2">
      {children}
      <span className="text-xs text-quiet">{caption}</span>
    </div>
  );
}

export function PartsGallery() {
  const [mode, setMode] = useState<(typeof MODES)[number]["value"]>("hill");
  const [tab, setTab] = useState("Summary");
  const [view, setView] = useState("Kept");
  const [how, setHow] = useState<QueryHow>("filters");
  const [asking, setAsking] = useState(false);
  const [archived, setArchived] = useState(true);
  return (
    <Screen
      title="Components"
      crumbs={[{ label: "Brand guide", href: "#" }]}
      sentence="The flame is for the one thing most people came to do. Everything else is plain."
    >
      <Section title="Buttons">
        <div className="flex flex-wrap items-end gap-6">
          <Shown caption="Main: one a screen">
            <Act look="main" icon={PlayIcon}>
              Start a run
            </Act>
          </Shown>
          <Shown caption="Plain">
            <Act icon={EyeIcon}>Watch</Act>
          </Shown>
          <Shown caption="Plain, no icon">
            <Act>Not now</Act>
          </Shown>
          <Shown caption="Red: work is lost">
            <Act look="red">Close the run</Act>
          </Shown>
          <Shown caption="Text">
            <Act look="text">Undo</Act>
          </Shown>
          <Shown caption="Icon alone">
            <IconAct icon={EllipsisIcon} label="More" />
          </Shown>
          <Shown caption="A link">
            <span className="flex h-9 items-center">
              <TextLink href="#">All 214 ideas</TextLink>
            </span>
          </Shown>
          <Shown caption="Cannot be pressed now">
            <Act look="main" disabled>
              Sign in
            </Act>
          </Shown>
        </div>
      </Section>

      <Section title="States and changes">
        <p className="max-w-[720px] text-soft">
          A chip is a state. An arrow is a change: green when it is better, red when it is worse,
          whatever its direction.
        </p>
        <div className="flex flex-wrap gap-2">
          {CHIPS.flatMap((c) =>
            c.words.map((word) => <Chip key={word} state={{ word, tone: c.tone }} />),
          )}
        </div>
        <div className="flex flex-wrap items-center gap-10">
          <Shown caption="A dot alone, where a word has no room">
            <span className="flex gap-2">
              <Dot tone="working" label="At work" />
              <Dot tone="good" label="Kept" />
              <Dot tone="needs" label="Needs you" />
              <Dot tone="wrong" label="Failed" />
              <Dot tone="none" label="Paused" />
            </span>
          </Shown>
          <Shown caption="A count that waits for you">
            <Count>2</Count>
          </Shown>
        </div>
        <div className="flex flex-wrap gap-10">
          <Shown caption="Up, and better">
            <Change direction="up" better>
              57% faster
            </Change>
          </Shown>
          <Shown caption="Down, and worse">
            <Change direction="down" better={false}>
              5.1% slower
            </Change>
          </Shown>
          <Shown caption="Down, and better">
            <Change direction="down" better>
              23% less time
            </Change>
          </Shown>
          <Shown caption="Up, and worse">
            <Change direction="up" better={false}>
              12% more memory
            </Change>
          </Shown>
        </div>
      </Section>

      <Section title="Fields">
        <p className="max-w-[720px] text-soft">
          A label with its "i", one control, an example in the field. No hint under it.
        </p>
        <div className="flex flex-wrap gap-10">
          <div className="flex max-w-[480px] min-w-0 flex-[1_1_320px] flex-col gap-6">
            <Field
              label="Name"
              htmlFor="g-name"
              help="Lower-case letters, digits and dashes. Its runs are named after it."
            >
              <TextInput id="g-name" defaultValue="pn-decode" />
            </Field>
            <Field
              label="Where it runs"
              htmlFor="g-where"
              help="The devices its runs may take from the pool."
            >
              <Select id="g-where" defaultValue="Any free P100">
                <option>Any free P100</option>
                <option>gpu-box-1 · P100 0</option>
                <option>A DGX Spark</option>
              </Select>
            </Field>
            <Field
              label="A field that is wrong"
              htmlFor="g-wrong"
              help="What control refused is said under the form, in its own words."
            >
              <TextInput id="g-wrong" aria-invalid defaultValue="PN Decode" />
            </Field>
          </div>
          <div className="flex max-w-[480px] min-w-0 flex-[1_1_320px] flex-col gap-6">
            <Field
              label="How it works"
              help="Hill climb: make one number better. Goal: reach a target. Research: answer questions."
            >
              <Segmented label="How it works" options={MODES} chosen={mode} onChoose={setMode} />
            </Field>
            <Field
              label="What to make better"
              htmlFor="g-what"
              help="In your own words. The planner reads it first."
            >
              <TextArea
                id="g-what"
                defaultValue="Decode speed on one P100, with the model's answers unchanged."
              />
            </Field>
          </div>
        </div>
        <div className="max-w-[480px]">
          <Fold>
            <Group title="The judge" about="How a change is measured, and when it counts.">
              <p>It measures each change three times, and a change counts from 5% better.</p>
            </Group>
            <Group title="The agents" about="Who works on the campaign, and with which model.">
              <p>Two workers, a planner and two teachers, each on the campaign's model.</p>
            </Group>
          </Fold>
          <span className="mt-2 block text-xs text-quiet">A fold: closed when you arrive</span>
        </div>
      </Section>

      <Section title="Tabs and views">
        <p className="max-w-[720px] text-soft">
          The parts of one thing are tabs with a flame line. Saved views are quieter.
        </p>
        <Tabs label="A run's parts" tabs={TABS} chosen={tab} onChoose={setTab} />
        <Views
          views={["All", "Kept", "Close calls", "Broken today"]}
          chosen={view}
          onChoose={setView}
          onSave={() => {}}
          how={how}
          onHow={setHow}
        />
      </Section>

      <Section title="What opens">
        <p className="max-w-[720px] text-soft">
          A menu for rare acts. A dialog only where work is lost. One line and Undo where it can be
          undone.
        </p>
        <div className="flex flex-wrap items-start gap-10">
          <Shown caption="A menu: at most 7 lines, the red one last">
            <Menu
              lines={[
                { label: "Rename", icon: PencilIcon, onChoose: () => {} },
                { label: "Copy the campaign", icon: CopyIcon, onChoose: () => {} },
                { label: "Export its results", icon: DownloadIcon, onChoose: () => {} },
                {
                  label: "Close the run",
                  icon: CircleXIcon,
                  red: true,
                  onChoose: () => setAsking(true),
                },
              ]}
            >
              <IconAct icon={EllipsisIcon} label="More" />
            </Menu>
          </Shown>
          <Shown caption="Work is lost: one question, two buttons">
            <Act look="red" onClick={() => setAsking(true)}>
              Close the run
            </Act>
          </Shown>
          <Shown caption="It can be undone: do it, and offer Undo">
            {archived ? (
              <Undo onUndo={() => setArchived(false)}>pn-quality is archived.</Undo>
            ) : (
              <Act onClick={() => setArchived(true)}>Archive pn-quality</Act>
            )}
          </Shown>
        </div>
        <Shown caption="Something is wrong now">
          <Wrong said="gpu-box-1 has not reported for 12 minutes.">
            <Act>See the machine</Act>
          </Wrong>
        </Shown>
        <Confirm
          open={asking}
          onOpenChange={setAsking}
          title="Close pn-prefill-2?"
          text="Its workers stop now, and the 2 changes the judge measures are dropped. Its results and its best change stay."
          keep="Keep it running"
          lose="Close the run"
          onLose={() => {}}
        />
      </Section>

      <Section title="What asks, and what is empty">
        <p className="max-w-[720px] text-soft">
          A need is a card in amber, so the eye finds it first. An empty list is Thermy and one
          button.
        </p>
        <NeedCard
          who="pn-prefill-2 · its teachers ask"
          question="May the agents ship hand-edited GPU machine code in the engine?"
          note="They work on other ideas until you answer."
        >
          <Act>Not now</Act>
          <Act look="main">Answer</Act>
        </NeedCard>
        <Empty action={<Act look="main">Plan with Thermy</Act>}>
          No campaign yet. Thermy can plan the first one with you.
        </Empty>
      </Section>

      <Section title="Loading, nothing and a failure">
        <Loading what="Loading the campaigns" />
        <Nothing>Nothing waits for you. The campaigns go on by themselves.</Nothing>
        <Failure said="Control did not answer. It is tried again." again={() => {}} />
      </Section>

      <Section title="An ID to copy">
        <p>
          <CopyId id="run-0007" label="the run's ID" />
        </p>
      </Section>
    </Screen>
  );
}
