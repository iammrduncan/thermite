import { ChevronRightIcon, FolderIcon } from "lucide-react";
import { useState } from "react";
import { TextLink } from "@/parts/act.tsx";
import { Change } from "@/parts/change.tsx";
import { Chip, Legend } from "@/parts/chip.tsx";
import { Band, type BandSlot, type ExplorerField, Fields } from "@/parts/explorer.tsx";
import { Facts, Grid, Mono, Named, Thing, Things } from "@/parts/lists.tsx";
import { Screen, Section } from "@/parts/screen.tsx";
import { ShareBar, Sparkline, Stat, Stats } from "@/parts/stat.tsx";
import { Split, Tree, type TreeItem } from "@/parts/tree.tsx";

/**
 * The brand guide's board of data, in the app's own parts, with the board's words: numbers that
 * matter, a few things as rows, facts, a table, the tree, and the explorer.
 */

const RISING = [
  120, 121, 124, 124, 131, 138, 139, 146, 151, 151, 158, 163, 164, 170, 171, 176, 181, 182, 185,
  187, 188, 189,
];
const HOLDS = [
  30.2, 30.0, 30.3, 29.9, 30.1, 30.4, 30.0, 29.8, 30.2, 30.1, 30.3, 29.9, 30.0, 30.2, 30.1, 29.9,
  30.3, 30.0, 30.2, 30.1,
];

const ITEMS = [
  [
    "Epoch 220: profile proposals dropped, because a best profile exists",
    "Decision",
    "planner",
    "Planner",
    "Today 05:40",
  ],
  [
    "On the h2 route, the perplexity guard does not follow arithmetic error",
    "Note",
    "records",
    "Teacher 2",
    "Today 05:34",
  ],
  [
    "The h2 route after the 22nd best change: what made it more accurate",
    "Finding",
    "teachers",
    "Teachers",
    "Today 05:32",
  ],
  [
    "The fp16 outer sum passes the judge's single-text perplexity gate",
    "Note, a question",
    "records",
    "Auditor",
    "Today 04:03",
  ],
  [
    "The Kahan half2 outer-sum diff is algorithmically correct",
    "Note",
    "records",
    "Teacher 2",
    "Today 03:35",
  ],
] as const;

const TREE: TreeItem[] = [
  { id: "pn-prefill", name: "pn-prefill", level: 1, open: true, count: "9,499" },
  { id: "pn-prefill-2", name: "pn-prefill-2", level: 2, open: true, count: "9,498" },
  { id: "records", name: "records", level: 3, open: false, count: "8,940" },
  { id: "teachers", name: "teachers", level: 3, open: false, count: "266" },
  { id: "worker-2", name: "worker-2", level: 3, open: false, count: "141" },
  { id: "worker-1", name: "worker-1", level: 3, open: false, count: "117" },
  { id: "planner", name: "planner", level: 3, open: false, count: "20" },
  { id: "auditor", name: "auditor", level: 3, open: false, count: "14" },
  { id: "brief", name: "The campaign's brief", level: 3 },
  { id: "pn-prefill-1", name: "pn-prefill-1", level: 2, open: false, count: "1" },
  { id: "flash", name: "flash-next-v123-prefill", level: 1, open: false, count: "2,568" },
  { id: "pn-speed", name: "pn-speed", level: 1, open: false, count: "4,203" },
  { id: "chunking", name: "content-defined-chunking", level: 1, open: false, count: "468" },
];

const SHOWN: ExplorerField[] = [
  { name: "time", kind: "time", count: 46 },
  { name: "outcome", kind: "values", count: 4 },
  { name: "worker", kind: "who", count: 2 },
  { name: "gain", kind: "number", count: 34 },
  { name: "change", kind: "text", count: 46 },
];
const OTHERS: ExplorerField[] = [
  {
    name: "idea",
    kind: "values",
    count: 32,
    values: [
      { value: "prefill-stack-bitwise", count: 8 },
      { value: "prefill-attention", count: 4 },
      { value: "prefill-gemm-h2-kernel", count: 3 },
      { value: "not said yet", count: 2 },
      { value: "prefill-glue", count: 2 },
    ],
  },
  { name: "file", kind: "values", count: 18 },
  { name: "verdict", kind: "values", count: 6 },
  { name: "lines_changed", kind: "number", count: 40 },
  { name: "trial", kind: "values", count: 45 },
  { name: "built_on", kind: "values", count: 4 },
  { name: "commit", kind: "values", count: 45 },
];

