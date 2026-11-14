import { Tabs } from "@ds";
import { useState } from "react";

const TABS = ["Summary", "Explore", "Usage", "Results", "Setup"].map((label) => ({
  id: label,
  label,
}));

export default function TabsOfOneThing() {
  const [tab, setTab] = useState("Summary");
  return <Tabs label="A run's parts" tabs={TABS} chosen={tab} onChoose={setTab} />;
}
