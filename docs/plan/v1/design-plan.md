# Thermite v1 — UI/UX Design Plan & Magnesium Direction

**Status:** Gate 5 baseline approved by owner (2026-11-28) to start `v1` implementation, paired with the interactive prototype at [`mockups/index.html`](mockups/index.html) and the component sync audit at [`goal-0/design-system-sync.md`](goal-0/design-system-sync.md). Screen 7 (Observability Explorer) is approved as a starting point and flagged for iterative revisions once live run data flows.  
**Package:** `@iammrduncan/magnesium` (`packages/design-system/`, shared with `fxbot`).

---

## 1. Honest Postmortem: Why Claude's v0.3.0 UI Fell Short

Claude's v0.3.0 refresh got three things right—and the owner explicitly validated them: the **warm-stone + flame palette** (including dark mode's `#211d1a` canvas over `#171412` sidebar), keeping the **Knowledge folder/file tree**, and adding **icons to sidebar items**. Everything around those choices went wrong because process rules replaced visual and interaction craft.

### Concrete Failures Observed in v0.3.0 (`web/src/`, `packages/design-system/`, and Canvas Boards)

1. **Governance-driven "cookie-cutter" layouts:** Every screen was forced through one rigid `<Screen>` wrapper (`max-w-[960px]`, single column, `gap-10` vertical stack) policed by numeric board budgets (`Height / Words / Blocks / Buttons`) and automated tests (`tests/web/design-system.test.ts` regex-banning `className=` and `style=` in `web/src/`). The result was mechanical: a 22px summary sentence, a row of four equal `<Stat>` tiles (`web/src/screens/home.tsx:34-45`), and identical bordered boxes stacked down the page regardless of what decision the operator actually came to make.
2. **Sterile, rigid execution and broken flow ("fung shui"):** Across four review rounds, boards swung between two bad extremes—first burying pages in checkboxes, multi-step confirmation dialogs, and 15–45 field forms ("needs a 1,000-page manual"), then stripping them so hard that screens turned stark black-and-white with zero hierarchy or character ("too plain, no harmony or flow").
3. **Tab-hopping hid the real work:** Banning side panels outside Explore/Knowledge while splitting a run across 5 tabs (`Summary`, `Explore`, `Usage`, `Results`, `Setup`) plus separate `Watch`, `Steer`, and `Attempt` pages meant an operator could never see **the speedup curve, the candidate diff, and live worker tool calls at the same time**. Diagnosing a stalled lane or inspecting a borderline promotion required bouncing across 3–4 routes and losing scroll state each time.
4. **Non-tactile, rigid primitives:** `Split` (`packages/design-system/src/parts/tree.tsx:92-115`) was a static `flex-wrap` container with zero drag resizing; `NeedRows` (`web/src/parts/rows.tsx:22-54`) forced page navigation before showing evidence or letting you resolve a hold; `field.tsx` re-implemented raw `<input>`/`<select>` instead of wrapping stock primitives; and 8 shared parts hardcoded `text-flame`, `bg-flame-tint`, `Mark`, and `Thermy`, blocking reuse by `fxbot`.
5. **High-friction onboarding and campaign setup:** `web/` landed without onboarding, provider catalogue setup, or campaign creation. v0.2's real entry path stayed a multi-area obstacle course (add provider → configure rig → clone source → tar kit → 6-step form that reset blank on error), and `design-system.test.ts` locked every tiny layout tweak behind a mandatory gallery-example and symlink ceremony (`link.mjs`).

**v1 Lesson:** Clarity comes from **spatial hierarchy, direct manipulation, and progressive disclosure**—never from regex-policing `className` or forcing every screen into the same one-column template.

---

## 2. Elevated Magnesium (`@iammrduncan/magnesium`) Design Direction

Thermite v1 fuses the warm-stone + flame identity the owner loved with the **calm, tactile, high-density engineering ergonomics** of `fxbot` (`v0.12.0`).

### Token & Theme Architecture (Light + Dark)

