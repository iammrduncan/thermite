import {
  Band,
  type BandSlot,
  Change,
  Chip,
  type ExplorerField,
  Fields,
  Grid,
  Legend,
  Mono,
  Nothing,
  type QueryHow,
  Split,
  Views,
} from "@ds";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

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
      { value: "prefill-glue", count: 2 },
    ],
  },
  { name: "file", kind: "values", count: 18 },
  { name: "lines_changed", kind: "number", count: 40 },
];

/** Fifty slots of records, the same on every load: a few kept, most lost, some broken. */
const SLOTS: BandSlot[] = Array.from({ length: 50 }, (_, i) => ({
  good: i % 7 === 3 ? 1 : 0,
  none: (i * 5) % 9,
  wrong: i % 4 === 1 ? (i % 3) + 1 : 0,
  working: i === 49 ? 2 : 0,
}));

export default function Explorer() {
  const [field, setField] = useState<string | undefined>("idea");
  const [view, setView] = useState("Kept");
  const [how, setHow] = useState<QueryHow>("filters");
  // The time looked at, as the band's slots: six a day, from Nov 2.
  const [span, setSpan] = useState<[number, number] | undefined>([43, 50]);
  const day = (slot: number) => `Nov ${2 + Math.floor(slot / 6)}`;
  return (
    <div className="flex flex-col gap-4">
      <Views
        views={["All", "Kept", "Close calls", "Broken today"]}
        chosen={view}
        onChoose={setView}
        onSave={() => {}}
        how={how}
        onHow={setHow}
      />
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
          labels={[0, 12, 24, 36, 48].map((slot, i) => ({ slot, text: `Nov ${2 + i * 2}` }))}
          span={span}
          onSpan={setSpan}
        />
        <Nothing>
          {span
            ? `Looking at ${day(span[0])} to ${day(span[1] - 1)}. Drag across the band to pick another time.`
            : "Looking at all of it. Drag across the band to pick a time."}
        </Nothing>
        <Grid
          dense
          label="Changes"
          columns="16px 104px 104px 120px minmax(0,1fr)"
          heads={["", "Handed in, UTC", "Outcome", "Against the best", "Change"]}
          rows={[
            {
              key: "a",
              cells: [
                <ChevronRightIcon key="c" className="size-3.5 text-quiet" />,
                <Mono key="t">Nov 10, 05:29</Mono>,
                <Chip key="o" state={{ word: "Judging", tone: "working" }} />,
                "",
                <span key="n" className="font-semibold">
                  A half2 D=256 attention tile on sm_60
                </span>,
              ],
            },
            {
              key: "b",
              cells: [
                <ChevronRightIcon key="c" className="size-3.5 text-quiet" />,
                <Mono key="t">Nov 10, 02:57</Mono>,
                <Chip key="o" state={{ word: "Kept", tone: "good" }} />,
                <Change key="a" direction="up" better>
                  1.10% faster
                </Change>,
                <span key="n" className="font-semibold">
                  Port the outer-sum diff: an fp16 cross-window sum
                </span>,
              ],
            },
          ]}
          foot="40 more match."
        />
      </Split>
    </div>
  );
}
