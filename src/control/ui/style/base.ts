/** The colours and sizes every rule uses, light and dark, and the bare elements' look. */
export const BASE = `:root {
  color-scheme: light;
  --background: #fcfcfd; --foreground: #27272a; --card: #ffffff; --popover: #ffffff;
  --muted: #fafafa; --muted-foreground: #71717a; --accent: #f4f4f5; --accent-foreground: #18181b;
  --border: #e4e4e7; --input: #d4d4d8;
  --primary: oklch(0.488 0.217 264); --primary-foreground: #ffffff;
  --primary-surface: color-mix(in srgb, var(--primary) 8%, transparent);
  --success: #10b981; --success-foreground: #047857;
  --success-surface: color-mix(in srgb, var(--success) 10%, transparent);
  --warning: #f59e0b; --warning-foreground: #b45309;
  --warning-surface: color-mix(in srgb, var(--warning) 9%, transparent);
  --error: #ef4444; --error-foreground: #b91c1c;
  --error-surface: color-mix(in srgb, var(--error) 8%, transparent);
  --info: #3b82f6; --info-foreground: #1d4ed8;
  --violet-foreground: #7c3aed;
  --sidebar: #fafafa; --sidebar-row-hover: #fcfcfd; --sidebar-row-active: #ffffff;
  --code-background: #f7f7f8;
  --radius: 0.625rem; --control-radius: 0.5rem;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --font-mono: ui-monospace, "SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --background: #0a0a0a; --foreground: #f5f5f5;
    --card: color-mix(in srgb, #0a0a0a 97%, #ffffff); --popover: var(--card);
    --muted: rgb(255 255 255 / 3%); --muted-foreground: color-mix(in srgb, #737373 90%, #ffffff);
    --accent: rgb(255 255 255 / 4%); --accent-foreground: #f5f5f5;
    --border: rgb(255 255 255 / 7%); --input: rgb(255 255 255 / 10%);
    --primary: oklch(0.571 0.21 264);
    --primary-surface: color-mix(in srgb, var(--primary) 16%, transparent);
    --success-foreground: #34d399; --success-surface: color-mix(in srgb, var(--success) 16%, transparent);
    --warning-foreground: #fbbf24; --warning-surface: color-mix(in srgb, var(--warning) 16%, transparent);
    --error: color-mix(in srgb, #ef4444 90%, #ffffff); --error-foreground: #f87171;
    --error-surface: color-mix(in srgb, var(--error) 16%, transparent);
    --info-foreground: #60a5fa; --violet-foreground: #a78bfa;
    --sidebar: var(--card); --sidebar-row-hover: var(--accent); --sidebar-row-active: rgb(255 255 255 / 7%);
    --code-background: rgb(255 255 255 / 4%);
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; background: var(--background); color: var(--foreground); font: 14px/1.45 var(--font-sans);
  -webkit-font-smoothing: antialiased; }
a { color: inherit; text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 2px; }
code, .mono { font-family: var(--font-mono); font-size: 12px; }
h1, h2, h3 { margin: 0; font-weight: 600; }`;
