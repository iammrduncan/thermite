# Thermite v1 — Product Development Process & Anti-Slop Governance

**Status:** Active governance for Thermite v1 (2026-11-28).  
**Companion docs:** [Direction & Foundations](README.md) · [Decisions](decisions.md) · [Roadmap](roadmap.md) · [Requirements](requirements.md) · [Design Plan](design-plan.md) · [Phase Template](phases/_template.md)

This workflow pairs `fxbot`'s lightweight, single-file phase discipline with Thermite's research-integrity invariants and fast automated checks. Small fixes ship with zero ceremony; every new capability or UI surface passes six explicit gates and owner sign-off before production code starts.

---

## 1. What v0.x & `fxbot` Taught Us

| What broke in v0.x (never repeat) | What v1 adopts (from `fxbot` + cleanroom design) |
| --- | --- |
| **UI piled onto UI without IA review:** 9 nav items + hidden Settings + 2 orphan routes, ~45 page kinds, 9–11 run tabs, 11 places signalling one decision, 24 terms with multiple names, 45-control forms, prose walls on 10 pages ([UI refresh guide](../ui-refresh-guide.md)). | **5-slot core nav** (**Home, Compute, Knowledge, Campaigns, Setup**) + 6 bounded plugin slots; mandatory Gate 4 IA subtraction check + interactive HTML mockup (`1440px` & `390px`, light/dark) before code. |
| **Surface splits:** 42 of 90 dashboard form routes had no REST route; 124 store reads vs. 48 in REST/MCP; "Needs you" existed only as HTML. | **Single `core/api` `ActionDef` registry** (and `PluginApi.registerActions`): REST, policy-filtered MCP, typed client, CLI, and reference docs derive from one declaration. |
| **Serial ceremony & goal sprawl:** 270+ `.goal` files, a 35-step serial run sheet with 13 ground steps before the first run screen, and a lockstep meta-test (`run-sheet.test.ts`). | **Four proportional tracks** + single-file phase docs under `docs/plan/v1/phases/` tied to GitHub issues and `REQ-NNN` entries in [`requirements.md`](requirements.md). |
| **Check ratchets & CSS-ban churn:** `--lower` traps (`size-baseline.json`, `import-exceptions.json`, `loose-ends.json`), 700/800-line forced splits, regex `className=` bans, and 5+ min local suites. | **`< 2 min` pre-commit checks** (`typecheck`, Biome `lint`, `check:public`, Sans-I/O & contract tests, conditional `build:ui`), workspace `package.json` `exports`, and one ~25-LOC design-system boundary/token check. |
| **Hardcoded owner-only locks:** 28 `OWNER_ONLY_KINDS` and scattered `issuedBy` checks blocked full agent delegation. | **Composable `PolicyGrant`** (`viewer`, `operator`, `autonomous_delegate`, `owner`); internal `run_worker`/`run_advisor` remain structurally walled from Door and Judge. |
| **Unverified prose & brittle HTML tests:** `fxbot` shipped fast with zero automated tests; v0.x kept 105 HTML-scraping test files coupled to markup. | **Millisecond Sans-I/O + contract + conformance tests** paired with real browser inspection of changed screens at `1440px` and `390px` in light/dark. |

---

## 2. Four Proportional Change Tracks

Match rigor to blast radius. Never bury a bug fix in feature ceremony, and never smuggle a new feature through a "small change".

