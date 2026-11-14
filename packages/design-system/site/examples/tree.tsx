import { Nothing, Split, Tree, type TreeItem } from "@ds";
import { useState } from "react";

const ITEMS: TreeItem[] = [
  { id: "pn-prefill", name: "pn-prefill", level: 1, open: true, count: "9,499" },
  { id: "pn-prefill-2", name: "pn-prefill-2", level: 2, open: true, count: "9,498" },
  { id: "records", name: "records", level: 3, open: false, count: "8,940" },
  { id: "teachers", name: "teachers", level: 3, open: false, count: "266" },
  { id: "planner", name: "planner", level: 3, open: false, count: "20" },
  { id: "brief", name: "The campaign's brief", level: 3 },
  { id: "pn-prefill-1", name: "pn-prefill-1", level: 2, open: false, count: "1" },
  { id: "pn-speed", name: "pn-speed", level: 1, open: false, count: "4,203" },
];

export default function TreeBesideWhatIsPicked() {
  const [chosen, setChosen] = useState("pn-prefill-2");
  return (
    <Split
      wide
      aside={<Tree label="Knowledge" items={ITEMS} chosen={chosen} onChoose={setChosen} />}
    >
      <Nothing>What is picked in the tree shows here: {chosen}.</Nothing>
    </Split>
  );
}
