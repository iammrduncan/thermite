import { Act, Chip, Nothing, Screen, Section, Tabs } from "@ds";
import { PlusIcon } from "lucide-react";

export default function TheTopOfAScreen() {
  return (
    <div className="rounded-xl border">
      <Screen
        kind="detail"
        title="pn-prefill-2"
        crumbs={[
          { label: "Knowledge", href: "#" },
          { label: "pn-prefill", href: "#" },
        ]}
        state={<Chip state={{ word: "At work", tone: "working" }} />}
        actions={
          <Act look="main" icon={PlusIcon}>
            Add a note
          </Act>
        }
        tabs={
          <Tabs
            label="Its parts"
            tabs={[
              { id: "items", label: "Items" },
              { id: "writers", label: "Writers" },
            ]}
            chosen="items"
          />
        }
        sentence="9,498 items from 6 writers. Only pn-prefill's agents may read them."
      >
        <Section title="A block" count={3} hint="newest first">
          <Nothing>A block has a title in 16 px, a count, and what it holds.</Nothing>
        </Section>
      </Screen>
    </div>
  );
}
