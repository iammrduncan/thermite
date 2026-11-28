# Design System Sync Audit — Thermite v1 & fxbot (`v0.12.0`)

**Status:** Goal 0 preplanning audit (2026-11-28).  
**Evidence inspected:** Thermite `packages/design-system/` + `web/` (HEAD `4c42338e`; design system last updated `2026-11-15` in `0f6039c1`, Goal 243 landed `2026-11-14`) vs. `fxbot` `packages/ui/` + `plugins/web-pairing/` (release `0.12.0`, commit `5bc2a55`, `2026-11-27`; 27 commits to `packages/ui` since `2026-11-14` inclusive, 25 strictly after `2026-11-14`).

---

## TL;DR Recommendation

1. **Keep one shared package in Thermite's npm workspace now (`packages/design-system`), structured with clean subpath exports** so `fxbot` can adopt it verbatim later (via workspace/git/npm extraction) with zero consumer import rewrites.
2. **Split `theme.css` into `theme/base.css` (semantic tokens + neutral defaults) + thin brand presets (`theme/thermite.css`, `theme/fxbot.css`)** and decouple shared parts from hardcoded `flame`/`ember`/`Mark`/`Thermy` references.
3. **Sync the 17 stock `radix-nova` primitives from `fxbot`**, isolate heavy chat/editor/provider modules into **optional subpath entries** (`./chat`, `./providers`, `./editor`) with optional peer deps so unused features add 0 KB to bundles, and bring over `fxbot`'s resizable panes (`Gutter`/`BesideHost`), responsive `SettingsShell`/`Sheetish`, provider picker UX, and Vite dev speedups (`lucideIcons`).
4. **Delete the CSS-ban & ratchet bureaucracy** (`tests/web/design-system.test.ts`, `tests/web/brand.test.ts`, `scripts/design-system/link.mjs`, and `design-door`/`design-own` import rules). Allow apps to compose both `./primitives` and `./parts` with standard Tailwind layout utilities, guarded only by `tsc` + one tiny token-parity check.

---

## 1. Exact Token & Theme Drift

