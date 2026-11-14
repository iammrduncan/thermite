import { Change, Chip, ShareBar, Sparkline, Stat, Stats } from "@ds";

const RISING = [120, 121, 124, 131, 138, 139, 146, 151, 158, 163, 170, 176, 181, 185, 188, 189];
const HOLDS = [30.2, 30.0, 30.3, 29.9, 30.1, 30.4, 30.0, 29.8, 30.2, 30.1, 30.3, 29.9, 30.0, 30.1];

export default function Numbers() {
  return (
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
  );
}