| Track | Scope & examples | Required artifacts | Pre-code gate | Verification bar |
| --- | --- | --- | --- | --- |
| **`Fix`** | Bug, crash, race condition, broken link, or regression (e.g., NATS reconnect leak, wrong HTTP error code, clipped mobile row). | Failing repro test first + root cause in PR/commit message. No phase doc, no mockup. | None (owner reviews diff). | Repro test passes + `< 2 min` checks + browser look if visual. |
| **`Change`** | Small UX, copy, CLI flag, or behavior tweak to an existing `REQ-NNN` capability (e.g., adding a sort option to Attempts, clarifying an error sentence). | Short issue/PR brief citing existing `REQ-NNN` + interactive mockup diff if visible. | Owner OK on brief & mockup diff. | Updated unit/contract tests + `< 2 min` checks + browser look if visual. |
| **`Feature / Plugin`** | Any new capability, plugin, `ActionDef`, `PluginApi` hook, DB table, setting, or UI surface (e.g., `distill-jsonl`, `harness-claude`, `live-publish`). | Single phase doc copied from [`phases/_template.md`](phases/_template.md) + interactive HTML mockup (if visual). | **Gate 5 hard stop:** explicit owner sign-off on phase doc + mockup + open calls. | Full Gate 6 bar: Sans-I/O / contract / conformance tests, browser inspection, docs, honest close-out. |
| **`Phase / Architecture`** | Multi-goal foundation, core reducer/bus/storage/isolation redesign, or breaking `PluginApi` change (e.g., Goal 0 spikes, Goal 6 PG 18 KB). | Phase doc + empirical spike(s) & reproducible benchmark(s) + mockup if visual. | **Gate 5 hard stop:** `/grill-me` session locking every open call in [`decisions.md`](decisions.md) before Goal 1 / M1 code. | Benchmark gates + full Gate 6 bar + CI real PG 18 / NATS / compose smoke. |

**Automatic promotion rule:** A `Fix` or `Change` promotes to **`Feature / Plugin`** immediately if the change adds any of:
- a new `ActionDef` or `PolicyGrant` capability;
- a new `PluginApi` hook or UI plugin slot;
- a new database table or core migration;
- a new top-level view, run tab, card family, or user-facing setting;
- a new runtime npm/system dependency.

---

## 3. The 6 Mandatory Gates (Anti-Slop Firewall)

Every `Feature / Plugin` and `Phase / Architecture` item passes all six gates in order. Zero production code is written before Gate 5 sign-off.

```text
Gate 1: Intake & Evidence
  → Gate 2: Research & Prior Art
    → Gate 3: Core-or-Plugin & Surface Parity
      → Gate 4: UX Discovery & IA Check (+ Interactive Mockup)
        ══[ HARD STOP — Gate 5: Owner Review & /grill-me Sign-Off ]══
          → Gate 6: Lean Build, Verification & Honest Close-Out
```

### Gate 1 — Intake & Evidence
- **Real origin required:** Link a public GitHub issue and a `REQ-NNN` entry in [`requirements.md`](requirements.md) naming the persona, user story, concrete friction observed, and verifiable acceptance criteria.
- **No speculative invention:** Ideas without an observed user problem or failing workflow stop at intake. Park them as an issue — never write a phase doc or code "just in case".

### Gate 2 — Research & Prior Art (`fxbot` Research Directive Model)
- **Inspect current code first:** Cite exact Thermite files, contracts, and limits before designing changes. Never design against memory or outdated v0.x assumptions.
- **Survey real prior art:** Check `fxbot`, `libfx`, Pi, opencode, Herdr, and relevant specs or RFCs. Never copy unlicensed code; record every adopted work or dependency in `CREDITS.md` in the same commit.
- **Measure risky unknowns before building:** Run small, reproducible spikes or benchmarks for performance, concurrency, isolation, or retrieval unknowns (exact latency, memory, recall, and failure modes). State plainly what was *not* tested.
- **Bound the work upfront:** Declare an explicit **LOC bound**, measurable success criteria, and a **"Not in this phase"** list with a cut order before writing implementation details.

### Gate 3 — Core-or-Plugin & Surface Parity Check
- **Core-or-Plugin test (default is plugin):** A capability belongs in core *only* when it satisfies at least one of [`README.md`](README.md) §1 & [`decisions.md`](decisions.md) §1's three rules:
  1. Every run needs it (e.g., Sans-I/O run lifecycle, judge verdict math, NATS bus contract).
  2. Plugins plug into it (`PluginApi`, registries, compatibility checks, UI bridge).
  3. Thermite needs it to run (install, updates, migrations, sealed secrets, Door auth).