Both repos share the exact same underlying UI stack: React `19.3.1`, Vite `8.3.5`, Tailwind CSS `4.3.3` (`@tailwindcss/vite`), `tw-animate-css` `1.4.0`, `radix-ui` `1.8.1`, `lucide-react` `1.66.0`, `class-variance-authority` `0.7.1`, `cn` `0.5.1`, `@fontsource-variable/geist` `5.3.0`, and shadcn/ui `radix-nova` (`shadcn/tailwind.css` 637 LOC has **0 lines of diff** against Thermite's vendored `src/ui/tailwind.css`).

| Dimension | Thermite (`packages/design-system/src/theme.css`, 245 LOC) | `fxbot` (`packages/ui/src/index.css`, 338 LOC) | Drift & Resolution |
| --- | --- | --- | --- |
| **Base stylesheet** | Local vendored `src/ui/tailwind.css` (637 LOC) | `@import "shadcn/tailwind.css"` (`shadcn` `4.23.0`) | Identical (0 diff). Keep vendored or depend on `shadcn` in dev so runtime install stays light. |
| **Dark mode** | `@custom-variant dark (@media (prefers-color-scheme: dark))` | Identical OS-driven media query | Aligned. Fix Thermite `web/index.html:7` dark `theme-color` (`#0a0a0a` -> `#171412` / `#211d1a`). |
| **Color space & neutrals** | Warm-stone hexes (`#ffffff`/`#1c1917` light; `#211d1a`/`#fafaf9` dark; sidebar darker `#171412`; opaque borders `#34302c`) | Stock shadcn OKLCH achromatic (`oklch(1 0 0)`/`0.145` light; `0.145`/`0.985` dark; sidebar lighter `0.205`; translucent borders `1 0 0 / 10%`) | Pure preset difference. Move surface/border values into `presets/thermite.css` vs `presets/fxbot.css`. |
| **Primary / Brand accent** | `--primary` stays `#c2410c` in dark; text/ring accent `--flame` lightens to `#fb923c`; `--flame-tint`, `--ember` (`#f2542d`), `--color-ember-light` (`#ff8a3d`) | `--primary` flips near-black (`0.205`) -> near-white (`0.922`); dark `--sidebar-primary` blue (`0.488 0.243 264.376`); no accent-tint tokens | **Coupling bug:** 8 Thermite part files hardcode `text-flame`, `bg-flame-tint`, `border-flame`, `text-ember`, `Mark`, `Thermy`. Rename to `--brand-accent` / `--brand-accent-tint` / `--brand-mark` and pass brand icons as props. |
| **Semantic state tokens** | 20 tokens: `--good`/`working`/`needs`/`wrong`/`idle` + `-tint`, `-card`, `-edge`, `-dot`, `-mark`, `-bar`, `--soft`, `--grid`, `--toast`/`-foreground` | Only `--destructive` (1 chromatic token) | Promote Thermite's semantic status tokens into `base.css` with clean neutral/accessible defaults so `fxbot` gets consistent status colors for plugins (e.g., Web pairing reachability) for free. |
| **Typography** | `Geist Variable` + `Geist Mono Variable`; collapses `--font-weight-medium: 600`; body `text-sm` (`14px`, `lh 1.45`); adds `--text-sentence` (`1.375rem` / 600) | `Geist Variable` only (system mono fallback); standard weights (`500` & `600`); body inherits `16px`; `.fx-editor` uses `16px` mobile (`14px` `md:`) to block iOS input zoom | Keep `Geist` in `base.css`; import `Geist Mono`, `--font-weight-medium: 600`, body `text-sm`, and `--text-sentence` in `presets/thermite.css`. Keep `16px` mobile input floor where iOS Safari auto-zoom applies. |
| **Radii** | `--radius: 0.5rem`; collapsed to 3 steps (`sm: 4px`, `md/lg: 8px`, `xl/2xl/3xl: 16px`, `4xl: 999px`) | `--radius: 0.625rem`; proportional scale (`0.6x`..`2.6x`, `6px`..`26px`) | Define proportional defaults in `base.css`; override 3-step radii in `presets/thermite.css`. |
| **Shadows & icons** | 5 custom `--shadow-*` (`button`, `md`, `dialog`, `lg`, `page`) in warm-grey alpha; `.lucide { stroke-width: 1.75 }` | Stock Tailwind shadows; default Lucide `stroke-width: 2` | Move warm shadows + `stroke-width: 1.75` into `presets/thermite.css`; give `base.css` neutral shadow tokens so parts (`Act`, `Confirm`, `Lone`) work in both presets. |
| **App-specific CSS** | None outside `theme.css` (`web/src/index.css` is 1 `@import`) | 221 LOC in `index.css` (incl. 4 blank separators): `.gutter`/`[data-resizing]` (64), `@media print` for `[data-beside]` (6), `.fx-editor`/ProseMirror (88), `.said-md` (36), `.blob-*` (18), `.plugin-icon` (5) | Split cleanly: `.gutter` + `[data-beside]` print + `.plugin-icon` -> `base.css`; `.fx-editor`/ProseMirror -> `theme/editor.css`; `.said-md` -> `theme/chat.css`; `.blob-*` stays in `fxbot`. |

### Brand-vs-Semantic Split Architecture

```css
/* Consumer app CSS (2 lines — zero manual Tailwind config): */
@import "@fx/ui/theme/base.css";       /* Tailwind 4, tw-animate, shadcn/tailwind, @source, semantic defaults */
@import "@fx/ui/theme/thermite.css";   /* OR @fx/ui/theme/fxbot.css — ~45-70 LOC thin brand preset */
```

- **`theme/base.css`** owns `@import "tailwindcss"`, `@source "../"`, `@custom-variant dark`, `@theme inline` token mappings, generic semantic tokens (`--brand-accent`, `--brand-accent-tint`, `--brand-mark`, `--text-soft`, `--status-good/working/needs/wrong/idle` + tints/edges, `--toast`, `--grid`, `--shadow-button/dialog/page`), and structural CSS (`.gutter`, `[data-resizing]`, `[data-beside]` print, `.plugin-icon`). Defaults to stock neutral light/dark so any consumer renders cleanly without a preset.
- **`theme/presets/thermite.css`** (~70 LOC) overrides `:root` + dark `@media` with warm stone greys, flame (`#c2410c` / `#fb923c`), warm shadows, 3-step radii, `--font-weight-medium: 600`, `--text-sentence`, `Geist Mono`, and `.lucide { stroke-width: 1.75 }`.
- **`theme/presets/fxbot.css`** (~45 LOC) overrides `:root` + dark `@media` with `fxbot`'s OKLCH neutral palette (`--radius: 0.625rem`, `--brand-accent: var(--foreground)`, `--brand-accent-tint: var(--accent)`). Zero changes to `fxbot`'s existing visual identity.

---

## 2. Exact Component & Primitives Inventory Diff

### 2.1 Stock shadcn/ui Primitives (`radix-nova`)

| Group | Count | Files | Notes |
| --- | ---: | --- | --- |
| **Shared (0 logic diff)** | 8 | `button`, `dialog`, `input`, `separator`, `sheet`, `sidebar` (702 LOC), `skeleton`, `tooltip` | Byte-identical apart from `"use client"` header on `dialog`/`sheet` and import alias (`@ds/` vs `@/`). `hooks/use-mobile.ts` is also identical. |
| **Thermite-only** | 1 | `dropdown-menu` (268 LOC) | Used by `Menu` (`opens.tsx`). Keep. |
| **`fxbot`-only: Core UI** | 12 | `avatar`, `badge`, `checkbox`, `collapsible`, `context-menu`, `empty`, `input-group`, `native-select`, `popover`, `switch`, `tabs`, `textarea` | All stock `radix-nova` shadcn primitives (`data-slot`, `radix-ui`, `cn`). Thermite v1 immediately needs `popover`, `switch`, `checkbox`, `collapsible`, `native-select`, `textarea`, `badge`, `tabs`, `input-group`. |
| **`fxbot`-only: Chat / Trace** | 5 | `attachment`, `bubble`, `message`, `message-scroller` (`@shadcn/react/message-scroller`), `trace` | Needed by Thermite v1 **Live** agent transcripts (`trace`, `message-scroller`) and future **Thermy** plugin (`message`, `bubble`, `attachment`). Keep under `./chat` subpath. |

### 2.2 Composed Parts & App UX Patterns

| Category | Present in `fxbot` (`v0.12.0`) | Present in Thermite (`design-system` + `web/`) | Sync Action for v1 |
| --- | --- | --- | --- |
| **Since Nov 14 (`fxbot` v0.11 -> v0.12.0)** | | | |
| Resizable panes & side panel (`949981b`, `1bd363d`, `2b98c8f`) | `resize.tsx` (237 LOC: WAI-ARIA `Gutter`, `SidebarGutter`, `PaneGutter`, localStorage widths, 17px coarse touch, snap, drag-to-close); `beside.tsx` (97 LOC: `?beside=` desktop aside / mobile `Sheet`); `header.tsx` (31 LOC) | `Split` (`tree.tsx`, fixed flex wrap, no drag resize) | **Port to `./parts`:** `ResizeGutter`, `SidebarGutter`, `PaneGutter`, `BesidePanel`, `ScreenHeader` (parameterize storage prefix instead of hardcoded `fxbot.width.*`). |
| Input Markdown composer (`c012e15`, `ded76b0`, `de53b77`) | `editor.tsx` (94), `format-bar.tsx` (139), `formatting.ts` (725), `formatting-kit.ts` (28), `said.ts` (25) — lazy ProseMirror chunk, mobile `+` tray (`51c09a9`) | None | **Isolate in `./editor` (optional peer deps):** zero cost to Thermite v1 core; ready if `fxbot` adopts the kit or `Thermy` wants rich input later. |
| Fast paint, mobile & PWA (`0f76d56`, `ae09351`, `d5e31d1`, `938fcec`) | `pwa.ts` (87 LOC: `VitePWA` prompt-update, `useInstall`), inline splash (`index.html`, `interactive-widget=resizes-content`), `Crash` boundary (`main.tsx`), Vite `lucideIcons()` & dev `gzipped()` | `Fault` boundary (`web/src/main.tsx`), `viewport-fit=cover` (`web/index.html`) | **Adopt `lucideIcons()` Vite plugin** (cuts dev icon payload from ~5 MB barrel to used icons only) + `interactive-widget=resizes-content`. Make PWA opt-in per app. |
| Plugin UI runtime (`79f01ca`, `ae09351`, `e20cbb8`, `b847194`, `21abe1b`) | `plugins.tsx` (446 LOC: parallel single-flight loader, CJS `require` bridge exposing React + 15 UI primitives + `Streamdown`, `PluginPart` boundary, `Slot`), `fold.tsx` (`Fold`/`PillEntry`), `packages.tsx` (449) | None | **Align plugin UI bridge:** export a single `pluginUi` / `./primitives` + `./parts` bundle map so v1 UI plugins (`web-pairing`, `live`, `thermy`, `knowledge-*`) reuse the host's exact React & design-system copy. |
| Pairing & Settings UI (`settings.tsx`, `providers.tsx:183`, `plugins/web-pairing/fxbot/page.jsx`) | Responsive Settings nav (`settings.tsx`: scrollable pills mobile -> `w-48` rail `lg:`), `Sheetish` (`providers.tsx:183`: dialog desktop / full `dvh` sheet mobile), WebRTC QR + 6-digit SAS + reachability rows | `web/src/screens/settings.tsx` (hand-coded copy of `fxbot`'s responsive nav rail, still in `NOT_YET_REBUILT`) | **Promote `SettingsShell` & `ResponsiveDialog` (`Sheetish`) to `./parts`**; reuse `QrCode` component (optional `qrcode-generator` peer) for device sign-in & WebRTC pairing. |
| **Pre-Nov 14 in `fxbot` (still missing in Thermite)** | | | |
| Catalogue Provider & Model Setup | `add-provider.tsx` (578), `providers.tsx` (310: `ModelField` searchable combobox + typed fallback), `provider-logos.ts` (183 SVGs, 274 KB lazy chunk), `onboarding.tsx` (180) | None in `web/` (old `/ui/settings` only) | **Extract API-agnostic `./providers`:** `ModelCombobox`, `ProviderMark` (lazy `./provider-logos`), `ProviderCatalog`, `DeviceCodePanel` — wired via callbacks so both Thermite (allowing LAN HTTP endpoints out of the box!) and `fxbot` share it. |
| Agent Trace & Streaming Markdown | `steps.tsx` (192 LOC: `Reply`, folding `Thinking`/`ToolCall` on `Trace` + `Streamdown` `2.7.1`) | None | **Extract API-agnostic `TraceSteps` + `Markdown` into `./chat`** for Thermite **Live** & `fxbot` chats. |
| Procedural icons & drag reorder | `plugin-icon.tsx` (26 LOC, `PluginIcon` SVG), `reorder.ts` (`useReorder`) | None | Optional in `./parts` (`PluginIcon` needs tiny pure hash/path helper decoupled from `@fxbot/sdk`). |
| **Thermite-only (missing in `fxbot`)** | | | |
| Operator dashboard parts (`src/parts/`, 17 files, 1,828 LOC) | None | `Screen`, `Section`, `Frame`/`NavLine`/`NavList`/`NavItem`/`NavAccount`, `Lone`/`Alone`, `Act`/`IconAct`/`TextLink`, `Chip`/`Dot`/`Count`/`Legend`, `Change`, `Stat`/`Stats`/`Sparkline`/`ShareBar`, `Things`/`Thing`/`Facts`/`Grid`/`Named`/`Mono`, `NeedCard`, `Menu`/`Confirm`/`Undo`, `Field`/`Info`/`Segmented`/`Fold`/`Group`, `Tabs`, `Tree`/`Split`, `Explorer` (`Fields`/`Views`/`Band`), `CopyId` (with HTTP `execCommand` fallback!), `Loading`/`Wrong`/`Failure`/`Empty`/`Nothing` | **Keep & de-brand:** replace `flame`/`ember` classes with semantic tokens; pass `brand` (`Mark`) & `art` (`Thermy`) as props into `Frame`/`Lone`/`Empty`; replace `Field`'s raw `<input>`/`<select>` with stock `Input`/`NativeSelect`/`Textarea` where equivalent; keep `CopyId`'s plain-HTTP fallback (better than `fxbot`'s `navigator.clipboard`-only copy!). |
| Unmigrated `web/src/parts/` (291 unmigrated / 378 total LOC) | None | `StepChart` + `GoalBar` (`figure.tsx`, 128), `Since` (`time.tsx`, 41), `NeedRows`/`RunCard`/`NowLines`/`EventRows` (`rows.tsx`, 122); `run-top.tsx` (87) is already migrated to `@ds` | Promote generic `StepChart` & `GoalBar` into `./parts/charts.tsx` (or keep in Thermite `packages/ui` until second use); delete rig-coupled `rows.tsx` in v1. |
| CSP nonce, license emitter, site | None | `lib/nonce.ts` (`takePageNonce`), `build/licenses.ts` (`styleLicenses`), `site/` (13 pages, 27 examples) | Keep `takePageNonce` (`./lib/nonce`) and `styleLicenses` as opt-in helpers. Keep `site/` as voluntary dev gallery (drop CI completeness gate). |

---

## 3. Target Packaging, Workspace & Adoption Shape

### 3.1 Monorepo Package Now -> Standalone Repo Ready

Keep the library in **`packages/design-system/`** inside Thermite's root npm workspaces NOW (matching `fxbot`'s root `"workspaces": ["packages/*"]` with **one root `package-lock.json`**), eliminating `web/package-lock.json` and the fragile `scripts/design-system/link.mjs` symlink. Because the package imports **zero** Thermite code and exposes clean package subpath exports (no relative `../../packages/design-system/...` or `@ds` path-alias hacks), extracting it to a standalone repo/package when `fxbot` adopts it requires changing only one `package.json` version specifier.

```text
packages/design-system/
├── package.json              # workspace pkg; source-exported .ts/.tsx (no double build for Vite!)
├── components.json           # shadcn CLI target -> src/primitives/
├── src/
│   ├── theme/
│   │   ├── base.css          # Tailwind 4 + tw-animate + shadcn/tailwind + @source "../" + semantic defaults
│   │   ├── chat.css          # optional: Streamdown bubble overrides
│   │   ├── editor.css        # optional: ProseMirror + .fx-editor rules
│   │   └── presets/
│   │       ├── thermite.css  # warm greys + flame + 2 weights + 3 radii + Geist Mono + Lucide 1.75
│   │       └── fxbot.css     # OKLCH neutral + 0.625rem radii + standard weights
│   ├── primitives/           # stock shadcn/ui radix-nova (26 files: 8 shared + 1 Thermite + 17 fxbot)
│   ├── parts/                # shared composed parts (de-branded: Screen, AppFrame, SettingsShell,
│   │                         #   ResponsiveDialog, ResizeGutter, BesidePanel, Chip/Tone, Stat,
│   │                         #   DataGrid, NeedCard, Tree, CopyId, Confirm, Undo, Explorer, ...)
│   ├── chat/                 # optional entry: Message, Bubble, MessageScroller, Trace, Attachment, TraceSteps
│   ├── providers/            # optional entry: ModelCombobox, ProviderMark, ProviderCatalog, DeviceCodePanel, logos.ts
│   ├── editor/               # optional entry (for fxbot / future chat): ProseMirror Editor + FormatBar
│   ├── hooks/use-mobile.ts
│   └── lib/                  # utils.ts (cn, blurb), nonce.ts (takePageNonce)
└── site/                     # voluntary dev storybook (npm run design:dev); no CI lock-step gate
```

### 3.2 Package Exports & Peer Dependency Tiers

Export raw TypeScript/TSX directly (`"exports"` pointing to `./src/...`) — Vite 8 + `tsc` compile it natively alongside the app with instant HMR and zero pre-build step:

```json
{
  "name": "@fx/ui",
  "version": "0.1.0",
  "type": "module",
  "sideEffects": ["**/*.css"],
  "exports": {
    "./primitives": "./src/primitives/index.ts",
    "./primitives/*": "./src/primitives/*.tsx",
    "./parts": "./src/parts/index.ts",
    "./chat": "./src/chat/index.ts",
    "./providers": "./src/providers/index.ts",
    "./provider-logos": "./src/providers/logos.ts",
    "./editor": "./src/editor/index.ts",
    "./lib/utils": "./src/lib/utils.ts",
    "./lib/nonce": "./src/lib/nonce.ts",
    "./hooks/use-mobile": "./src/hooks/use-mobile.ts",
    "./theme/base.css": "./src/theme/base.css",
    "./theme/thermite.css": "./src/theme/presets/thermite.css",
    "./theme/fxbot.css": "./src/theme/presets/fxbot.css",
    "./theme/chat.css": "./src/theme/chat.css",
    "./theme/editor.css": "./src/theme/editor.css"
  },
  "peerDependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "radix-ui": "^1.8.0",
    "lucide-react": "^1.66.0",
    "class-variance-authority": "^0.7.1",
    "cn": "^0.5.1",
    "tailwindcss": "^4.3.0",
    "tw-animate-css": "^1.4.0",
    "@fontsource-variable/geist": "^5.3.0",
    "@fontsource-variable/geist-mono": "^5.3.0",
    "@shadcn/react": "^0.3.1",
    "streamdown": "^2.7.0",
    "qrcode-generator": "^2.0.4",
    "get-nonce": "^1.0.1",
    "prosemirror-commands": "^1.7.2",
    "prosemirror-history": "^1.5.2",
    "prosemirror-inputrules": "^1.7.0",
    "prosemirror-keymap": "^1.2.3",
    "prosemirror-model": "^1.25.13",
    "prosemirror-schema-list": "^1.6.1",
    "prosemirror-state": "^1.4.4",
    "prosemirror-transform": "^1.12.7",
    "prosemirror-view": "^1.44.0"
  },
  "peerDependenciesMeta": {
    "@fontsource-variable/geist-mono": { "optional": true },
    "@shadcn/react": { "optional": true },
    "streamdown": { "optional": true },
    "qrcode-generator": { "optional": true },
    "get-nonce": { "optional": true },
    "prosemirror-commands": { "optional": true },
    "prosemirror-history": { "optional": true },
    "prosemirror-inputrules": { "optional": true },
    "prosemirror-keymap": { "optional": true },
    "prosemirror-model": { "optional": true },
    "prosemirror-schema-list": { "optional": true },
    "prosemirror-state": { "optional": true },
    "prosemirror-transform": { "optional": true },
    "prosemirror-view": { "optional": true }
  }
}
```

- **Brand assets stay in each app:** `Mark` and `Thermy` move to Thermite's `packages/ui/src/brand/`; `Blob` stays in `fxbot`'s `packages/ui/src/brand/`. `AppFrame`, `Lone`, and `Empty` accept `brand?: ReactNode` / `art?: ReactNode`.
- **Optional heavy subpaths cost 0 KB when unused:** `./chat` (uses `@shadcn/react`, `streamdown`), `./providers` (`qrcode-generator` + dynamic-imported `./provider-logos`), and `./editor` (9 `prosemirror-*` optional peers) are only installed and bundled by apps that import them.
- **Two-tier consumption (zero CSS-ban bureaucracy):** Apps import *either* `@fx/ui/parts` *or* `@fx/ui/primitives/button` and write normal Tailwind layout/spacing classes (`flex`, `grid`, `gap-4`, `p-4`) on screens. Delete `tests/web/design-system.test.ts`, `tests/web/brand.test.ts`, and `design-door`/`design-own` in `scripts/checks/lib/imports.ts`.
- **Two lean checks replace all of it (< 2s):**
  1. Workspace `tsc --noEmit` (enforces exact prop & subpath export types).
  2. One ~25-line check verifying (a) `packages/design-system/src/` imports nothing outside itself, and (b) every `var(--*)` in `theme/base.css` `@theme inline` has a light + dark value (so broken tokens fail fast without policing JSX `className`s).
- **Fast Vite builds & dev:** Port `fxbot`'s `lucideIcons()` Vite serve plugin (`optimizeDeps: { exclude: ["lucide-react"] }`), keep `provider-logos` as a dynamic `import()` chunk (274 KB loaded only when Add Provider opens), and expose the package's `primitives` + `parts` on Thermite's plugin runtime bridge so UI plugins bundle zero duplicate React/Radix code.

---

## 4. Pre-Screen Sync Checklist for `packages/design-system`

Execute these steps before building the first Thermite v1 UI screen:

- [ ] **1. Move to root npm workspaces:** add `"workspaces": ["packages/*"]` to root `package.json`; remove `scripts/design-system/link.mjs` and separate `web/package-lock.json`; wire `@fx/ui` (or `@thermite/design-system`, per Open Call #1) as a workspace dependency of `packages/ui`.
- [ ] **2. Split `src/theme.css` -> `theme/base.css` + `theme/presets/{thermite,fxbot}.css`:**
  - Rename internal token usages in `parts/` from `flame` / `flame-tint` / `ember` -> `brand-accent` / `brand-accent-tint` / `brand-mark` (`act.tsx`, `frame.tsx`, `tabs.tsx`, `tree.tsx`, `explorer.tsx`, `field.tsx`).
  - Add `.gutter`, `html[data-resizing]`, `[data-beside]` print rule, and `.plugin-icon` to `base.css`.
  - Fix dark `theme-color` meta tag (`#171412` / `#211d1a`) in Thermite's `index.html`.
- [ ] **3. De-brand composed parts:** move `src/brand/{mark,thermy}.tsx` out to Thermite's `packages/ui/src/brand/`; add `brand?: ReactNode` prop to `Frame` & `Lone` and `art?: ReactNode` to `Empty`.
- [ ] **4. Sync the 17 `fxbot` `radix-nova` primitives into `src/primitives/`:**
  - Core (12): `avatar`, `badge`, `checkbox`, `collapsible`, `context-menu`, `empty`, `input-group`, `native-select`, `popover`, `switch`, `tabs`, `textarea`.
  - Chat/Trace (5, re-exported under `./chat`): `attachment`, `bubble`, `message`, `message-scroller`, `trace`.
  - Update `components.json` aliases to `@/primitives`, `@/lib`, `@/hooks` so `npx shadcn@latest add` works cleanly in place.
- [ ] **5. Port high-value `fxbot` v0.12 UX patterns into `./parts`, `./providers`, `./chat`:**
  - `./parts`: `ResizeGutter` / `SidebarGutter` / `PaneGutter` (with configurable storage key), `BesideHost`/`BesidePanel`, `SettingsShell` (mobile pill bar + desktop rail), `ResponsiveDialog` (`Sheetish`), `FoldPill`.
  - `./providers`: API-agnostic `ModelCombobox` (from `providers.tsx`), `ProviderMark` + lazy `./provider-logos` (after license verification — see Open Call #2), `ProviderCatalog`, `DeviceCodePanel` (with `QrCode` + HTTP-safe `CopyId`).
  - `./chat`: API-agnostic `TraceSteps` + `Markdown` (`streamdown` wrapper).
- [ ] **6. Unify overlapping form controls:** `field.tsx` currently renders raw `<input>`/`<textarea>`/`<select>` despite `src/ui/input.tsx` existing; wrap stock `Input`/`Textarea`/`NativeSelect` primitives instead, preserving `CopyId`'s plain-HTTP fallback.
- [ ] **7. Drop CSS-ban tests & add Vite `lucideIcons()` plugin:** remove `tests/web/design-system.test.ts`, `tests/web/brand.test.ts`, and `design-door`/`design-own` rules; add the ~25-line token-parity + boundary check and `lucideIcons()` dev transform in `packages/ui/vite.config.ts`.
- [ ] **8. Smoke-test both presets:** verify `packages/design-system/site/` renders cleanly under both `theme/thermite.css` and `theme/fxbot.css` in light & dark mode at `1440px` and `390px`.

---

## 5. Open Owner Calls

1. **Package name & eventual home:** Keep `@thermite/design-system` in Thermite's monorepo until `fxbot` adopts it (renaming/splitting later), or name it neutrally right now (e.g., `@fx/ui` or `@hitl/ui`) so `fxbot` never has to import `@thermite/*`? *(Recommendation: neutral workspace name like `@fx/ui` now, still inside Thermite's monorepo until `fxbot` is ready to pull from a shared repo.)*
2. **Provider logos bundle (183 SVGs, 274 KB):** `fxbot`'s `provider-logos.ts` bundles MIT-licensed icons from LobeHub, `models.dev`, and `llama.cpp` (trademarks used nominatively) plus a generator script. Include it in `./provider-logos` with attribution in `CREDITS.md` and `licenses-styles.md`? *(Recommendation: yes — lazy-loaded chunk + attribution matches `fxbot`.)*
3. **Typography weight & control height across both products:** Thermite sets `--font-weight-medium: 600` (2 weights) and `36px` (`h-9`) controls; `fxbot` keeps `font-medium: 500` (3 weights) and stock shadcn `32px` (`h-8`) controls. Keep these per-preset (`thermite.css` overrides `--font-weight-medium: 600` and `Act`/`Field` size defaults), or converge both products onto one scale? *(Recommendation: keep per-preset CSS variables so neither product has an unintended visual shift.)*
4. **PWA (`vite-plugin-pwa`) & instant splash in Thermite v1:** Should Thermite v1 ship `fxbot`'s installable PWA + `registerType: "prompt"` update banner + inline splash from day one (great with `web.usethermite.com` mobile pairing), or defer PWA until the `web-pairing` plugin lands? *(Recommendation: add `index.html` splash + safe-area insets now; enable `VitePWA` when `web-pairing` lands so local dev/auth cookies stay simple first.)*
5. **Design-system gallery site (`/design`):** Keep `packages/design-system/site/` as a **dev-only storybook** (`npm run design:dev`) instead of bundling and serving it from Control at `/design` in production? *(Recommendation: dev-only — saves build time, binary/image size, and CSP route maintenance while keeping live visual testing.)*
