import type { Figure } from "@core/api/control/dashboard.ts";
import { useEffect, useRef, useState } from "react";
import { toneMark } from "./tone.ts";

/** A percentage as a gain is written: "+11.0%". */
export const percent = (gain: number) => `${gain >= 0 ? "+" : ""}${(gain * 100).toFixed(1)}%`;

/** A box's own width, kept current: a chart is drawn at the width it has. */
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const seen = new ResizeObserver((entries) =>
      setWidth(Math.round(entries[0]?.contentRect.width ?? 0)),
    );
    seen.observe(box);
    return () => seen.disconnect();
  }, []);
  return [ref, width];
}

/** A hill climb's champions as steps: each champion holds its gain until the next one. */
function Steps({
  steps,
  w,
  h,
  scale,
}: {
  steps: Figure["steps"];
  w: number;
  h: number;
  scale: boolean;
}) {
  const pad = scale ? { l: 50, r: 8, t: 10, b: 10 } : { l: 1, r: 1, t: 2, b: 2 };
  const t0 = Date.parse(steps[0]?.at ?? "");
  const t1 = Math.max(Date.now(), Date.parse(steps.at(-1)?.at ?? ""));
  const top = Math.max(0.0001, ...steps.map((s) => s.gain));
  const low = Math.min(0, ...steps.map((s) => s.gain));
  const x = (at: string) =>
    pad.l + ((Date.parse(at) - t0) / Math.max(1, t1 - t0)) * (w - pad.l - pad.r);
  const y = (gain: number) => h - pad.b - ((gain - low) / (top - low)) * (h - pad.t - pad.b);
  let path = "";
  steps.forEach((s, i) => {
    path += i === 0 ? `M${x(s.at)},${y(s.gain)}` : `H${x(s.at)}V${y(s.gain)}`;
  });
  path += `H${w - pad.r}`;
  const ticks = scale ? [low, low + (top - low) / 2, top] : [];
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width={w}
      height={h}
      role="img"
      aria-label={`The champion's gain over the starting point, ${steps.length} champion${steps.length === 1 ? "" : "s"}: ${percent(steps.at(-1)?.gain ?? 0)}`}
      className="shrink-0"
    >
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} className="stroke-grid" />
          <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" className="fill-quiet text-xs">
            {percent(t)}
          </text>
        </g>
      ))}
      {scale && (
        <path d={`${path}V${y(low)}H${x(steps[0]?.at ?? "")}Z`} className="fill-working/10" />
      )}
      <path d={path} fill="none" strokeWidth={scale ? 2 : 1.5} className="stroke-working" />
      {scale &&
        steps
          .slice(1)
          .map((s) => (
            <circle
              key={s.seq}
              cx={x(s.at)}
              cy={y(s.gain)}
              r={3.5}
              className="fill-background stroke-working"
              strokeWidth={2}
            />
          ))}
    </svg>
  );
}

/** A run's chart: its champions as steps, with the scale, at the width the screen gives it. */
export function StepChart({ steps }: { steps: Figure["steps"] }) {
  const [box, width] = useWidth();
  return (
    <div ref={box} className="h-44 w-full">
      {width > 0 && steps.length > 0 && <Steps steps={steps} w={width} h={176} scale />}
    </div>
  );
}

/** A goal run's goals as a bar of segments, one for each goal, in its state's colour. */
export function GoalBar({ goals }: { goals: Figure["goals"] }) {
  if (goals.length === 0) return null;
  const met = goals.filter((g) => g.state.tone === "good").length;
  return (
    <span
      role="img"
      aria-label={`${met} of ${goals.length} goals met`}
      className="inline-flex shrink-0 gap-0.5"
    >
      {goals.map((g) => (
        <span
          key={g.goal}
          title={`${g.goal}: ${g.state.word}`}
          className={`h-2 w-3 rounded-sm ${toneMark[g.state.tone]}`}
        />
      ))}
    </span>
  );
}

/** A run's result so far, as its mode shows it, with its headline. */
export function RunFigure({ figure }: { figure: Figure }) {
  return (
    <span className="flex shrink-0 items-center gap-2">
      {figure.steps.length > 1 && <Steps steps={figure.steps} w={90} h={22} scale={false} />}
      <GoalBar goals={figure.goals} />
      {figure.text && <span className="font-semibold tabular-nums">{figure.text}</span>}
    </span>
  );
}
