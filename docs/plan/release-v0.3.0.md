# Release plan: v0.3.0

v0.3.0 is the dashboard's refresh, on the UI system of the maintainers' [fxbot](https://github.com/iammrduncan/fxbot), and the work on the code's structure that the refresh rests on. The [roadmap](roadmap.md) shows what comes after it.

It has two guides. Each says what was found, what changes, in what order, and what the owner has to decide:

- [The UI refresh guide](ui-refresh-guide.md): the screens.
- [The code structure guide](code-structure-guide.md): the code behind them.

## Decided

- **2026-11-10, the owner:** v0.3.0 fixes the UI and the UX. "I want to utilize the UI/UX system I started for fxbot ... including it's v0.8.0 provider login setup system. Its way cleaner and nicer than our ux. Our ux is cluttered and clunky and hard to navigate/understand."
- **2026-11-10, the owner:** with it, a review of the code's organization: "where we have bloat or things that make it hard to debug or tech debt when adding a feature makes it easy to break something", and a plan for "how to separate things correctly".
- **2026-11-10, the owner:** planning first. The review and this plan are goal [242](goals/242-v030-review.goal); nothing is built until the owner has answered its questions.
- **2026-11-09, the owner:** new features are built on the branch `v0.3.0` and ship together; each fix to v0.2.0 is a version of its own ([decisions](decisions.md#releases-and-planning)).

## To decide

Nothing below is settled. The owner's answers go into goal 242, and into [decisions.md](decisions.md) where they shape the product.

- **14 questions on the screens** ([UI refresh guide, section 11](ui-refresh-guide.md#11-the-owners-questions)). The first decides the rest: the dashboard as a web app on fxbot's own stack, or fxbot's look on today's pages.
- **7 questions on the code** ([code structure guide, section 7](code-structure-guide.md#7-the-owners-questions)).
- **The scope of v0.3.0** ([below](#the-other-goals-of-v030)).

## What a tester gets

- **A dashboard that reads at a glance.** 7 places in its navigation, where there are 9 and a Settings icon. What needs you is one list. A run's page has 6 tabs, where it has 9 to 11. No page opens with a paragraph.
- **One place for each thing:** one home for cost, one for results, one log, one page for a decision.
- **Add provider as a catalogue:** sign-ins first, then each gateway with the steps at its own key page. A key is checked when it is added, and a model reaches a rig's agents in the same flow.
- **Set up Thermite,** on a new control: a model, a rig, the model check, the first campaign.
- **A phone works:** every screen at 390 pixels, so a decision can be made away from the desk. Light and dark follow the system.
- **Everything the dashboard does, without it:** each action and each read has its REST route and its MCP tool.
- **Faults that say what happened:** work that did not start leaves a record, and a rig's logs can be read on control.

## Goals

Every goal is `PROPOSED` until the owner accepts it.

### The review

| Goal | Status | Depends on |
| --- | --- | --- |
| [242 · The v0.3.0 review, with the guides that set the work up](goals/242-v030-review.goal) | `IN_PROGRESS` | — |

### The dashboard

From the [UI refresh guide](ui-refresh-guide.md). Each area's goal has the same five steps: its mockups, approved; its API, with tests there; its screens; its cases in the browser check; its docs pages.

| Goal | Depends on | Takes in |
| --- | --- | --- |
| [243 · The new dashboard's base](goals/243-web-app-base.goal) | 242 | [177](goals/177-dashboard-styles-in-its-stylesheet.goal); [094](goals/094-copy-id.goal) |
| [244 · One door for each action and each read](goals/244-one-door.goal) | 242 | What is left of [029](goals/029-api-mcp-coverage.goal) |
| [245 · Providers as a catalogue, and Set up Thermite](goals/245-providers-and-set-up.goal) | 243, 244 | — |
| [246 · Home and decisions](goals/246-home-and-decisions.goal) | 243, 244 | [091](goals/091-needs-you-stuck-rigs.goal) |
| [247 · Campaigns and runs](goals/247-campaigns-and-runs.goal) | 246 | [090](goals/090-info-tab.goal), [072](goals/072-why-nothing-at-work.goal), [110](goals/110-judge-only-runs-show-progress.goal), [148](goals/148-keep-working-on-screens.goal); items 1, 3 and 4 of [131](goals/131-ux-fixes-found-in-use.goal) |
| [248 · Live](goals/248-live.goal) | 243, 244 | — |
| [249 · New campaign and Start a run](goals/249-new-campaign.goal) | 247 | [088](goals/088-new-campaign-button-progress.goal) |
| [250 · Rigs and machines](goals/250-rigs-and-machines.goal) | 243, 244 | What is left of [203](goals/203-machines-page.goal); [095](goals/095-runpod-spend-on-providers.goal) |
| [251 · Library](goals/251-library.goal) | 243, 244 | [109](goals/109-exports-page-shows-what-matters.goal); item 2 of 131 |
| [252 · Usage, Logs and the rest of Settings](goals/252-usage-logs-settings.goal) | 243, 244 | [027](goals/027-logs-page.goal); item 6 of [178](goals/178-clean-up-continued.goal) |
| [253 · The switch](goals/253-the-switch.goal) | 245 to 252 | [126](goals/126-ui-clean-up.goal); item 7 of 178 |

"Takes in" is a proposal: when the owner accepts a goal here, each goal it takes in is marked as merged into it.

### The code's structure

From the [code structure guide](code-structure-guide.md).

| Goal | Depends on | Takes in |
| --- | --- | --- |
| [254 · One record for each setting, command and event kind](goals/254-one-record.goal) | 242 | — |
| [255 · One way to run an agent program](goals/255-one-way-to-run-a-program.goal) | 242 | — |
| [256 · Layers inside the parts, and files split on purpose](goals/256-layers-and-splits.goal) | 242; 244 for control's folders | Item 4 of 178 |
| [257 · Find the fault from Thermite's own records](goals/257-find-the-fault.goal) | 242 | [028](goals/028-log-store.goal); item 3 of 178 |

### The other goals of v0.3.0

The [roadmap](roadmap.md#v030) holds about 50 more goals for v0.3.0, from before this plan. A proposal for them:

- **v0.3.0 ships when goals 242 to 257 are verified,** with whatever else is verified by then. The rest moves on at its release, as at v0.2.0.
- **A goal with a screen is built in the new dashboard,** in or after its area's goal, never on the old pages: [093](goals/093-live-shows-reasoning.goal) after 248; [097](goals/097-add-a-kit-bundle-from-the-dashboard.goal) and [120](goals/120-research-kit-prep.goal) after 249; [134](goals/134-run-resource-use.goal) after 247; [123](goals/123-budgets-made-simple.goal) after 252.
- **A goal with no screen goes on beside the refresh,** as before: the judge, rigs and images, costs, what a hill climb keeps.
- **[089](goals/089-dashboard-performance.goal), faster pages,** measures the new reads after goal 244, where it would have measured the old pages.
- **[030](goals/030-oauth-sign-in.goal), sign-in with OAuth,** stays after the switch: the app signs in as the dashboard does today.

## The order

```text
242 the review, and the owner's answers
 │
 ├── 243 the base ────┬── 245 providers and set-up
 │                    ├── 246 home ── 247 campaigns and runs ── 249 new campaign
 ├── 244 one door ────┤   248 live
 │                    ├── 250 rigs and machines
 │                    └── 251 library ── 252 usage, logs, settings ── 253 the switch
 │
 ├── 254 one record
 ├── 257 find the fault ── 255 one way to run a program
 └── 256 layers and splits, each when its area is quiet
```

- **The dashboard's lane** is 243 to 253. Goal 244 runs beside it, one area ahead.
- **The rig's lane** is 257, then 255. It touches no screen, so it can run at the same time.
- **Goal 254** serves both lanes: it makes each later change smaller.
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