- **Zero-cost plugin isolation:** Core never imports or names an optional plugin. An uninstalled or disabled plugin costs **0** processes, **0** timers, **0** DB tables, **0** network sockets, and **0** UI bundle bytes. Plugin data lives strictly in `plugin_<name>` schemas (`PluginApi.sql`), never core migrations.
- **Smallest hook only:** When a real plugin hits a gap, widen `PluginApi` with the smallest general hook needed — never build speculative hooks ahead of a consumer. Record any breaking `PluginApi` change in `packages/core/src/plugin/plugin-breaks.json` and raise `minThermite`.
- **Single `core/api` contract (zero surface splits):** Declare every new read or write once as an `ActionDef` in `packages/core/src/api/` (or `PluginApi.registerActions`) with Zod input/output schemas, `http`, `mcp`, `cli`, and `PolicyGrant` capability (`CoreCapability` or `<plugin>:<verb>`). REST, policy-filtered MCP (`tools/list`), typed client (`core/client.ts`), CLI, and reference docs derive from that one definition.
- **Proof & security boundary check:**
  - Door access flows strictly through `PolicyGrant` (enabling `autonomous_delegate` full end-to-end autonomy when granted).
  - Internal `run_worker` / `run_advisor` agents stay structurally walled from Door actions and Judge code ("agents propose; separate code judges").
  - New `WallPlugin` implementations pass `wall.selfTest()`; new `JudgePlugin` implementations pass A/A calibration and stamp `{ judgePlugin, judgeVersion }` on every verdict.

### Gate 4 — UX Discovery & Information Architecture Check (Anti-"UI Shoved Into UI")
Skip Gate 4 *only* for purely non-visual backend or protocol changes. Every visible change must pass the slot budget, four IA questions, and an interactive HTML mockup before code.

**Core 5-Slot Navigation & Bounded Plugin UI Slots ([`design-plan.md`](design-plan.md) §3):**

| Core Nav Slot | Owns | Plugin Attachment Rule (6 Named Slots Only) |
| --- | --- | --- |
| **Home** | Readiness strip (auto-clears), active runs overview, non-blocking `Needs you` queue. | Plugins surface actionable items as standard `need`s; never add custom widgets above active runs. (`shell.corner`: `thermy` floating launcher.) |
| **Compute** | `machine › device` pool, active wall proof badges, copyable `thermite join` flow. | `device-*` and `compute-*` plugins populate device rows and enrollment flows; zero `rig` screens or terms. |
| **Knowledge** | Scoped PG 18 FTS + `pg_trgm` collections (`campaign` & `shared`), items, and search. | `knowledge.toolbar`: compact toggle/chip (`knowledge-semantic`, `knowledge-ingest-pdf`) without new top-level tabs. |
| **Campaigns** | Flat campaign list (`+` 1-page creator) and Run Workspace (progress, champions, live trace, attempts, steer). | `run.header.action` (`live-publish`, `distill-jsonl`) and `run.inspector.tab` (`sql-explorer`, `distill-jsonl`); never adds a second side panel. |
| **Setup** | Providers (catalogue + LAN HTTP), Git credentials, `PolicyGrant` tokens, Plugins, System Update. | `setup.section`: one tab + pane (`web-pairing`, `live-publish`, `distill-jsonl`). Installed full-screen plugins (`thermy`, `sql-explorer`) may add at most 1 `nav.item` above Campaigns. |

**Four mandatory IA questions (answered in the phase doc):**
1. **Placement:** Which single core slot (`Home`, `Compute`, `Knowledge`, `Campaigns`, `Setup`) or which of the 6 named plugin slots (`nav.item`, `shell.corner`, `run.header.action`, `run.inspector.tab`, `knowledge.toolbar`, `setup.section`) owns this? Core nav never adds a 6th core slot.
2. **Clutter & subtraction:** What controls, rows, badges, or tabs does this add — and what gets **removed, merged, or collapsed** so the screen stays calm? Keep one primary action per screen, no nested cards, and no prose paragraphs above data.
3. **One home, one word:** Confirm each fact has one primary home (other screens link to it in one line) and follows [`design-plan.md`](design-plan.md)'s single vocabulary (`machine › device`, `Needs you`, `Attempt`, `Verdict`).
4. **Empty, dense, and error states:** Define what a first-time user sees, what hides when empty, and the exact actionable error sentence when a check fails.