/** Fifty slots of records, the same on every load: a few kept, most lost, some broken. */
const SLOTS: BandSlot[] = Array.from({ length: 50 }, (_, i) => ({
  good: i % 7 === 3 ? 1 : 0,
  none: (i * 5) % 9,
  wrong: i % 4 === 1 ? (i % 3) + 1 : 0,
  working: i === 49 ? 2 : 0,
}));

const RESULTS = [
  [
    "Nov 10, 05:29",
    "Judging",
    "working",
    "Worker 2",
    null,
    "A half2 D=256 attention tile on sm_60, picked by the precision field",
  ],
  [
    "Nov 10, 05:14",
    "Judging",
    "working",
    "Worker 1",
    null,
    "Fold the attention output gate into the signed FWHT load",
  ],
  [
    "Nov 10, 02:57",
    "Kept",
    "good",
    "Worker 2",
    "kept",
    "Port the outer-sum diff: an fp16 cross-window sum for k up to 5120",
  ],
  [
    "Nov 10, 02:30",
    "Lost",
    "none",
    "Worker 2",
    "0.11% faster",
    "Late PN layers stack ssm_beta and ssm_alpha at load time into one tensor",
  ],
  ["Nov 10, 02:01", "Lost", "none", "Worker 2", null, "Apply the outer-sum diff word for word"],
  [
    "Nov 10, 01:42",
    "Lost",
    "none",
    "Worker 2",
    "0.57% faster",
    "Port the k=5120 fp16 sum onto the best change, keeping fp32 for ffn_down",
  ],
] as const;

