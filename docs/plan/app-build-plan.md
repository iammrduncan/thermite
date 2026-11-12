# The app's build plan

**Status:** agreed by the owner on 2026-11-12, with the answers in section 7. No screen code is written until the owner says start.

The owner agreed the mockup of the whole app on 2026-11-12 (goal [243](goals/243-web-app-base.goal)). This plan says how the app in `web/` is built from it: what the mockup needs that Thermite does not have, the choices that set the order, the order, and what changes in the plans of [v0.3.0](release-v0.3.0.md) when the owner says yes.

## 1. What is agreed

- **The mockup:** 102 boards on one design canvas, kept with the maintainers' notes. 90 are the app (every screen, and beside most screens a board of its other states); 12 are the brand guide.
- **The rules of a screen:** one sentence that says the thing's state; one main button; four type sizes; a budget of words, blocks and controls for a first view; nothing open on arrival; confirm only what is lost; a form of at most seven fields, then one advanced section. A program checks every board against them, and all pass.
- **The brand:** warm greys, one accent (the flame), a colour for every state, an icon on every line of the sidebar, numbers as tiles with their history, the knowledge base as a tree, one full explorer for a run's records.
- **The shape of the app:** Home, Thermy, Compute, Knowledge, then Campaigns; Setup at the foot. A run has five tabs (Summary, Explore, Usage, Results, Setup) and four buttons (Watch, Pause, More, Tell the agents).
- **Decisions the mockup carries,** each in its goal: no rig on any screen, and machine › device ([258](goals/258-runs-own-their-resources.goal)); sign-in with a user name and a password ([261](goals/261-sign-in-as-a-person.goal)); provider set-up as fxbot has it, with tool servers apart ([245](goals/245-providers-and-set-up.goal)); Thermy, the one scientist ([260](goals/260-fxbot-and-thermite.goal)).

## 2. What the mockup needs

Two readers went through every board against control's code. Each thing a board shows or does is one of four kinds. The sizes are a first estimate from that reading: S is under a day, M a few days, L a week or more.

| Kind | What it means | How much of the app |
| --- | --- | --- |
| **There** | Control has the data and a REST route. | Most of Home, a run's Summary, Queue, Notes, Prompts, Usage, Steer, Results, the goal and research screens, Knowledge with its tree, tool servers, Storage, System, rented machines. |
| **Needs a read** | The data is there; no route gives it in the screen's shape, or only an old page's form does. | The list of campaigns and one campaign; a run's numbers with their history; a need with its choices; the explorer; every event and try of a whole run; adding a machine; clusters; Git logins; the list of providers; all exports; plan use on Spend. |
| **New behaviour** | Control or the harness must do something new. | Listed in section 5. |
| **Rests on a proposed goal** | Goals 258, 260 and 261. | Compute as a pool and a run's own devices; Thermy; the sign-in. |

Three reads are shared by many screens and are built once:

1. **The explorer's query** (L): one read for the seven kinds of record, with a filter, a time, facet counts, each field's count of values, the band over time, and rows as you scroll. Today's read of a run is made for agents and cuts long lists; events, tries and prompts must come from the whole run.
2. **A run's numbers with their history, the count of each outcome, and the gain by idea** (M).
3. **A need with its choices and what each does** (M), for Home, a run's Summary and Watch.

The words for an outcome, a state and an event are in page code today. They move to where the app and the API both read them (goal [244](goals/244-one-door.goal), item 7).

## 3. Three choices that set the order

### The rig

The mockup has no rig. Goal 258, which removes it, is proposed for a later version and is large: the agents' loops move into the control plane, a machine runs one light runner, and the store changes.

