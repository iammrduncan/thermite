import { Grid, Named } from "@ds";
import { FolderIcon } from "lucide-react";

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

export default function Table() {
  return (
    <Grid
      label="Items"
      columns="minmax(0,1fr) 112px 96px 96px"
      heads={["Item", "In", "Written by", "When"]}
      rows={ITEMS.map(([item, kind, where, who, when]) => ({
        key: item,
        cells: [
          <Named key="name" name={item} sub={kind} />,
          <span key="in" className="inline-flex items-center gap-2 text-soft">
            <FolderIcon className="size-3.5 text-ember" /> {where}
          </span>,
          <span key="by" className="text-soft">
            {who}
          </span>,
          <span key="when" className="text-xs text-quiet">
            {when}
          </span>,
        ],
      }))}
      foot="9,490 more items in pn-prefill-2"
    />
  );
}