export function DataGallery() {
  const [folder, setFolder] = useState("pn-prefill-2");
  const [field, setField] = useState<string | undefined>("idea");
  const table = (
    <Grid
      label="Items"
      columns="minmax(0,1fr) 112px 96px 96px"
      heads={["Item", "In", "Written by", "When"]}
      rows={ITEMS.map(([item, kind, where, who, when]) => ({
        key: item,
        cells: [
          <Named key="n" name={item} sub={kind} />,
          <span key="i" className="inline-flex items-center gap-2 text-soft">
            <FolderIcon className="size-3.5 text-ember" /> {where}
          </span>,
          <span key="w" className="text-soft">
            {who}
          </span>,
          <span key="t" className="text-xs text-quiet">
            {when}
          </span>,
        ],
      }))}
      foot="9,490 more items in pn-prefill-2"
    />
  );
  return (
    <Screen
      title="Data"
      crumbs={[{ label: "Brand guide", href: "#" }]}
      sentence="A number, its unit, how it changed, and its history. At most four in a row."
    >
      <Section title="Numbers that matter">
        <Stats>
          <Stat
            label="Prompt speed · the score"
            number="189"
            unit="tok/s"
            aside={
              <Change direction="up" better>
                57% faster
              </Change>
            }
            history={<Sparkline values={RISING} tone="good" />}
            note="120 tok/s at its start"
          />
          <Stat
            label="Decode speed · must hold"
            number="30.1"
            unit="tok/s"
            aside={<Chip state={{ word: "Holds", tone: "good" }} />}
            history={<Sparkline values={HOLDS} />}
            note="At most 1% under its start"
          />
          <Stat
            label="A1's speed · must hold"
            number="26.4"
            unit="tok/s"
            aside={<Chip state={{ word: "Holds", tone: "good" }} />}
            history={<Sparkline values={[...HOLDS].reverse()} />}
            note="At most 3% under its start"
          />
          <Stat
            label="Changes tried"
            number="298"
            aside={<Chip state={{ word: "21 kept", tone: "good" }} />}
            history={
              <ShareBar
                label="21 kept, 2 with the judge, 51 broken, 224 lost"
                parts={[
                  { tone: "good", count: 21 },
                  { tone: "working", count: 2 },
                  { tone: "wrong", count: 51 },
                  { tone: "none", count: 224 },
                ]}
              />
            }
            note="2 with the judge now"
          />
        </Stats>
      </Section>

      <Section title="A few things">
        <p className="max-w-[720px] text-soft">
          Up to four things are rows: a name, its history, its state, its one number.
        </p>
        <Things>
          <Thing
            name={<TextLink href="#">pn-prefill-2</TextLink>}
            sub="day 9 · hill climb"
            end={
              <Change direction="up" better>
                57% faster
              </Change>
            }
          >
            <span className="min-w-0 flex-1">
              <Sparkline
                values={[120, 131, 139, 151, 158, 170, 176, 185, 189]}
                tone="good"
                height={28}
              />
            </span>
            <Chip state={{ word: "At work", tone: "working" }} />
          </Thing>
          <Thing
            name={<TextLink href="#">flash-next-v123r-prefill-2</TextLink>}
            sub="day 4 · hill climb"
            end={
              <Change direction="up" better>
                32% faster
              </Change>
            }
          >
            <span className="min-w-0 flex-1">
              <Sparkline
                values={[100, 104, 111, 118, 119, 124, 128, 131, 132]}
                tone="good"
                height={28}
              />
            </span>
            <Chip state={{ word: "At work", tone: "working" }} />
          </Thing>
          <Thing name={<TextLink href="#">pn-quality-2</TextLink>} sub="a goal · day 2">
            <span className="flex-1" />
            <Chip state={{ word: "Paused", tone: "none" }} />
          </Thing>
        </Things>
      </Section>

      <Section title="Facts">
        <p className="max-w-[720px] text-soft">What a thing is, as at most six facts.</p>
        <Facts
          facts={[
            { label: "Mode", value: "Hill climb" },
            {
              label: "The score",
              value: (
                <>
                  <Mono>prefill_tps</Mono> · higher is better
                </>
              ),
            },
            { label: "Runs on", value: "one P100 for the judge, one for the workers" },
            { label: "Workers", value: <Chip state={{ word: "Working", tone: "working" }} /> },
            { label: "Judge", value: <Chip state={{ word: "Working", tone: "working" }} /> },
            { label: "Started", value: "Nov 1, 14:12 UTC · day 9" },
          ]}
        />
      </Section>

      <Section title="A table">
        <p className="max-w-[720px] text-soft">
          From five rows. A name with one line under it, then at most four more columns.
        </p>
        {table}
      </Section>

      <Section title="The tree">
        <p className="max-w-[720px] text-soft">
          The knowledge base is folders and files: a collection for each campaign, its runs, their
          writers, the items.
        </p>
        <Split
          wide
          aside={<Tree label="Knowledge" items={TREE} chosen={folder} onChoose={setFolder} />}
        >
          {table}
        </Split>
      </Section>

      <Section title="The explorer">
        <p className="max-w-[720px] text-soft">
          Fields with counts, the records over time, dense rows. Only Explore is this dense.
        </p>
        <Split
          aside={
            <Fields
              shown={SHOWN}
              others={OTHERS}
              open={field}
              onOpen={(name) => setField(name === field ? undefined : name)}
            />
          }
        >
          <Legend
            items={[
              { tone: "good", word: "Kept", count: 2 },
              { tone: "working", word: "Judging", count: 2 },
              { tone: "wrong", word: "Broken", count: 8 },
              { tone: "none", word: "Lost", count: 34 },
            ]}
          />
          <Band
            slots={SLOTS}
            labels={[0, 6, 12, 18, 24, 30, 36, 42, 48].map((slot, i) => ({
              slot,
              text: `Nov ${i + 2}`,
            }))}
            span={[43, 50]}
          />
          <Grid
            dense
            label="Changes"
            columns="16px 104px 104px 72px 120px minmax(0,1fr)"
            heads={["", "Handed in, UTC", "Outcome", "Worker", "Against the best", "Change"]}
            rows={RESULTS.map(([time, word, tone, worker, against, change]) => ({
              key: time,
              cells: [
                <ChevronRightIcon key="c" className="size-3.5 text-quiet" />,
                <Mono key="t">{time}</Mono>,
                <Chip key="o" state={{ word, tone }} />,
                <span key="w" className="text-soft">
                  {worker}
                </span>,
                against === "kept" ? (
                  <Change key="a" direction="up" better>
                    1.10% faster
                  </Change>
                ) : (
                  <span key="a" className="text-soft">
                    {against}
                  </span>
                ),
                <span key="n" className="font-semibold">
                  {change}
                </span>,
              ],
            }))}
            foot="40 more match."
          />
        </Split>
      </Section>
    </Screen>
  );
}