| Option | What it means | Cost |
| --- | --- | --- |
| A. The screens first, on today's model (the plan's recommendation) | The app says machine, device and run. Control gives it those words: a machine is a rig's machine, its devices are the rig's runners, a run's Setup changes its rig's settings, and "any free device that fits" picks a free rig. The app shows only what is true today: one run on a machine at a time, and a run needs a machine. Goal 258 then changes what is under screens that stay the same. | One mapping read for Compute and a run's Setup (M). Three things of the mockup wait for goal 258: a machine that several runs share, a run with no machine, and devices that are not GPUs or CPUs. |
| **B. Goal 258 first, then the screens (the owner's choice)** | The screens are built once, on the model they were drawn for. | Nothing to test for a long time; the old dashboard stays in use through all of it. |
| C. Screens with rigs | Redraw Compute and a run's Setup. | Against the agreed mockup. |

The owner chose B. Goal 258 is accepted into v0.3.0 and comes before every screen that shows a run or a machine. Its first step is its written design, for the owner's yes.

### Thermy

Thermy is new work on three sides: an agent loop in control, threads that last, and a repo. The owner decided that it runs inside Thermite on fxbot's agent core.

**Recommended:** Thermy is built after the screens, in three steps, and is the first use of fxbot's agent core in Thermite. That proves the library on one agent in control before a run's agents move to it.

1. **Asks first, on every page:** the corner, the chat over a page that reads the page, its own screen with threads, the app's tools. It reads and drafts in the thread; whatever starts work is a card with a button.
2. **Its repo:** Git access, the set-up skill for a blank repo, drafts of campaigns and kits as files on a branch.
3. **On its own:** a switch for each kind of work, a spend limit, a line for everything it did.

The owner chose step 1 for v0.3.0, after the screens. Until Thermy is there, the app shows no corner and no Thermy line.

### Dark

v0.3.0's plan says light and dark follow the system. The brand guide is drawn in light alone. The owner chose one more board on the brand guide, the brand in dark, agreed before the app's parts are built.

## 4. The order

Goal 258 is first (the owner's choice). The stages below follow it; each ends with screens the owner can use at `/next`, on a real control. Goal 244 runs beside the stages, one ahead, as planned: it gives each stage its reads and moves each action out of page code.

Beside goal 258, the plan proposes the work that its model does not change: the brand in the app (stage 0, with the dark board first), the sign-in (stage 1's first half) and the provider catalogue's back end. The owner has not yet said whether these run beside goal 258 or wait for it.

| Stage | What is built | Goals |
| --- | --- | --- |
| **Before the screens: runs own their resources** | The written design, agreed; then the control plane's services, the store, the light runner and the pool, in parts. A run's records can be asked in SQL. | 258 |
| **0. The brand in the app** | The theme (the greys, the flame, the state colours, dark). The parts every screen uses, and no others: the frame with its sidebar and a run's top, state chips, changes with arrows, stat tiles with a history, rows, tables, facts, the need card, the tree, the split of a tool, the explorer's fields and results, forms and their "i", dialogs, Undo. The rules' budgets join the browser check, so a screen that breaks one fails. The three screens goal 243 built are rebuilt from their boards. | 243 |
| **1. Sign in, and Home** | A user name and a password; tokens made and removed on a screen. Home with its needs, each with its choices. One attempt's page. | 261, 246 |
| **2. Campaigns and a run** | The list of campaigns, a campaign, its Setup. A run's Summary, Results with its downloads, Steer, Watch, a run's Setup, the More menu. Goal runs and research runs. | 247, 248 |
| **3. Explore** | The explorer for every kind of record, with saved views. A run's Usage. | a new goal |
| | **A release candidate:** the daily work is in the app. | |
| **4. Set up, and a new campaign** | Add a provider and a provider's card, the Claude Code sign-in, Models, Agents, Tools, Access. New campaign, another run, a campaign from a best change. | 245, 249 |
| **5. Compute** | Machines and their devices, a machine, its checks and logs, add a machine, rented machines, a cluster: under the option chosen above. | 250 |
| **6. Knowledge, and the rest of Setup** | Knowledge with its tree, search, an item, its settings. Spend, Storage, Exports, Backup, Logs, System. | 251, 252 |
| **7. Search** | ⌘K over runs, campaigns, machines, settings, changes and notes. | a new goal |
| **8. Thermy, step 1** | The corner, the chat over a page, its own screen with threads, the app's tools; it asks first. | 260 |
| **9. The switch** | The app moves to `/`, and the old page code goes. | 253 |

Why this order: within the screens, what the owner looks at every day comes first, so the app is useful after stage 3 and is tested in real use while the rest is built. With goal 258 first, that point comes later than it would have on today's model: the owner took that cost.

### How a screen is built

1. **Its board is its specification:** the screen as it loads, its other states on the board beside it, and the board's note (what is real, what is new, what is an example).
2. **Its reads and actions,** in control, with their tests (goal 244's door).
3. **The screen,** from the app's parts alone. A part that is missing is added to the parts, and to the brand guide first when it changes the look.
4. **Its cases in the browser check:** the screen at 1,440, 820 and 390 pixels, in light and in dark, with the rules' budget for its kind. Its screenshots are read against its board.
5. **Its docs pages,** in the same commits.

A screen that needs behaviour Thermite does not have yet shows what is true today, and gains the rest when its goal lands.

## 5. New behaviour

Each line is work beyond a screen and its reads. "With" names the goal it would join; "a new goal" means one is written on the owner's yes.

| What | Touches | Size | With | In v0.3.0? |
| --- | --- | --- | --- | --- |
| A run's result has a status: Complete, Failed, Stopped | Control | M | 247 | Yes |
| A reason is optional when a run is paused or closed, an experiment dropped, a change withdrawn | Core, the harness's record | M | 247 | Yes |
| "Files the agents may change" has a default, the whole project; a win's least gain and the digest have their fields | Core, the builder | S | 249 | Yes |
| A campaign's notes and kit are changed as one new version | Control | M | 247 | Yes |
| A plain name from the planner, for an idea and a change | The planner's prompt, an event, control | M | a new goal | Yes; until then a screen shows the agents' own name |
| Saved views in Explore | Control | S to M | the explorer's goal | Yes |
| Push now, for a run's best changes | A command, the supervisor | M | 247 | Yes |
| Undo, for a dropped experiment, a kept message, a rule, an answered need | The harness, control | M | each area's goal | Where it is cheap; the rest later |
| The agents ask the owner a question, as a need; the owner answers a note | The harness, control | M | a new goal | Yes (the owner) |
| Downloads keyed by run; a campaign's results as one file | Control | M | 247 | Yes |
| The provider catalogue, a key checked when it is added, device-code sign-ins | Control, core | L | 245 | Yes |
| A Claude plan through Claude Code's long-lived sign-in | Control, perhaps the harness image | M | 245 | Yes |
| A model checked with no machine; a provider in use removed | Control | M | 245 | Yes (the owner) |
| Search over everything | Control | M | a new goal | Yes |
| Defaults for a new run's agents, kept on control | Control | M | 250 | Yes |
| The owner uploads a file to Knowledge; a note on a folder; short names for items | Control, the agents' prompts | M | 251 | Later |
| The time and result of the last backup | The command line, control | S | 252 | Yes |
| A run's records asked in SQL | A new store of a run's records | L | 258 | Yes, with goal 258 |
| Machines as a pool, a run's own devices, a run with no machine | Control, the harness, the runner | L | 258 | Yes, first (the owner) |
| Thermy | Control, fxbot's agent core | L | 260 | Step 1 (the owner); steps 2 and 3 later |

## 6. What changes in the plans

- **The release plan of v0.3.0:** what a tester gets, the goals' table and the order follow this plan.
- **The UI refresh guide:** its sections on the navigation, a run's tabs and the rules for screens give way to the agreed mockup and its rules. The rest stays as the record of the review.
- **Goals 245 to 252:** each goal's "What" is rewritten to the mockup's boards for its area, with the same five steps. Goal 250 is "Compute" in place of "Rigs and machines"; goal 251 is Knowledge, with exports under Setup; goal 252 is Spend, Storage, Logs and System.
- **New goals,** each written and put on the roadmap: the explorer, search, plain names from the planner, the agents' question as a need.
- **Goal 258** is accepted into v0.3.0, first, and **goal 261** is accepted into v0.3.0 (both done on 2026-11-12). **Goal 260** is split: the harness on fxbot's agent core stays one goal, and Thermy becomes its own, in three steps.
- **The settled decisions:** the app's words (machine, device, run; no rig on a screen), the brand, and Thermy.

## 7. What the owner decided (2026-11-12)

1. **The rig:** "Goal 258 first". The back end is rebuilt with no rig, and the screens are built once on that model.
2. **Sign-in as a person** (goal 261): into v0.3.0.
3. **Thermy's first step:** in v0.3.0, after the screens.
4. **Dark:** a dark board on the brand guide first.
5. **The two rows that were the owner's to place** (the agents' question as a need; a model checked with no machine): both in v0.3.0.
6. **The rest of the plan:** agreed as written.

Still open: whether the work that goal 258's model does not change (the brand in the app, the sign-in, the provider catalogue's back end) runs beside goal 258 or waits for it; and goal 258's own design, which is written next for the owner's yes.