- **Two-layer CSS:** `@iammrduncan/magnesium/theme/base.css` owns Tailwind 4, semantic state tokens (`--good`, `--working`, `--needs`, `--wrong`, `--idle` + tints/edges), and structural rules (`.gutter`, `[data-resizing]`, `[data-beside]` print, `.plugin-icon`). Thin presets (`presets/thermite.css` ~70 LOC; `presets/fxbot.css` ~45 LOC) override brand neutrals, accents, radii, and per-preset control scale (Decision #14: Thermite keeps `--font-weight-medium: 600` and `36px`/`h-9` hit targets; `fxbot` keeps `500` and `32px`/`h-8`).
- **Warm-stone neutrals, never cold pure black/white:** Light surfaces step `#faf9f7` (sidebar) → `#ffffff` (canvas) → `#f3f1ee` (chosen/hover) with `#e7e5e4` hairlines. Dark surfaces step `#171412` (sidebar) → `#211d1a` (canvas) → `#2e2925` (elevated/hover) with `#34302c` hairlines.
- **Restrained flame accent:** `#c2410c` (light primary + text; dark primary fill) and `#fb923c` (dark text/ring, passing 4.5:1 AA contrast) appear **only** at high-signal moments: the single primary CTA per screen, active nav/tab indicator, links, and brand mark. Zero blue-purple gradients, zero glassmorphism, zero ambient glows, zero decorative emoji, and zero looping status pulses.
- **Semantic color carries real state only:** Green = promoted/healthy, Blue = active/measuring, Amber = needs human decision / hold, Red = broken/invalid/destructive, Neutral grey = idle/archived. Every status badge pairs color with a crisp label (and a solid non-pulsing dot only when marking real state).

### Magnesium Token Contract (`presets/thermite.css`)

| Role | CSS Token | Light Value | Dark Value | Usage Boundary |
| --- | --- | --- | --- | --- |
| **Canvas** | `--background` / `--card` | `#ffffff` | `#211d1a` | Primary workspace & flat bordered cards |
| **Sidebar** | `--sidebar` | `#faf9f7` | `#171412` | Left navigation rail & nested tree background |
| **Surface / Hover** | `--muted` / `--chosen` | `#f3f1ee` | `#2e2925` | Hover rows, active neutral pills, subtle callouts |
| **Hairline / Control** | `--border` / `--input` | `#e7e5e4` / `#d6d3d1` | `#34302c` / `#4a4541` | 1px flat structural borders (borders over shadows) |
| **Ink Hierarchy** | `--foreground` / `--soft` / `--quiet` | `#1c1917` / `#44403c` / `#6f6862` | `#fafaf9` / `#d6d3d1` / `#a8a29e` | Names/numbers, secondary prose, timestamps/labels |
| **Flame Accent** | `--primary` / `--flame` / `--flame-tint` | `#c2410c` / `#c2410c` / `#fff3ec` | `#c2410c` / `#fb923c` / `#3a1d10` | Primary CTA, active nav/tab, links only |
| **Semantic Good** | `--good` / `--good-tint` | `#15803d` / `#eefaf2` | `#4ade80` / `#12281a` | Promoted champions, passing checks, ready devices |
| **Semantic Working** | `--working` / `--working-tint` | `#1d4ed8` / `#e8effe` | `#60a5fa` / `#16223b` | Active trials, judge measuring, running lanes |
| **Semantic Needs** | `--needs` / `--needs-card` / `--needs-edge` | `#b45309` / `#fffaf0` / `#f1dcae` | `#fbbf24` / `#2a1f0e` / `#4d3c18` | Non-blocking operator holds & warnings |
| **Semantic Wrong** | `--wrong` / `--wrong-tint` | `#b91c1c` / `#fdecec` | `#f87171` / `#2f1717` | Crashes, invalid builds, destructive confirmations |

### Tactile Patterns Adopted from `fxbot` (`v0.12.0`)

| Pattern | Magnesium Export | Why It Elevates Thermite v1 |
| --- | --- | --- |
| **Resizable split panes** | `ResizeGutter`, `SidebarGutter`, `PaneGutter` | Smooth pointer-captured pane resizing with snap-to-default, double-click reset, WAI-ARIA keyboard arrows, drag-to-close, and `localStorage` width memory. |
| **Slide-over / beside inspectors** | `BesideHost`, `BesidePanel` (`?beside=`) | Open an attempt diff, judge A/B+B/A breakdown, or `Needs You` review beside the active workspace; reload preserves it, Back closes it, mobile `< 768px` promotes it to a full-height `Sheet`. |
| **Responsive dialogs & settings** | `ResponsiveDialog`, `SettingsShell` | Dialogs on desktop become clean full-height sheets on `390px` phones; Setup uses a `w-48` left rail on desktop and a horizontally scrolling pill strip on mobile. |
| **Catalogue provider setup** | `./providers` (`ProviderCatalog`, `ModelCombobox`, lazy `./provider-logos`) | Categorized Sign-in / API Key / **Local & LAN HTTP** (Ollama, vLLM, llama.cpp) tiles with live test-before-save and searchable model metadata (context window, tools, vision). |
| **Live agent traces** | `./chat` (`TraceSteps`, `Markdown`, `MessageScroller`) | Renders `libfx` streaming turns cleanly: collapsible `Thinking` blocks, inline `ToolCall` rows (`wall-tools`, `virtual-bash`, `run_experiment`), and diff/log snippets without raw JSON dumps. |
| **Typography & data density** | `Geist` + `Geist Mono`, `tabular-nums` | Aligned numeric columns for speedups, latencies, VRAM, and token counts; 36px dense rows for attempt/log tables; 16px mobile input floor preventing iOS Safari auto-zoom. |
| **Two-tier consumption** | `./parts` + `./primitives` | Screens compose Magnesium parts and stock `radix-nova` primitives using standard Tailwind layout utilities (`flex`, `grid`, `gap-*`). No regex `className` bans; boundaries guarded by workspace `exports` + `tsc` + one ~25-LOC token-parity check. |

---

## 3. Information Architecture, Screen Budget & Plugin Slot Rules

### Five Top-Level Navigation Areas

Honoring the owner's standing layout order—static operational views at top, ever-expanding campaigns below, setup at the foot—and **deleting the `rig` concept completely**:

1. **Home** *(with live `Needs You` count badge)* — Command center: auto-clearing Readiness Strip (only when incomplete), non-blocking `Needs You` queue with inline Resolve + `BesidePanel` inspection (other lanes never freeze), Active Runs with inline sparklines and concise `{workers, judge}` status, and recent promotions.
2. **Compute** — Shared `machine › device` pool (Linux CUDA, macOS Apple Silicon MLX native via `launchd`, local CPU). Displays active wall proofs (`wall-microsandbox`, `wall-os`, `wall-tools`, `wall-container`), device allocation, and a 1-command **`+ Add Machine`** (`thermite join`) modal with preflight-before-token-burn.
3. **Knowledge** — Hierarchical Collection → Run → Slot → Item tree (supporting both `campaign` and `shared` collections) beside instant PG 18 FTS + `pg_trgm` search (`< 20 ms`, `< 1 ms` empty-scope, compaction transcripts excluded by default) and a 1-click `knowledge-semantic` (`pgvector`) hybrid toggle.
4. **Campaigns** *(with `+` shortcut beside label)* — Flat campaign list (no nested campaign folders; optional group tag filter) showing live status dot, mode, and latest gain. Clicking a campaign opens its active **Run Workspace** directly; `+` opens the 1-page **New Campaign** sticky wizard with live `thermite.yaml` preview and `Dry Run` preflight.
5. **Setup** *(pinned to sidebar footer above Owner account)* — `SettingsShell` housing **Providers** (catalogue + LAN HTTP + live test), **Git** (mirror & forge credentials), **Delegation & Policy** (`PolicyGrant` profiles including 100% `autonomous_delegate` vs. structurally walled `run_worker`), **Plugins** (enable/disable & slot map), and **System** (health, backups, atomic UI updates).

### Anti-Clutter Screen Budget (Craft Rules, Not Regex Police)

- **Name the screen's decision first:** Build hierarchy around the single primary job (e.g., on Home: resolve holds and scan active runs—*not* four decorative stat tiles).
- **One home per fact:** A run's metrics live on the Run Workspace; a machine's health lives on Compute; Setup holds credentials and policies. Cross-references stay one line plus a link.
- **Charts always answer a question:** Every chart carries an explicit metric/direction title (`"Best prefill throughput vs. baseline (tok/s, higher is better)"`), real baseline reference, and interactive inspection—never decorative sparklines.
- **Simple first, then advanced:** Campaign creation exposes the 6–7 fields people actually vary (`mode`, `repo`, `build/run/check`, `score`, `device`, `git.onChampion`) alongside a live 10-line `thermite.yaml`; host-proportional defaults live in one collapsed `Advanced` disclosure stated in plain words.
- **390px mobile parity:** Sidebar collapses into a slide-over drawer; `BesidePanel` becomes a full-height sheet; `SettingsShell` becomes a horizontal pill rail; tables show deciding columns first with zero horizontal page overflow.

### Responsive Breakpoint Contract (`1440px` / `820px` / `390px`)

| Surface | Desktop (`>= 1100px`, tested at `1440px`) | Tablet (`768px–1099px`, tested at `820px`) | Mobile (`< 768px`, tested at `390px`) |
| --- | --- | --- | --- |
| **Navigation Sidebar** | Persistent `236px` warm-stone rail (`SidebarGutter` resizable) | Collapsible slide-over drawer toggled from top bar | Slide-over sheet under `52px` safe-area top bar |
| **Run Workspace (Dir A)** | Main canvas + draggable `ResizeGutter` + `BesidePanel` (`410px`) | Main canvas + toggleable `BesidePanel` sheet | Main canvas; inspector opens as full-height `Sheet` |
| **Run Workspace (Dir B)** | Centered `880px` command stream + slide-over detail drawer | Full-width stream + slide-over detail drawer | Full-width stream; drawer becomes full-height `Sheet` |
| **New Campaign** | 2-column sticky split (form left + live `thermite.yaml` right) | Single column (form above live YAML + Dry Run) | Single column; 16px input font prevents iOS zoom |
| **Knowledge & Setup** | 2-column tree/rail (`240px` / `196px`) beside active pane | 2-column compact rail or collapsible tree | Horizontal scrollable pill strip (`SettingsShell`) / stacked tree |
| **Observability Explorer** | 3-pane workbench (`224px` collapsible facet rail + stream/SQL + `ResizeGutter` + `396px` `BesidePanel`) | Facets collapse to slide-over filter drawer; `BesidePanel` opens as full-width sheet | Filter drawer + full-height `BesidePanel` sheet; 2-col KPI ribbon; secondary row tags hidden (`0px` overflow) |

### Bounded Plugin UI Slot Contract

Core renders zero chrome for uninstalled plugins (`0` DOM nodes, `0 KB` client bundle). Installed plugins share the host's single `React` + `@iammrduncan/magnesium` runtime bridge and mount **only** into six explicit slots so extensions never shove clutter into arbitrary screens:

| Slot ID | Location | Cap / Layout Rule | Reference Plugins |
| --- | --- | --- | --- |
| `nav.item` | Main sidebar above Campaigns | At most 1 `NavLine` per plugin, icon + label only | `thermy` (threads), `sql-explorer` |
| `shell.corner` | Bottom-right floating launcher | Single compact button opening contextual popover | `thermy` (copilot over current page) |
| `run.header.action` | Run header right cluster (left of primary CTA) | Compact switch or single plain action button | `live-publish` (`Live` toggle), `distill-jsonl` (`Export JSONL`) |
| `run.inspector.tab` | Run `BesidePanel` tab bar | One tab inside existing inspector; never adds a second side panel | `sql-explorer` (scoped SQL), `distill-jsonl` (trajectory preview) |
| `knowledge.toolbar` | Knowledge search bar trailing edge | Compact toggle or filter chip | `knowledge-semantic` (`Semantic HNSW` toggle), `knowledge-ingest-pdf` |
| `setup.section` | `SettingsShell` navigation rail | One tab + dedicated pane inside Setup | `web-pairing` (QR + 6-digit SAS), `live-publish`, `distill-jsonl` |

### Seven-Screen Interaction Grammar (`mockups/index.html`)

Every screen in the v1 prototype has one named operator decision, zero dead controls, and clear progressive disclosure from glance to evidence:

1. **Onboarding (Lone Frame, 3 resumable steps):** Step 1 creates the owner session cookie (replacing v0.2's `.dev/secrets` token copy, with optional `THERMITE_NO_AUTH_LOOPBACK=1` dev escape). Step 2 embeds the searchable `ProviderCatalog` supporting OAuth sign-in, API keys, and **Local / LAN HTTP** endpoints (vLLM, Ollama, llama.cpp) with a mandatory live test-before-save and model picker. Step 3 lands directly inside real work via a 1-click bundled `matmul-cpu` launch or the repository campaign wizard—never on a blank dashboard.
2. **Home (Command Center):** Drops v0.3.0's four identical stat tiles. Opens with an auto-clearing Readiness Strip (only when setup steps were skipped), followed immediately by the **non-blocking `Needs You` queue** (`Other lanes keep running`) with inline `Inspect` (`BesidePanel` diff + A/B+B/A table + consequence summary), `Approve`, and `Reject` backed by an `Undo` toast, then Active Runs showing concise `{workers, judge}` state, `machine › device`, inline sparkline/goal bar, and latest gain.
3. **Run Workspace (Direction A / B):** Houses the primary daily loop—question-led speedup step chart, champion lineage, live `libfx` `TraceSteps` over NATS `LIVE`, attempt diff & judge inspection, `git-sync` status popover (`push | pr | tag | none`), `live-publish` switch, `Open in Explorer` drill-down, `Pause`/`Resume`, first-class `Rejudge`, and live `Steer` + active `AVOID` rules.
4. **New Campaign (1-Page Sticky Wizard):** Mode selector (`Hill climb` | `Goal` | `Research`) paired with a live-synced 7–12 line `thermite.yaml` preview, `git.onChampion` selector (`push | pr | tag | none`), collapsed `Advanced` defaults stated in plain sentences, and a 1-click **Dry Run Preflight** verifying mirror, runner claim, build, and A/A baseline before launching workers.
5. **Compute (`machine › device` Pool):** Completely eliminates "rigs." Lists enrolled Linux (`systemd`), macOS Apple Silicon MLX (`launchd`), and local machines with hardware utilization, active wall proofs (`wall-microsandbox`, `wall-os`, `wall-tools`, `wall-container`), `Wall self-test` / `Drain` controls, and a **`+ Add Machine`** `ResponsiveDialog` generating the 1-command `thermite join` / `join.sh` snippet with preflight-before-token-burn.
6. **Knowledge & Setup:** Knowledge pairs the owner-mandated Collection → Run → Slot → Item tree (`campaign` + `shared` collections) with scoped PG 18 FTS + `pg_trgm` search (compaction transcripts excluded by default) and the 1-click `knowledge-semantic` (`pgvector` HNSW) toolbar switch. Setup renders inside `SettingsShell` with connected Providers, the **`PolicyGrant` Delegation Matrix** (proving 100% `autonomous_delegate` parity vs. structurally walled `run_worker`), and the **Plugin Manager** showing exact UI slot claims.
7. **Observability Explorer (`sql-explorer` + `distill-jsonl`):** Mounts via the `nav.item` plugin slot above Campaigns and directly from Run Workspace (`Open in Explorer`). Unifies NATS `EVENTS`, judge verdicts, `libfx` model calls, circuit breakers, and `git-sync` records across runs into one cross-campaign workbench.

### Observability Explorer Architecture (Screen 7)

The Explorer extends Magnesium's split-pane grammar into a 3-pane observability surface modeled after Datadog Logs and Grafana Explore without violating core nav slot caps:

- **Top Index, Query Mode & Time Controls:** Six record index tabs (`All`, `Attempts`, `Champions`, `Metrics`, `Model Calls`, `Breakers & Needs`) update their counts dynamically under active filters. A segmented mode switch toggles **`Visual Filter`** (free-text search + clickable `key:value` and `-key:value` exclude chips, click-to-invert polarity, `Clear all`) against **`SQL`** (read-only PostgreSQL 18 editor with 5 saved views—`Promoted Champions`, `Model Yield & Cache Scoreboard`, `Infra & Breaker Forensics`, `Slowest / Highest-Token Trials`, `All Raw Events`—executing live into a sortable result table with inline proportional bars for numeric columns). Time window controls (`Last 1h`, `Last 6h`, `Last 24h`, `Full Run`) sit beside a **`Live Tail`** switch (streaming incoming NATS events every `2.5s` with a static `--good` status dot, zero looping pulse) and an **`Export JSONL`** button opening a redacted fine-tuning preview modal (`distill-jsonl`).
- **Filtered Telemetry Ribbon & Stacked Timeline Histogram:** Five dynamically recomputed summary metrics (`Matched Events`, `Promoted Champions`, `Trial Duration p50/p95`, `Tokens & Avg Cache`, `Crash / Invalid Rate`) sit above a 24-bucket inline SVG stacked histogram colored strictly with Magnesium semantic tokens (`--good`, `--working`, `--needs`, `--wrong`, `--idle-bar`). Hovering a bucket opens a category breakdown tooltip; clicking any bucket slices the stream and facets to that time interval with a removable `time:` chip.
- **Left Facet Rail + Center Dense Stream + Right `BesidePanel` Inspector:** A collapsible `224px` facet sidebar (`Run`, `Kind`, `Verdict / State`, `Model`, `Machine / Device`, `Wall`) shows live checkboxes, per-group counts, and proportional micro-bars. The center stream renders rows with a `3px` state bar, `tabular-nums` `HH:MM:SS.mmm` timestamps, kind badges, inline metrics, `Compact` / `Detailed` density toggle, column sort (`Time`, `Delta`, `Tokens`, `Duration`), and `↑`/`↓` keyboard row navigation. A draggable `ResizeGutter` separates the stream from a `396px` `BesidePanel` showing NATS subject, JetStream sequence number, quick actions (`Filter #attempt`, `Open Run`, `Rejudge`), and four tabs: **`Fields`** (clickable `+` include / `-` exclude filter buttons per field), **`Metrics & Diff`** (before/after throughput, 95% CI, A/B+B/A block timings, held-out status, unified diff), **`Raw JSON`** (full JetStream envelope + Copy), and **`Context (±5)`** (surrounding events on the same run).
- **Responsive Collapse (`820px` & `390px`):** Below `960px` (and in simulated `820px` / `390px` frames), the `224px` facet rail collapses into a left slide-over filter drawer toggled from the stream toolbar (`Facets (N)`), the `BesidePanel` promotes to a full-width/full-height slide-over sheet triggered by row tap or `Inspect`, the telemetry ribbon wraps to 3 columns at `820px` and 2 columns at `390px`, secondary machine/model row tags hide at `390px`, and the Export JSONL modal docks as a bottom sheet with `0px` horizontal overflow.

### Anti-Slop Visual Craft Gates

Before any v1 screen ships in Goal 7, it must clear these concrete visual and UX gates:

- **Zero template decoration:** No blue-purple gradients, no page-wide glassmorphism, no ambient glows, no background dot grids, no eyebrow pills repeating H1s, no decorative emoji, and no infinite pulsing dots.
- **Zero invented filler:** Every figure, axis, and diff represents real domain data (or clearly labelled sample data in prototypes); empty states name the cause and single next action; empty inputs use honest placeholders.
- **Direct manipulation & keyboard parity:** Every tab, filter, disclosure, splitter (`ResizeGutter`), modal, and drawer operates via keyboard (`Tab`, `Enter`, `Escape`, splitter arrow keys) and collapses cleanly at `820px` and `390px` with zero horizontal overflow.

### Goal 1 `@iammrduncan/magnesium` Sync Blueprint

To build the 6 screens in Goal 7 without reinventing primitives, Goal 1 completes these concrete sync steps in `packages/design-system/` (per [`goal-0/design-system-sync.md`](goal-0/design-system-sync.md)):

| Subpath | Additions / Changes for Thermite v1 | Primary Screens Served |
| --- | --- | --- |
| `./theme/*` | Split `theme.css` into `base.css` + `presets/{thermite,fxbot}.css`; move `.gutter`, `[data-beside]` print, `.plugin-icon` to `base.css` | All 6 screens (light + dark) |
| `./primitives` | Sync 12 core `radix-nova` primitives from `fxbot` (`badge`, `checkbox`, `collapsible`, `context-menu`, `empty`, `input-group`, `native-select`, `popover`, `switch`, `tabs`, `textarea`, `avatar`) | Run controls, New Campaign, Compute, Setup |
| `./parts` | De-brand 8 existing parts (`brand`/`art` props); port `ResizeGutter`/`PaneGutter`, `BesideHost`/`BesidePanel`, `SettingsShell`, `ResponsiveDialog` | Home inspector, Run Dir A/B, Compute modal, Setup |
| `./providers` | Extract API-agnostic `ProviderCatalog`, `ModelCombobox`, `DeviceCodePanel` + lazy `./provider-logos` (183 MIT SVGs) | Onboarding Step 2, Setup › Providers |
| `./chat` | Sync 5 trace/chat primitives (`trace`, `message-scroller`, `message`, `bubble`, `attachment`) + `TraceSteps` & `Markdown` | Run Live Trace (Dir A/B), future `thermy` plugin |
| Checks & dev | Delete `tests/web/design-system.test.ts` CSS-ban regexes & `link.mjs`; keep root npm workspaces, Vite `lucideIcons()`, `tsc`, and ~25-LOC token-parity check | Whole UI workspace |

---

## 4. Two Layout Directions for the Run Workspace (A/B in Mockup)

Because the **Run Workspace** is where operators spend 80% of their daily loop—watching progress, inspecting candidate diffs, judging anomalies, and steering workers—the interactive prototype at [`mockups/index.html`](mockups/index.html) lets the owner toggle live between **two genuinely distinct layout directions** using identical data and actions before Goal 7 locks the implementation.

### Direction A — Split Workbench (`fxbot`-Inspired)

- **Structure:** Persistent app sidebar + **Main Canvas** (interactive SVG speedup step chart with clickable champion nodes, compact Champion Lineage & Attempts table, and Circuit-Breaker / A/A noise health strip) + **Resizable Right-Hand `BesidePanel`** separated by a live draggable `ResizeGutter`.
- **Right Inspector Tabs:** `Live Trace` (streaming `libfx` `Thinking` + `ToolCall` rows filterable by `lane-1`/`lane-2`/`judge`) · `Attempt Diff` (syntax-tinted unified diff + interleaved A/B & B/A judge breakdown + `Rejudge`/`Promote`) · `Steer & Rules` (direct message box + active scoped `AVOID` directives).
- **Interaction Grammar:** Zero tab-hopping. Clicking any champion node on the chart or any row in the attempts table loads its diff and judge timings into the right pane while the speedup curve remains visible. Dragging the gutter lets the operator widen the diff or trace for deep code review, or drag-close it for full-width chart reading.

### Direction B — Focused Stream & Command Rail

- **Structure:** Single-column workspace anchored by a **Compact Telemetry Ribbon** (headline speedup, live `{workers, judge}` pills, collapsible inline step chart, breaker status) above a **Filterable Chronological Experiment Feed** (`All`, `Champions`, `Needs review`, `In flight`, `Invalid`), with a pinned **Steer Command Bar** at the bottom.
- **Feed Cards & Drawer:** Each attempt/trial renders as a calm, scannable collapsible card showing plain-English planner summary, semantic outcome chip, proportional gain bar, 3-line key diff hunk preview, and 1-click `Inspect` / `Rejudge` / `Promote`. Clicking `Inspect` opens a **Slide-Over Detail Drawer** over the feed for full diff + trace reading without leaving the stream.
- **Interaction Grammar:** Optimized for calm narrative scanning and rapid triage ("what happened while I was away?"). Keeps the viewport visually uncluttered by default while keeping deep evidence one click away.

### Comparison Matrix

| Dimension | Direction A — Split Workbench | Direction B — Focused Stream |
| --- | --- | --- |
| **Simultaneous visibility** | Chart + attempts + live worker trace/diff visible at once | Feed + telemetry ribbon visible; full trace/diff opens in drawer |
| **Visual density & calm** | Higher density; IDE / workbench feel (`fxbot` beside-pane) | Calmer, magazine-like chronological scan; lower visual load |
| **Live-watching ergonomics** | Best—live `TraceSteps` stream beside chart continuously | Good—in-flight cards update live, full trace is one click into drawer |
| **Diff & verdict review speed** | Instant click-through across rows (master-detail in place) | Fast inline hunk preview; full diff requires opening/closing drawer |
| **13" laptop & tablet (`820px`)** | Gutter narrows or collapses inspector to toggleable sheet | Naturally comfortable at every width without resizing |
| **Mobile (`390px`) translation** | Inspector becomes full-height `Sheet` triggered by row/tab | Identical stream layout; drawer becomes full-height `Sheet` |

*(Recommendation to evaluate hands-on: **Direction A** excels as the desktop power workbench while sharing the exact `BesidePanel` + `Sheet` mechanism `fxbot` already perfected—and Direction A's right panel can start closed on narrow screens, giving a near-B feel on laptops while letting desktop operators keep Live Trace docked.)*

---

## 5. Owner Design Review Checklist (Sign-Off Gate Before Goal 1 / Goal 7 UI)

**Owner Sign-Off (2026-11-28):** Baseline mockups in [`mockups/index.html`](mockups/index.html) approved to start `v1` implementation (Goal 1). Two items stay explicitly open for Goal 7 UI implementation:

- **Observability Explorer (Screen 7):** Approved as the starting direction; expected to go through multiple revisions once live NATS/PostgreSQL run data is flowing.
- **Run Workspace Direction (A vs. B):** Final pick between Direction A (Split Workbench), Direction B (Focused Stream), or collapsible hybrid will be locked before Goal 7 builds the Run Workspace screen.

Open [`mockups/index.html`](mockups/index.html) (works directly via `file://` or local HTTP) to re-verify these checks during Goal 7 UI reviews:

- [ ] **Run Workspace Direction:** Lock **Direction A (Split Workbench)** vs. **Direction B (Focused Stream)** (or collapsible A hybrid) before Goal 7 builds the Run Workspace.
- [x] **Magnesium Palette & Contrast:** Baseline approved (2026-11-28) — warm-stone surfaces, restrained flame accent, and semantic state readability across Light / Dark.
- [x] **Onboarding Flow (Screen 1):** Baseline approved (2026-11-28) — 3-step resumable flow with Local/LAN HTTP provider test and `matmul-cpu` launch.
- [x] **Home & Non-Blocking `Needs You` (Screen 2):** Baseline approved (2026-11-28) — Readiness Strip, non-blocking `Needs You` with `BesidePanel` + Undo toast, and Active Runs.
- [x] **New Campaign DX (Screen 4):** Baseline approved (2026-11-28) — mode selector, `git.onChampion` modes, 10-line live `thermite.yaml`, and Dry Run Preflight.
- [x] **Compute & `thermite join` (Screen 5):** Baseline approved (2026-11-28) — `machine › device` pool (zero "rigs"), wall proofs, and `+ Add Machine` modal.
- [x] **Knowledge, `PolicyGrant` & Plugin Slots (Screen 6):** Baseline approved (2026-11-28) — Knowledge tree + PG 18 FTS / `knowledge-semantic`, `PolicyGrant` matrix, and bounded plugin slots.
- [ ] **Observability Explorer (Screen 7 — Iterative):** Starting baseline approved (2026-11-28); plan hands-on revision passes on facets, histogram, Visual Filter ↔ SQL, Live Tail, `BesidePanel`, and JSONL export once live run data is available.
- [x] **Responsive Breakpoints:** Baseline verified at `1440px` / `820px` / `390px` (zero overflow, drawer/sheet collapse, touch targets); re-check on real screens in Goal 7.
