import { useEffect, useState } from "react";

/** How long ago, or for how long, in the two largest units: "45 s", "12 min", "5 h 24 min", "2 d 3 h". */
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/** A time as the browser's own date and time, for a tooltip. */
const exact = (at: string) => {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString();
};

/** The time now, read again every half minute, so what a screen says of ages stays true. */
function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** How long since a time, kept current, with the exact time on hover. `after` follows it: "ago". */
export function Since({ at, after = "" }: { at: string | null; after?: string }) {
  const now = useNow();
  if (!at) return null;
  return (
    <time dateTime={at} title={exact(at)} className="tabular-nums">
      {span(now - Date.parse(at))}
      {after ? ` ${after}` : ""}
    </time>
  );
}
