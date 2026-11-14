import { Chip, Count, Dot, Legend } from "@ds";

export default function Chips() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <Chip state={{ word: "Kept", tone: "good" }} />
        <Chip state={{ word: "At work", tone: "working" }} />
        <Chip state={{ word: "Needs you", tone: "needs" }} />
        <Chip state={{ word: "Failed", tone: "wrong" }} />
        <Chip state={{ word: "Paused", tone: "none" }} />
      </div>
      <div className="flex flex-wrap items-center gap-6">
        <span className="flex gap-2">
          <Dot tone="working" label="At work" />
          <Dot tone="good" label="Kept" />
          <Dot tone="needs" label="Needs you" />
          <Dot tone="wrong" label="Failed" />
          <Dot tone="none" label="Paused" />
        </span>
        <Count>2</Count>
      </div>
      <Legend
        items={[
          { tone: "good", word: "Kept", count: 2 },
          { tone: "working", word: "Judging", count: 2 },
          { tone: "wrong", word: "Broken", count: 8 },
          { tone: "none", word: "Lost", count: 34 },
        ]}
      />
    </div>
  );
}
