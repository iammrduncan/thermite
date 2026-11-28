import { type CSSProperties, useId, useMemo } from "react";

export type PluginIconTones = [tile: string, tile2: string, ink: string, ink2: string];

export interface PluginIconSpec {
  path: string;
  turn: number;
  light: PluginIconTones;
  dark: PluginIconTones;
}

/** 32-bit FNV-1a hash of the normalized key so adjacent names yield unrelated seeds. */
export function iconSeed(key: string): number {
  const normalized = key.trim().toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    h = Math.imul(h ^ normalized.charCodeAt(i), 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(initialSeed: number): () => number {
  let seed = initialSeed;
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function oklchToLinearRgb(L: number, C: number, h: number): [number, number, number] {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const fitsSrgb = (rgb: readonly number[]) => rgb.every((v) => v >= -0.0005 && v <= 1.0005);

function oklchHex([L0, C]: readonly [number, number], h: number, lifted: boolean): string {
  const L = lifted
    ? Math.min(0.95, L0 + 0.07 * Math.max(0, 1 - Math.abs(((h - 100 + 540) % 360) - 180) / 55))
    : L0;
  let c = C;
  if (!fitsSrgb(oklchToLinearRgb(L, c, h))) {
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (fitsSrgb(oklchToLinearRgb(L, mid, h))) lo = mid;
      else hi = mid;
    }
    c = lo;
  }
  const toByte = (v: number) => {
    const clamped = Math.min(1, Math.max(0, v));
    const gamma = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(gamma * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${oklchToLinearRgb(L, c, h).map(toByte).join("")}`;
}

const TONES = {
  light: [
    [0.962, 0.03],
    [0.935, 0.04],
    [0.7, 0.15],
    [0.8, 0.125],
  ],
  dark: [
    [0.3, 0.05],
    [0.265, 0.045],
    [0.7, 0.14],
    [0.79, 0.11],
  ],
} as const;

function closedCurve(points: readonly [number, number][]): string {
  const n = points.length;
  const first = points[0];
  if (!first) return "";
  const f = (v: number) => v.toFixed(2);
  let d = `M${f(first[0])} ${f(first[1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n] ?? first;
    const p1 = points[i] ?? first;
    const p2 = points[(i + 1) % n] ?? first;
    const p3 = points[(i + 2) % n] ?? first;
    d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return `${d}Z`;
}

/** Deterministic procedural Bloom icon descriptor generated purely from `key` (e.g. `org/plugin`). */
export function pluginIconSpec(key: string): PluginIconSpec {
  const r = mulberry32(iconSeed(key));
  const hue = r() * 360;
  const spread = (26 + r() * 38) * (r() < 0.5 ? -1 : 1);
  const hue2 = (hue + spread + 360) % 360;
  const lobes = 3 + Math.floor(r() * 5);
  const harmonic = lobes + 1 + Math.floor(r() * 4);
  const a1 = 0.06 + r() * 0.14;
  const a2 = r() * 0.06;
  const p1 = r() * 2 * Math.PI;
  const p2 = r() * 2 * Math.PI;
  const turn = r() * 360;
  const radii: [number, number][] = Array.from({ length: 48 }, (_, k) => {
    const t = (k / 48) * 2 * Math.PI;
    return [t, 1 + a1 * Math.cos(lobes * t + p1) + a2 * Math.cos(harmonic * t + p2)];
  });
  const scale = 33 / Math.max(...radii.map(([, radius]) => radius));
  const path = closedCurve(
    radii.map(([t, radius]): [number, number] => [
      50 + radius * scale * Math.cos(t),
      50 + radius * scale * Math.sin(t),
    ]),
  );
  const paint = (set: (typeof TONES)["light" | "dark"]): PluginIconTones => [
    oklchHex(set[0], hue, false),
    oklchHex(set[1], hue2, false),
    oklchHex(set[2], hue, true),
    oklchHex(set[3], hue2, true),
  ];
  return {
    path,
    turn: Math.round(turn * 10) / 10,
    light: paint(TONES.light),
    dark: paint(TONES.dark),
  };
}

/** Deterministic procedural SVG icon for plugins and extensions, adapting to light/dark CSS vars. */
export function PluginIcon({ iconKey, size = 36 }: { iconKey: string; size?: number }) {
  const id = useId().replace(/\W/g, "");
  const { path, turn, light, dark } = useMemo(() => pluginIconSpec(iconKey), [iconKey]);
  const colors = Object.fromEntries([
    ...light.map((c, i) => [`--l${i}`, c]),
    ...dark.map((c, i) => [`--d${i}`, c]),
  ]) as CSSProperties;
  const stop = (offset: number, i: number) => (
    <stop offset={offset} style={{ stopColor: `var(--c${i})` }} />
  );
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      aria-hidden="true"
      className="plugin-icon shrink-0"
      style={colors}
    >
      <defs>
        <linearGradient id={`${id}t`} gradientTransform={`rotate(${turn} .5 .5)`}>
          {stop(0, 0)}
          {stop(1, 1)}
        </linearGradient>
        <linearGradient id={`${id}s`} gradientTransform={`rotate(${(turn + 90) % 360} .5 .5)`}>
          {stop(0, 2)}
          {stop(1, 3)}
        </linearGradient>
      </defs>
      <rect width="100" height="100" rx="24" fill={`url(#${id}t)`} />
      <path d={path} fill={`url(#${id}s)`} />
    </svg>
  );
}
