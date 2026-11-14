import { Change, Chip, Sparkline, TextLink, Thing, Things } from "@ds";

export default function Rows() {
  return (
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
      <Thing name={<TextLink href="#">pn-quality-2</TextLink>} sub="a goal · day 2">
        <span className="flex-1" />
        <Chip state={{ word: "Paused", tone: "none" }} />
      </Thing>
    </Things>
  );
}
