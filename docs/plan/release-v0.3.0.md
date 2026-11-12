# Release plan: v0.3.0

v0.3.0 is the dashboard's refresh, on the UI system of the maintainers' [fxbot](https://github.com/iammrduncan/fxbot), and the work on the code's structure that the refresh rests on. The [roadmap](roadmap.md) shows what comes after it.

It has two guides. Each says what was found, what changes, in what order, and what the owner decided:

- [The UI refresh guide](ui-refresh-guide.md): the screens.
- [The code structure guide](code-structure-guide.md): the code behind them.

## Decided

- **2026-11-10, the owner:** v0.3.0 fixes the UI and the UX. "I want to utilize the UI/UX system I started for fxbot ... including it's v0.8.0 provider login setup system. Its way cleaner and nicer than our ux. Our ux is cluttered and clunky and hard to navigate/understand."
- **2026-11-10, the owner:** with it, a review of the code's organization: "where we have bloat or things that make it hard to debug or tech debt when adding a feature makes it easy to break something", and a plan for "how to separate things correctly".
- **2026-11-10, the owner:** planning first. The review and this plan are goal [242](goals/_completed/242-v030-review.goal).
- **2026-11-10, the owner,** on the plan's questions, took the recommended answer to each. Goal 242 lists all 22; the ones that shape the release:
  - **The dashboard becomes a web app on fxbot's own stack** (React, shadcn/ui, Tailwind CSS, Geist), a client of control's API alone. CONVENTIONS.md's rule for the dashboard changed with it.
  - **Where a question is about a look** (the navigation, a run's tabs, the words on the screens), the recommendation is what is mocked first, and the owner chooses from the mockups.
  - **Every screen works at 390 pixels wide.** Light and dark follow the operating system.
  - **Providers are added from a catalogue** that ships with each release, made from fxbot's registry. The sign-ins of v0.3.0 are a Claude subscription and ChatGPT as before, and OpenRouter.
  - **While it is built,** the new dashboard is at `/next`, and the old one takes fixes only.
  - **One entry for each action of control,** an order of folders inside the harness and inside control held by the import check, and the limit of 800 lines kept, with a warning at 700.
  - **v0.3.0 takes data from v0.2.0 alone.** A control from before it moves up through v0.2.x first.
  - **A rig's log lines reach control,** in control's own store.
  - **v0.3.0 ships when goals 242 to 257 are verified,** with whatever else is verified by then.
- **2026-11-12, the owner,** from the mockup of the whole app and [the app's build plan](app-build-plan.md):
  - **The mockup is agreed,** and the app is built from it.
  - **Goal [258](goals/258-runs-own-their-resources.goal) comes first, in v0.3.0:** a run owns its agents and its share of compute, machines are a pool, and no screen shows a rig. The screens are built once, on that model.
  - **Sign-in is a user name and a password** (goal [261](goals/261-sign-in-as-a-person.goal)), in v0.3.0.
  - **Thermy's first step is in v0.3.0,** after the screens (goal [260](goals/260-fxbot-and-thermite.goal)).
  - **The brand is drawn in dark** on the brand guide, for the owner's yes, before the app's parts are built.
  - So v0.3.0 is larger than the plan of 2026-11-10. The goals' table and the order below were rewritten to the build plan on 2026-11-12, goals 245 to 252 were rewritten to the mockup, and goals 262 to 266 were added.
- **2026-11-09, the owner:** new features are built on the branch `v0.3.0` and ship together; each fix to v0.2.0 is a version of its own ([decisions](decisions.md#releases-and-planning)).

## Still to choose

- **Goal 258's design** ([the design](goal-258-design.md)): its answers to the goal's open questions, its ten steps, and where the screens start. It waits for the owner's yes.
- **When the build starts.** The mockup and the build plan are agreed; no screen code is written until the owner says start.

## What a tester gets

- **A dashboard that reads at a glance.** Each screen says its thing's state in one sentence and has one main button. Five places in the navigation (Home, Thermy, Compute, Knowledge, Campaigns) and Setup at its foot. A run has five tabs and four buttons.
- **A brand:** warm greys, one accent, a colour for every state, in light and in dark.
- **No rig.** A run owns its agents, their models and its share of compute; machines and their devices are a pool that runs share.
- **One explorer for a run's records,** with saved views, and the records in SQL.
- **Add a provider as a catalogue,** in fxbot's shape: sign-ins first, a device code, a key checked when it is added, a custom server. Tool servers are apart from models.
- **Sign in as a person,** with a user name and a password. Tokens are for programs.
- **Search over everything.**
- **Thermy, its first step:** the scientist in the corner of every page and on its own screen, which reads the page and asks before it acts.
- **A phone works:** every screen at 390 pixels.
- **Everything the dashboard does, without it:** each action and each read has its REST route and its MCP tool.
- **Faults that say what happened:** work that did not start leaves a record, and a machine's logs can be read on control.

## Goals

The owner accepted these goals on 2026-11-10.

### The review

| Goal | Status | Depends on |
| --- | --- | --- |
| [242 · The v0.3.0 review, with the guides that set the work up](goals/_completed/242-v030-review.goal) | `VERIFIED` | — |

### The dashboard

From the mockup the owner agreed on 2026-11-12 and [the app's build plan](app-build-plan.md). Each area's goal has the same five steps: its mockup, agreed; its reads and actions, with tests there; its screens, from the app's parts; its cases in the browser check, with the rules' budget; its docs pages. The [UI refresh guide](ui-refresh-guide.md) stays as the record of the review; where it and the mockup differ on the navigation, a run's tabs or the rules for screens, the mockup holds.

| Goal | Depends on | Takes in |
| --- | --- | --- |
| [243 · The new dashboard's base](goals/243-web-app-base.goal) | 242 | [177](goals/177-dashboard-styles-in-its-stylesheet.goal); [094](goals/094-copy-id.goal) |
| [258 · A run owns its agents and its share of compute](goals/258-runs-own-their-resources.goal) | 242 | — |
| [261 · Sign in as a person](goals/261-sign-in-as-a-person.goal) | 243 | — |
| [244 · One door for each action and each read](goals/244-one-door.goal) | 242 | What is left of [029](goals/029-api-mcp-coverage.goal) |
| [246 · Home and what needs you](goals/246-home-and-decisions.goal) | 243, 244, 258, 261 | [091](goals/091-needs-you-stuck-rigs.goal) |
| [247 · Campaigns and a run](goals/247-campaigns-and-runs.goal) | 246, 258 | [090](goals/090-info-tab.goal), [072](goals/072-why-nothing-at-work.goal), [110](goals/110-judge-only-runs-show-progress.goal), [148](goals/148-keep-working-on-screens.goal); items 1, 3 and 4 of [131](goals/131-ux-fixes-found-in-use.goal) |
| [248 · Watch and Live](goals/248-live.goal) | 243, 244, 258 | — |
| [262 · The explorer](goals/262-the-explorer.goal) | 243, 244, 258 | — |
| [245 · Providers as a catalogue, and Set up Thermite](goals/245-providers-and-set-up.goal) | 243, 244 | — |
| [249 · New campaign and another run](goals/249-new-campaign.goal) | 247, 258 | [088](goals/088-new-campaign-button-progress.goal) |
| [250 · Compute](goals/250-rigs-and-machines.goal) | 243, 244, 258 | What is left of [203](goals/203-machines-page.goal); [095](goals/095-runpod-spend-on-providers.goal) |
| [251 · Knowledge](goals/251-library.goal) | 243, 244 | Item 2 of 131 |
| [252 · The rest of Setup](goals/252-usage-logs-settings.goal) | 243, 244 | [027](goals/027-logs-page.goal); [109](goals/109-exports-page-shows-what-matters.goal); item 6 of [178](goals/178-clean-up-continued.goal) |
| [263 · Search over everything](goals/263-search.goal) | 243, 244 | — |
| [264 · Plain names](goals/264-plain-names.goal) | 244 | — |
| [265 · The agents ask the owner](goals/265-agents-ask-the-owner.goal) | 246 | — |
| [266 · Thermy, Thermite's one scientist](goals/266-thermy.goal) | 243, 244, 260 | Thermy's part of [260](goals/260-fxbot-and-thermite.goal) |
| [253 · The switch](goals/253-the-switch.goal) | 245 to 252, 262 to 266 | [126](goals/126-ui-clean-up.goal); item 7 of 178 |

A goal that is taken in whole is marked as merged into the goal that takes it. Goals 131, 178 and 203 give up the items named and say so.

### The code's structure

From the [code structure guide](code-structure-guide.md). Each is `READY`.

| Goal | Depends on | Takes in |
| --- | --- | --- |
| [254 · One record for each setting, command and event kind](goals/254-one-record.goal) | 242 | — |
| [255 · One way to run an agent program](goals/255-one-way-to-run-a-program.goal) | 242 | — |
| [256 · Layers inside the parts, and files split on purpose](goals/256-layers-and-splits.goal) | 242; 244 for control's folders | Item 4 of 178 |
| [257 · Find the fault from Thermite's own records](goals/257-find-the-fault.goal) | 242 | [028](goals/028-log-store.goal); item 3 of 178 |

### The other goals of v0.3.0

The [roadmap](roadmap.md#v030) holds 38 more open goals for v0.3.0, from before this plan. The owner, 2026-11-10:

- **v0.3.0 ships when goals 242 to 258, 261 to 265 and the first step of 266 are verified,** with whatever else is verified by then (the line of 2026-11-10 named goals 242 to 257; the owner's choices of 2026-11-12 added the rest). The rest moves on at its release, as at v0.2.0.
- **A goal with a screen is built in the new dashboard,** in or after its area's goal, never on the old pages: [093](goals/093-live-shows-reasoning.goal) after 248; [097](goals/097-add-a-kit-bundle-from-the-dashboard.goal) and [120](goals/120-research-kit-prep.goal) after 249; [134](goals/134-run-resource-use.goal) after 247; [123](goals/123-budgets-made-simple.goal) after 252.
- **A goal with no screen goes on beside the refresh,** as before: the judge, rigs and images, costs, what a hill climb keeps.
- **[089](goals/089-dashboard-performance.goal), faster pages,** measures the new reads after goal 244, where it would have measured the old pages.
- **[030](goals/030-oauth-sign-in.goal), sign-in with OAuth,** stays after the switch: the app signs in as the dashboard does today.

## The order

```text
242 the review, and the owner's answers
 │
 ├── 258 runs own their resources: its design, then its ten steps ───────────┐
 │                                                                            │
 ├── 243 the base: the brand in the app, its parts, the frame ──┐             │
 ├── 261 sign in as a person ───────────────────────────────────┤             │
 ├── 244 one door, one area ahead of the screens ───────────────┤             │
 ├── 245 the provider catalogue's back end ─────────────────────┤             │
 │                                                              ▼             ▼
 │      the screens, once the app's model is true at the API (goal 258):
 │      246 Home ── 247 campaigns and a run ── 248 Watch ── 262 the explorer
 │        (a release candidate)
 │      245 Add a provider, 249 New campaign ── 250 Compute ── 251 Knowledge, 252 the rest of Setup
 │      263 search ── 264 plain names, 265 the agents ask the owner ── 266 Thermy, step 1
 │      253 the switch
 │
 ├── 254 one record
 ├── 257 find the fault ── 255 one way to run a program
 └── 256 layers and splits, each when its area is quiet
```

- **Goal 258 is first** (the owner, 2026-11-12). Beside it goes the work its model does not change: the base, the sign-in, the door, the provider catalogue's back end.
- **No screen that shows a run or a machine** is built before goal 258 makes the app's model true.
- **The screens' lane** follows the build plan's stages; goal 244 runs beside it, one area ahead.
- **Goals 255 and 257** touch the rig, which goal 258 changes: each is read against goal 258's design before it starts.
- **Goal 254** serves every lane: it makes each later change smaller.
- **The cheap guards come first** ([code structure guide, section 5](code-structure-guide.md#5-the-order-of-work)): five small checks that change no shape and stop new debt.

## While it is built

- **The old dashboard stays whole and in use** until goal 253. The new one is at `/next`. A running campaign is never without its screens.
- **The old pages take fixes only,** from the day goal 243 starts.
- **One goal at a time,** each run with `/goal`, each ending with the system working.
- **Fixes to v0.2.0** go on as their own versions, and merge into the branch `v0.3.0`.

## Before the tag

- The full `npm run check`, with the app's type check and linter.
- The browser check at three widths, light and dark, over every kind of screen.
- The 9 acceptance checks that post the old dashboard's forms today, moved to the API and passing.
- The docs build and check; every page that names a screen read against it.
- The images pinned by digest, and CI's full run on the tag.

## What v0.3.0 will not do

- **A cloud's own sign-in** (Vertex AI, Bedrock, Azure, Cloudflare), and the sign-ins that need an app registered for Thermite. Each is a goal after v0.3.0.
- **More roles than the owner** in the dashboard, before goal 030.
- **A switch of theme, a second language, a component library of our own.**
- **A second clean-up of everything.** The code's work is the six changes of the code structure guide.