**Interactive HTML mockup required BEFORE code:**
- Update [`mockups/index.html`](mockups/index.html) (or add a self-contained offline HTML mockup under `docs/plan/v1/mockups/`, zero external CDNs) populated with realistic open-source sample data (including long names, empty state, active state, and error state).
- Verify all four combinations interactively: **Light & Dark** using `@iammrduncan/magnesium` (`thermite.css` warm-grey + flame tokens) at **Desktop (`1440px`)** and **Mobile (`390px`)**.
- When layout trade-offs are non-obvious, mock up two concrete directions side-by-side so the owner chooses from pixels rather than prose.

### Gate 5 — Owner Review & `/grill-me` Sign-Off (Hard Stop-Line)
- **Zero production code before sign-off.** Hand the owner a short Gate 5 package containing:
  1. the phase doc (`docs/plan/v1/phases/<slug>.md`) with `Core or plugin`, `core/api` actions, LOC bound, and `Not in this phase`;
  2. the interactive HTML mockup (`1440px` & `390px`, light & dark) if visible;
  3. numbered **Open questions**, each with a recommended default.
- Run `/grill-me` for `Phase / Architecture` work and any `Feature / Plugin` with open product, UX, or policy calls.
- Record the owner's answers and sign-off date in the phase doc's **Owner Sign-Off** block (and in [`decisions.md`](decisions.md) when product-wide). Implementation starts only after this box is ticked.

### Gate 6 — Lean Build, Verification & Honest Close-Out
- **Minimal plain TypeScript:** Small single-job files, few dependencies, no classes/wrappers/speculative layers, delete unused code before adding more. Stay within the LOC bound or explain why it grew.
- **Verification matrix (keep the local loop `< 2 min`):**

| Scope | Required checks | Target |
| --- | --- | --- |
| **Every commit (local)** | `npm run typecheck`, `npm run lint` (Biome + `noFloatingPromises`), `node scripts/checks/public.mjs --untracked` (`0` hits), `npm test` (Sans-I/O reducers, judge math, API/policy contracts, conformance suites) | `< 2 min` |
| **UI / Magnesium changes** | `npm run build:ui`, ~25-LOC design-system boundary/token-parity check, and **real browser inspection** of every changed screen at `1440px` & `390px` in light and dark mode (zero console errors, failed requests, clipped controls, or horizontal overflow) | `< 2 min` + visual review |
| **Docs & attribution** | Regenerate REST/MCP/CLI docs from `core/api`, update affected `docs/_site/` pages, and update `CREDITS.md` in the same commit | Same commit |
| **CI / release gate** | Real PostgreSQL 18 (`pgvector/pgvector:0.8.x-pg18-trixie`), live NATS JetStream, compose smoke, browser check, and `gitleaks` full-history scan | CI / tag |

- **Separate evidence from judgment:** Report automated checks, browser pixel observations, and untested paths separately. Never mark a check passed unless it actually executed.
- **Honest close-out:**
  - Fill in **`## What the build changed`** honestly (plan-vs-built deltas, actual LOC vs. bound, what remains for owner **Human checks**).
  - Update the linked `REQ-NNN` status in [`requirements.md`](requirements.md).
  - Once the owner verifies the **Human checks**, move the phase doc in the same commit: `git mv docs/plan/v1/phases/<slug>.md docs/plan/v1/phases/_completed/<slug>.md` and update any links.
  - Later bug fixes to a completed phase append a dated note under `## What the build changed` rather than spawning a new phase file.

---

## 4. Hard Anti-Slop Red Lines (Automatic Reject)

Any proposal, phase doc, or PR hitting even one red line is rejected immediately — fix the change, never weaken the check:

**UX & Information Architecture**
1. **6th core top-level nav item or rogue plugin chrome:** Adding a 6th core nav slot, mounting plugin UI outside the 6 named plugin slots (`design-plan.md` §3), or rendering chrome for an uninstalled plugin.
2. **UI shoved into UI:** Adding tabs, cards, banners, or multi-sentence "How it works" prose walls to an existing screen without Gate 4 subtraction and interactive mockup sign-off.
3. **Unbacked settings or knobs:** Adding a setting, env var, or mode without a linked `REQ-NNN` and real user story.
4. **Surface-parity split:** Shipping a UI form/action without a `core/api` `ActionDef`, or an API/MCP/CLI action that bypasses the shared door and `PolicyGrant` evaluator.
5. **Bespoke styling outside Magnesium:** Inventing one-off colors, tokens, or duplicated components in `packages/ui` instead of `@iammrduncan/magnesium` (standard Tailwind layout utilities like `flex`, `grid`, and `gap-*` remain allowed).

**Architecture & Security**
6. **Hardcoded owner-only locks or broken judge walls:** Reintroducing `OWNER_ONLY_KINDS` / hardcoded human-only checks outside `PolicyGrant`, or letting `run_worker`/`run_advisor` reach Door or Judge actions.
7. **Core bloat or plugin coupling:** Putting an optional feature in core, importing/naming an optional plugin from core, or adding plugin tables to core migrations.
8. **Resurrected v0.x debt:** Reintroducing `rig` concepts, hidden default research turn/trial/time/spend caps, or `--lower` baseline ratchets / forced line-count file-split traps.
9. **Unjustified dependencies:** Adding a runtime package without explaining why Node/Web/Postgres built-ins cannot do it, checking its license (never AGPLv3 in core), and adding a `CREDITS.md` entry.

**Code, Tests & Prose**
10. **Fake tests & hidden failures:** Committing tautological assertions that cannot fail, `.only`/`.skip`/`todo` tests, empty/swallowed `catch` blocks, `throw new Error("Not implemented")` stubs, or `@ts-expect-error`/`biome-ignore` suppressions without an inline reason.
11. **AI prose walls & unverified claims:** Shipping vague claims ("robust, scalable, seamless") without measurable referents, or reporting checks as green when they did not run.
12. **Public-repo leakage:** Any private hostname, IP/MAC address, internal domain, secret/vault name, personal path, or deployment map in tracked files or commit messages (`public.mjs` or `gitleaks` hit).

---

## 5. Phase Lifecycle & Running a Phase

```text
docs/plan/v1/
├── requirements.md          # Living REQ-NNN ledger (intake & status)
├── decisions.md             # Product-wide locked decisions
├── roadmap.md               # Waves & Goals 1–14
├── process.md               # This workflow & anti-slop governance
├── design-plan.md           # IA rules & Magnesium visual direction
├── mockups/index.html       # Interactive offline HTML mockups (1440px/390px, light/dark)
└── phases/
    ├── _template.md         # Copy for every new Feature / Plugin or Phase
    ├── <slug>.md            # Active phase (Draft → In Review → Approved → Building)
    └── _completed/<slug>.md # Verified phase with honest "What the build changed"
```

**Schema & compatibility rules during execution:**
- Every schema change is a new numbered SQL migration (`plugin_<name>` for plugins; core migrations only for core). Never edit or delete a migration that has shipped.
- Breaking `PluginApi` changes require a `packages/core/src/plugin/plugin-breaks.json` entry and changelog upgrade note; additive hooks require raising `minThermite` on plugins that use them.

**Day-to-day execution loop:**
1. Capture real user need in a GitHub issue + `REQ-NNN` in [`requirements.md`](requirements.md).
2. Copy `phases/_template.md` → `phases/<slug>.md` and complete Gates 1–4 (including interactive mockup if visual).
3. Run `/grill-me` (or direct review) with the owner to close Open Questions and sign off Gate 5.
4. Execute from the signed phase doc:
   ```text
   /goal Complete docs/plan/v1/phases/<slug>.md, reread the doc before wrapping up
   ```
5. Complete owner **Human checks**, record **What the build changed**, update `requirements.md`, and `git mv` the phase doc to `phases/_completed/<slug>.md`.
