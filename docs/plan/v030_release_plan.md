# v0.3.0, step by step

**Status:** written on 2026-11-12 for the owner, who asked for it: one command for each step, and what the owner looks at between them. The build started on 2026-11-12, when the owner ran step 1. Where each step stands is in the column **State** of [The whole way](#the-whole-way).

[The release plan](release-v0.3.0.md) says what v0.3.0 is and why. [The app's build plan](app-build-plan.md) and [goal 258's design](goal-258-design.md) say how it is built. This page is the run sheet: 35 steps in one line, one goal at a time, from today to the tag.

## How each step goes

1. **You run the step's command.** It names a goal's file.
2. **I ask you the step's questions first,** where the goal leaves a choice that is yours ("I ask you first", below). The other open questions I settle as I build, and write each answer in the goal's Decisions.
3. **I build until the goal is complete:** every "Done when" item that a check can prove has its evidence, the docs pages match the code, the change is pushed, and the test deployment runs it. The test deployment is a second, local-only Thermite on your own machine (the owner's decision, 2026-11-13: the live deployment is not touched with v0.3.0 until it is where the owner wants it). The live deployment is not updated with v0.3.0 until you say so.
4. **I read it all again before I say done** (the command's last sentence): the goal's every item against its evidence, the whole diff, the changed docs pages, and for a screen its screenshots against its board.
5. **I hand it back** in the goal's Progress: what was built, which checks ran and which did not, the answers I took, and what is left for you.
6. **We go hands on together.** You go through the step's "Look at" list on a real control: the local-only one, wherever a step below says "your control", until you say the live one takes v0.3.0. What you want changed, I change in place. The items that say "the owner does ..." are ticked here.
7. **You say done.** The goal is `VERIFIED` and moves to `goals/_completed/`. Then the next command.

A step that changes a running deployment in a way that is hard to undo, or that spends money, waits for your yes at that point. The steps that do are marked.

### The state of each step

The table [The whole way](#the-whole-way) says where every step stands, in its column **State**. It is the one place to read what is done and what comes next (the owner's decision, 2026-11-14).

| State | It means |
| --- | --- |
| Not started | Nobody has run the step's command |
| Building | The step's work has started |
| Built, waits for your look | Every item a check can prove is done, and the hands-on is open |
| Done | The owner said done |

- **It changes with the goal, in the same commit.** Whoever changes a step's goal (its status, its last "Done when" item, its move to `goals/_completed/`) changes the step's state here in that commit, with the date. The goal keeps the detail: what was built, the checks and the decisions.
- **A session reads it first.** A session that starts work on v0.3.0 reads this column before it builds, and says so when the column and a goal disagree.
- **A test holds it** (`tests/docs/run-sheet.test.ts`): every step has one of the four states; a step that names a whole goal is **Done** exactly when that goal is `VERIFIED` in `goals/_completed/`; and a step that is **Building** or **Built** names a goal that is `IN_PROGRESS`. A step that is a part of a goal is held by the first rule only.

### What to look at after every step

- **The goal's Progress and Decisions:** what I built, what I did not check, and each answer I took to an open question. An answer you do not like is cheapest to change here.
- **For a screen:** the screen on a real control beside its board on the mockup canvas, at a desk, at a tablet's width and on a phone, in light and in dark, and each of its other states from the board beside it.
- **The browser check's screenshots,** side by side in `.dev/acceptance/browser/app.html` after `npm run acceptance:browser`.
- **The docs pages** the step changed.

Until step 33 the new dashboard is at `/next` and the old one stays in use at `/ui`.

### The commands

Most commands name a whole goal. A few name a part of one, by its items; that goal stays open until its last part. Three steps have no goal of their own and name this page or the release plan.

## The whole way

| Step | What is built | Goal | What you can see after | State |
| --- | --- | --- | --- | --- |
| **A. The ground** | | | | |
| 1 | The cheap guards | parts of 254 and 256 | Five new checks | Built, waits for your look, 2026-11-12 |
| 2 | Control's store behind an interface | 267 | Nothing: that is the test | Built, waits for your look, 2026-11-13 |
| 3 | The brand in the app, and the design system | 243 | The app in the brand, and every part on the design system's site at `/design` | Building, 2026-11-14 |
| 4 | PostgreSQL beside SQLite | 268 | A trial control on PostgreSQL | Not started |
| 5 | The knowledge base's search on PostgreSQL | 269 | What changed in the order of results | Not started |
| 6 | The move to PostgreSQL | 270 | Your control on PostgreSQL | Not started |
| 7 | Sign in as a person | 261 | A user name and a password | Not started |
| 8 | One door for each action | part of 244 | The list of everything the API does | Not started |
| 9 | One record for each setting, command and event | 254 | Reference pages made from the code | Not started |
| 10 | A run's tables | 271 | A select over a real run | Not started |
| 11 | The door apart from the record | 272 | A restart of the dashboard stops nothing | Not started |
| 12 | A run owns its agents | 273 | A model changed on a run at work | Not started |
| 13 | Machines as a pool | 274 | Your machines and devices at the API, with no rig | Not started |
| **B. The daily work** | | | | |
| 14 | Home and what needs you | 246 | Home, and an attempt's page | Not started |
| 15 | Campaigns and a run | 247 | A run's five tabs, on real runs | Not started |
| 16 | Watch and Live | 248 | A run's lines and a worker's terminal | Not started |
| 17 | The explorer | 262 | Explore on every kind of record, and SQL | Not started |
| 18 | A release candidate | this page | The daily work in the app, for testers | Not started |
| **C. The rest of the app** | | | | |
| 19 | Providers, and Set up Thermite | 245 | Add a provider as a catalogue | Not started |
| 20 | New campaign | 249 | A campaign started from the new form | Not started |
| 21 | Compute | 250 | Machines and devices as a pool | Not started |
| 22 | Knowledge | 251 | The knowledge base as a tree | Not started |
| 23 | The rest of Setup | 252 | Spend, Storage, Logs and System | Not started |
| 24 | Search | 263 | ⌘K over everything | Not started |
| 25 | Plain names | 264 | A plain name on each idea and change | Not started |
| 26 | The agents ask the owner | 265 | An agent's question as a need | Not started |
| 27 | The door, closed | 244 | A campaign run over MCP alone | Not started |
| **D. The agents move** | | | | |
| 28 | Find the fault | 257 | A machine's logs searched on control | Not started |
| 29 | One way to run an agent program | 255 | Nothing: that is the test | Not started |
| 30 | Layers and splits | 256 | Nothing: that is the test | Not started |
| 31 | The agents in the control plane | 275, in parts | A run with no machine; two runs on one machine | Not started |
| 32 | Thermy, its first step | step 1 of 266 | Thermy in the corner of every screen | Not started |
| **E. The end** | | | | |
| 33 | The switch | 253 | The new dashboard alone, at `/` | Not started |
| 34 | The rig goes | 276 | No rig anywhere | Not started |
| 35 | The release | the release plan | v0.3.0 | Not started |

The sizes below are the plans' first estimates of a person's time: S is under a day, M a few days, L a week or more, XL several weeks.

## A. The ground

Thirteen steps before the first screen that shows a run. Two of them show on a screen (3 and 7); the others are checked at the API, or by what does not change. This is the cost of building the screens once, on the model they were drawn for (the owner, 2026-11-12).

### 1 · The cheap guards (parts of goals 254 and 256) · S

```text
/goal complete items 1 to 3 of docs/plan/goals/254-one-record.goal and items 1 and 2 of docs/plan/goals/256-layers-and-splits.goal. rereview/reread before wrapping up
```

Five checks that change no shape and stop new debt while the large steps run: the store's version as one constant, a test that walks every kind of event, a check of the docs' MCP page, an order of folders held by the import check, and a warning from the size check at 700 lines.

**Look at:**

- The two orders of folders in CONVENTIONS.md ("The order inside a part"), and where a folder stands wrongly. `npm run check:imports -- --list` gives today's imports against them, by pair of folders: 22 in the harness and 51 in control.
- The files over 700 lines: `npm run check:sizes -- --list` marks each `due`. There are 37. Both lists are the debt as it stands; each shrinks only by a move or a split.
- The lists of event kinds in `tests/control/views/event-kinds.test.ts`: 21 kinds that nothing in control reads, so no page says them in words. Some look like things you would want to be told.
- Each check failing on a made-up breach, in the two goals' "Done when".

### 2 · Control's store behind an interface (goal 267, step 1 of goal 258) · XL

```text
/goal complete docs/plan/goals/267-store-behind-an-interface.goal. rereview/reread before wrapping up
```

Every call into control's store can wait for its answer. Still SQLite, the same file, the same schema. About 170 files and most of control's tests change, and nothing a person or a program sees does.

**Look at:**

- **The local-only Thermite on this step's code, in real use:** the old dashboard and `/next` as before, a campaign started and at work, a backup taken.
- The count of tests, which may not fall, and the 36 places that hold a transaction outside the store, each with its test in `tests/control/together/`.
- How it was done (in one piece, by a script), and the short list of what a person could notice, in the goal's Decisions.

Nothing here is a matter of taste. The hands-on is short unless something changed.

### 3 · The brand in the app, and the design system (goal 243) · M

```text
/goal complete docs/plan/goals/243-web-app-base.goal. rereview/reread before wrapping up
```

The agreed brand, in code: the theme in light and in dark, the parts every screen is made of, the frame with its sidebar and a run's top, the sign-in screen, and the rules' budgets in the browser check, so a screen that is too heavy fails. The parts are a design system, a package of its own that the app imports (the owner, 2026-11-14), with a site of its own at `/design`.

**Look at:**

- **The sign-in and the frame on your control,** in light and in dark, at a desk and on a phone.
- **The design system's site:** `/design` on your control. Every part with its states, its rule and its code, beside the brand guide's five boards of parts: the state chips, the tiles with their history, the tree, the explorer's fields and results, a form's "i", a dialog, a menu, Undo.

**Iterate on:** the brand in real pixels. Spacing, weights, the dark values, how a part moves and takes focus. Every screen is built from these parts, so a change is cheapest now: change the part here, never a screen later.

### 4 · PostgreSQL beside SQLite (goal 268, step 2) · L

```text
/goal complete docs/plan/goals/268-postgresql-beside-sqlite.goal. rereview/reread before wrapping up
```

A second store behind the same interface, the tests run on both, a command that copies a control's data and checks the counts, and backup and restore on PostgreSQL. PostgreSQL is for trial until step 6.

**I ask you first:**

- **A PostgreSQL for the fast tests** (the design's proposal, not yet answered): a real server for each run of the tests, or a stand-in in memory. It sets how long `npm run check` takes on every machine.
- Whether a deployment may use a PostgreSQL server it already has.

**Look at:**

- The copy command run on a copy of your real control's store: the counts, and the SQLite file unchanged.
- A trial control on PostgreSQL, beside your real one, and its backup and restore.
- How long the fast checks take now, against before.

### 5 · The knowledge base's search on PostgreSQL (goal 269, step 3) · L

```text
/goal complete docs/plan/goals/269-knowledge-search-on-postgresql.goal. rereview/reread before wrapping up
```

Search moves to PostgreSQL's own text search. The order of results changes, because its ranking is another, and the exact mode gets a new syntax.

**I ask you first:**

- The exact mode's syntax: PostgreSQL's own, or a small one of Thermite's that is turned into it. Agents type it too.

**Look at:**

- The kept set of searches with their hits on both engines: what moved, and whether anything is no longer found.
- Your own usual searches, on the trial control.
- The words of a refusal when the old syntax is typed.

### 6 · The move to PostgreSQL (goal 270, step 4) · M · changes your deployment

```text
/goal complete docs/plan/goals/270-move-to-postgresql.goal. rereview/reread before wrapping up
```

Control runs on PostgreSQL. An upgrade copies the SQLite store, checks it, and keeps the file as the way back. A one-machine install gains a service.

**I ask you first:**

- Whether control runs the copy at its first start on the new version, or a person runs the command.

**Look at:**

- **The upgrade of your real control, at your yes,** after a backup: the counts, the same event to go on from, and the time it took.
- The way back, tried on a copy by the docs' own steps, and what it loses.
- Install on one machine, read as a new person would: is one more service still simple?

### 7 · Sign in as a person (goal 261) · M

```text
/goal complete docs/plan/goals/261-sign-in-as-a-person.goal. rereview/reread before wrapping up
```

A user name and a password for the dashboard. Tokens are for programs.

**I ask you first:**

- Passwords kept by control, or a sign-in you already have (OpenID Connect, a passkey).
- Whether the owner's token still opens the dashboard, for a script that drives a browser.

**Look at:**

- A new control: its first start asks for your user name and password before anything else.
- Your control: sign in at `/next` and at `/ui`, sign out, and change the password with a second browser open (its session must end).
- A lost password set again by the one command.
- The record of a change: it names you.
- The sign-in screen beside its board, on a phone.

### 8 · One door for each action (part of goal 244) · L

```text
/goal complete items 1 to 3 and 6 to 9 of docs/plan/goals/244-one-door.goal. rereview/reread before wrapping up
```

An action is one function, with one entry that names its REST route, its MCP tool and who may call it. The words for a state, a verdict and an event leave page code. One way to refuse. One stream that says what changed. Items 4 and 5 (each area's own actions and reads) are built in that area's step, through this door; the goal closes at step 27.

**I ask you first:**

- An OpenAPI file for control, made from the entries, or none.

**Look at:**

- **The list of entries:** one line for each action. It is the map of what Thermite can be asked to do. Read it for names that are unclear.
- One action done three ways (REST, an MCP tool, the old dashboard), with the same answer and the same words.
- The table of today's statuses that scripts rely on.

### 9 · One record for each setting, command and event (goal 254) · L

```text
/goal complete docs/plan/goals/254-one-record.goal. rereview/reread before wrapping up
```

A setting, a command and a kind of event are each written once, and everything else reads that record. It comes before steps 10 and 12, which change events and settings, so that each is a smaller change.

**Look at:**

- The proof by count: a new setting and a new command added on a test branch, and how many files each touched.
- **The docs' REST and MCP reference pages,** which are now made from the code. Read them as a reader.

### 10 · A run's tables (goal 271, step 5) · L

```text
/goal complete docs/plan/goals/271-a-runs-tables.goal. rereview/reread before wrapping up
```

A run's records as tables with fixed names and columns, read by a role that can only read. The explorer and the SQL screen stand on them.

**I ask you first:**

- **Filled from events first** (the design's proposal, not yet answered), so the tables exist while rigs still run underneath; or wait for step 31.
- Which tables the first version has: the eight of the design, or also the judge's jobs, prompts and model use, which the SQL board names.
- The time limit and the row limit of a query.

**Look at:**

- **The reference page of the tables and their columns.** These are the names you and the agents type in SQL, and saved views depend on them. Changing a name is cheap now and announced later.
- A select over one of your real runs, and a write that is refused in words.
- Your largest run: the tables hold every event and try, where today's view cuts.

### 11 · The door apart from the record (goal 272, step 6) · L

```text
/goal complete docs/plan/goals/272-the-door-apart-from-the-record.goal. rereview/reread before wrapping up
```

The dashboard and the API become a service of their own. A restart of one stops nothing of the other. Its "Done when" takes in two items of other goals: control made by one function (goal 256, item 7) and every loop on the health route (goal 257, item 6).

**Look at:**

- **On your control, with a run at work:** restart the door (your session holds, the run goes on), then the record (the screens lag and catch up, with no event twice).
- The health route: each loop, and the service it runs in.
- Troubleshoot's page on what a restart of each service does.

### 12 · A run owns its agents (goal 273, step 7) · L

```text
/goal complete docs/plan/goals/273-a-run-owns-its-agents.goal. rereview/reread before wrapping up
```

A run's agents, their models and its workers at a time are the run's own, changed on the run from its next trial. A rig is still underneath.

**I ask you first:**

- Which of a rig's settings become the run's, and which stay the machine's.
- Whether a change can be made to hold at once, by ending the trial in flight, or always waits for the next.
- What the old dashboard's Edit rig does from here: it changes the run at work, or it only shows.

**Look at:**

- **A real run at work:** change a worker's model over the API or MCP, and see the next trial use it. Change the workers at a time, up and down.
- Two runs of one campaign, one after the other, each with its own models and no edit between them.
- The run's history: each change, with who made it.

### 13 · Machines as a pool (goal 274, step 8) · XL

```text
/goal complete docs/plan/goals/274-machines-as-a-pool.goal. rereview/reread before wrapping up
```

Machines and their devices are a pool, and a scheduler in control places a run. No answer that the app needs names a rig. **The app's model is true from here, and the screens start.** Until step 31 a machine still serves one run at a time, and a run still needs a machine.

**I ask you first:**

- **When no device that fits is free:** the run waits in a queue on control, or the start is refused in words.
- What a request that today's machines cannot serve gets until step 31 (a device shared by several runs, a run with no machine): it waits, or it is refused.
- The order among runs that wait.

**Look at:**

- **Your machines and their devices at the API:** is each of your real shapes mapped as you think of it (a machine that held several rigs, a core with runners on other machines, a place in a cluster, a rented machine)?
- A run started with "any free device that fits", and one that names its devices.
- The glossary's words (machine, device, pool) and the page Sharing a device.

## B. The daily work

Each screen step follows [how a screen is built](app-build-plan.md#how-a-screen-is-built): its board is its specification; its reads and actions, with tests at the API; the screen, from the app's parts; its cases in the browser check; its docs pages.

**Iterate on, at every screen step:** real data is messier than a mockup. Look for a long name, a run with thirty numbers, a run with none yet, a list of two hundred, a state the board did not draw. Where a board and the truth differ, we change the board first and then the screen.

### 14 · Home and what needs you (goal 246)

```text
/goal complete docs/plan/goals/246-home-and-decisions.goal. rereview/reread before wrapping up
```

**Look at:**

- Home on your control: every need of your real runs, each with its choices and what each does.
- Answer a need of each common kind, at a desk and on a phone. The row leaves with its line.
- The count of needs: the same number everywhere it shows.
- A machine in trouble shows as a need, and goes when the machine is well.
- "What changed since you last looked", after a night away.
- One attempt's page from a need: its measurement, its folds, and its evidence withdrawn.

**Iterate on:** the sentence of each kind of need, their order, and what earns a place on Home at all.

### 15 · Campaigns and a run (goal 247)

```text
/goal complete docs/plan/goals/247-campaigns-and-runs.goal. rereview/reread before wrapping up
```

The largest screen step: the list of campaigns, a campaign and its Setup, and a run's Summary, Results, Steer, Usage, Setup and More menu, for a hill climb, a goal run and a research run.

**I ask you first:**

- A need on a run's Summary: answered through one link, as drawn, or with two buttons, as on Home.
- Where "the workers keep working while the judge works" is set on a screen.

**Look at, on a real run of each kind:**

- Summary: its one sentence, its tiles with their history, and why a part is idle.
- Tell the agents; remove a rule; change a model and the workers at a time on the run.
- Pause and close with no reason typed.
- Results: find a best change, push it, download it as a patch, and the run's export as one file.
- A campaign: its notes and kit changed in one Save; its results as one file.
- Campaigns › Results: each ended run as Complete, Failed or Stopped.

### 16 · Watch and Live (goal 248)

```text
/goal complete docs/plan/goals/248-live.goal. rereview/reread before wrapping up
```

**I ask you first:**

- Whether Live stays a screen of its own, or becomes Watch's choice "Every run".

**Look at:**

- Watch a real run: filter by who, open a line, open a worker's terminal and type into it.
- A line that runs a shell command waits for the second Send.
- Drop the network and come back: no line twice, none out of order.

### 17 · The explorer (goal 262)

```text
/goal complete docs/plan/goals/262-the-explorer.goal. rereview/reread before wrapping up
```

**I ask you first:**

- Whose a saved view is: the campaign's, or a person's. Whether an agent may save one or only run one.
- What the typed query may hold beside a field with a value and plain words.

**Look at:**

- Explore on each of the seven kinds of record, on your largest run: how fast it is, and counts and a band that cover the whole run.
- A record open beside its results.
- A view saved, opened by its link on another run of the campaign, and run by an agent over MCP.
- The SQL screen: a select, its limits, and a refusal in words.

**Iterate on:** which fields each kind shows first, and which events are bookkeeping.

### 18 · A release candidate (this page)

```text
/goal complete step 18 of docs/plan/v030_release_plan.md, and stop before the tag. rereview/reread before wrapping up
```

The daily work is in the app. This step gets a candidate ready from the branch `v0.3.0`: the full fast checks, the browser check, the acceptance checks of what steps 1 to 17 touched, an upgrade from v0.2.x on a copy, and the changelog so far. The tag is yours to say.

**Look at:**

- **Some days of your own work in the app.** Write down each time you open `/ui`, and why. That list is the true order of part C; we change the order below to follow it.
- Whether to tag the candidate for testers now, or to go on.

## C. The rest of the app

### 19 · Providers, and Set up Thermite (goal 245)

```text
/goal complete docs/plan/goals/245-providers-and-set-up.goal. rereview/reread before wrapping up
```

The provider catalogue with its back end, Add a provider and a provider's card in fxbot's shape, the Claude Code sign-in, Models, Agents, Tools, Access, and Home with nothing set up yet.

**I ask you first:**

- Whether Thermite runs the Claude Code sign-in on its own server, or takes what Claude Code gives on your computer.
- Which sign-ins v0.3.0 has beside a key and the Claude plan.
- Whether the group Clouds shows before a cloud's own sign-in works.

**Look at.** You type every key and code yourself; I never enter one.

- Add a provider from the catalogue with a real key: the key checked, the first model asked for, the model check passing with no machine.
- A key the provider refuses: nothing saved, and one line of why.
- A Claude plan through Claude Code's long-lived sign-in, and a run that uses it with nobody at a terminal.
- A device-code sign-in, with control restarted in the middle.
- A custom server, and a server on your own machine that Thermite finds.
- A new control: Home with its three steps.
- The agents a new run starts with, a tool server added, a Git login tried on a repository.
- A provider in use, removed.

### 20 · New campaign (goal 249)

```text
/goal complete docs/plan/goals/249-new-campaign.goal. rereview/reread before wrapping up
```

**I ask you first:**

- Where results go by default: Thermite alone, as today, or branches of the project, as you asked on 2026-10-27.

**Look at:**

- A campaign of each kind started from the form's seven answers, with nothing set under Advanced.
- Try one first; another run from its dialog; a campaign from a best change.
- A missing model, device or Git access: one line, with the one thing to do. A refused field, shown at that field.
- The whole form on a phone.

### 21 · Compute (goal 250) · may spend money

```text
/goal complete docs/plan/goals/250-rigs-and-machines.goal. rereview/reread before wrapping up
```

**I ask you first:**

- Which kinds of device v0.3.0 has beside a GPU and a CPU.
- Whether Update is a machine's main button while an update waits.

**Look at:**

- Compute beside your real machines: every machine and device, its state, and what runs on it.
- A machine's page: its devices, its checks, its log, its busy share hour by hour.
- A machine of each kind added, drained, updated, removed and added again: over SSH, in a cluster, and rented by the hour (at your yes: it costs money).
- A rented account's card: what Thermite spent there.

### 22 · Knowledge (goal 251)

```text
/goal complete docs/plan/goals/251-library.goal. rereview/reread before wrapping up
```

**I ask you first:**

- Whether a quick look at an item beside its list is still wanted, now that the tree is back.

**Look at:**

- The tree, down to an item, on your real knowledge base.
- A search of everything and of one folder; a collection found by its name.
- A note added; another campaign let in to read a collection, and that taken back.
- All of it on a phone.

### 23 · The rest of Setup (goal 252)

```text
/goal complete docs/plan/goals/252-usage-logs-settings.goal. rereview/reread before wrapping up
```

**I ask you first:**

- Where control's own log lines show.
- Whether a storage rule is on as soon as it is saved. A rule destroys records.
- A button that backs up, or the command alone.

**Look at:**

- Setup's first screen: each part's state in one line, and the one that is wrong in colour.
- Spend: 30 days by campaign and by plan.
- Logs: an action found by who did it; a command that hangs, cancelled.
- Storage: a rule made after reading what it would remove. Exports: one downloaded, one deleted. Backup: when the last was.
- System: control's log level.

### 24 · Search (goal 263)

```text
/goal complete docs/plan/goals/263-search.goal. rereview/reread before wrapping up
```

**I ask you first:**

- What "the best first" is, and how deep search reads: names and numbers alone, or texts too.
- Where the box opens from on a phone.

**Look at:**

- ⌘K from every screen: a run by its number, a campaign, a machine, a setting, a change, a note.
- Words that start with a verb: the action is offered, and one that needs a confirmation asks.
- A week of use: what you typed that found nothing.

### 25 · Plain names (goal 264)

```text
/goal complete docs/plan/goals/264-plain-names.goal. rereview/reread before wrapping up
```

**I ask you first:**

- Whether you may change a name, and whether experiments and tries get one too.

**Look at:**

- A real run after a planner's round: the plain name with the agents' own beside it, on Summary, in Explore and on an attempt's page.
- A kit's plain line under a number.

**Iterate on:** the names themselves. They come from the planner's prompt, so we read fifty of them and change the prompt until they read well.

### 26 · The agents ask the owner (goal 265)

```text
/goal complete docs/plan/goals/265-agents-ask-the-owner.goal. rereview/reread before wrapping up
```

**I ask you first:**

- Which agents may ask, and what keeps Home short when many do.
- What "Not now" does to a question, and for how long.
- What the agents' question is called on a research run, which already has questions of its own.

**Look at:**

- A real agent's question as a need, on Home and on its run's Summary.
- Your answer reaching the agents at their next step, and the note marked as answered.
- A question nobody answers: nothing pauses and nothing ends.

### 27 · The door, closed (goal 244)

```text
/goal complete docs/plan/goals/244-one-door.goal. rereview/reread before wrapping up
```

Every area's actions and reads went through the door in steps 14 to 26. This step proves the whole: everything the dashboard does, without it.

**Look at:**

- An agent that runs a campaign from start to end over MCP alone, and a script that does the same over REST alone.
- The REST and MCP references, and no page left that says "not in the API yet".

## D. The agents move

The screens are done and in daily use, on rigs underneath. Now the agents' loops move into the control plane. Steps 28 to 30 come first because each makes that move smaller: records that find a fault, one way to run a program, and the harness's knot of imports cut.

### 28 · Find the fault (goal 257) · L

```text
/goal complete docs/plan/goals/257-find-the-fault.goal. rereview/reread before wrapping up
```

**I ask you first:**

- Whether the agents' sessions (a trial's transcript, a planner's or an advisor's call) are searched in the same place in this goal, or in a goal after it.

**Look at:**

- Logs in the app: a machine's log lines, searched on control.
- Work that is overdue, said in words on Live: a message a terminal did not take, a job nobody leased.
- The three faults that were hardest to find, each made in a test and found from the records alone.

### 29 · One way to run an agent program (goal 255) · L

```text
/goal complete docs/plan/goals/255-one-way-to-run-a-program.goal. rereview/reread before wrapping up
```

**I ask you first:**

- **Which agent programs v0.3.0 keeps.** Each one kept is moved in step 31, and goal 260 proposes fewer.

**Look at:**

- A trial of each program on a real run, in its own terminal and headless. Nothing else should show.
- The count of files that name a program, before and after.

### 30 · Layers and splits (goal 256) · L

```text
/goal complete docs/plan/goals/256-layers-and-splits.goal. rereview/reread before wrapping up
```

What is left of the goal after steps 1 and 11: the files at the limit split on purpose, the harness's cycle of imports cut, its service whole when it is made. Its item on the supervisor's `main` is read against step 31 first, which takes the supervisor off a machine.

**Look at:**

- The harness's largest cycle of imports, before and after.
- A day of real runs. Nothing should show.

### 31 · The agents in the control plane (goal 275, step 9 of goal 258) · XL, in parts

```text
/goal complete the split of docs/plan/goals/275-the-agents-in-the-control-plane.goal into its parts, each a goal with its own "Done when", and add each part's command to docs/plan/v030_release_plan.md; write no code. rereview/reread before wrapping up
```

The largest step. It is split first, with no code: the goal names ten parts that can be seen today (the link, the runner, the record, the judge's decisions, the zones and their sandboxes, Thermite's own loop, the agent programs, the advisors, conversations in the record, and keys with Git). Each part becomes a step of its own here, with its command and its "Look at". The goal closes with:

```text
/goal complete docs/plan/goals/275-the-agents-in-the-control-plane.goal. rereview/reread before wrapping up
```

**I ask you first,** at the split:

- Which of a worker's commands run in its zone and which go to a machine, and who says so: the kit, or the kind of command.
- How a zone is made: one container that holds every zone, or a container for each worker.
- What a commit means for what is not in Git: model weights and large files a machine needs.
- How rented machines and places in a cluster become runners.

**Look at,** when the goal closes:

- A hill climb from its start to a kept win, with its agents in the control plane and one runner on a machine.
- A research run with no machine. Two runs on one machine at one time.
- Each service restarted while a run works; a runner that leaves and comes back while the judge measures.
- No sign-in for a model on any machine.
- Compute, New campaign and a run's Setup: they show the new truths with no change to a screen.

### 32 · Thermy, its first step (step 1 of goal 266) · L

```text
/goal complete step 1 of docs/plan/goals/266-thermy.goal. rereview/reread before wrapping up
```

The corner on every screen, the chat over a page that reads the page, Thermy's own screen with its threads, and its settings. It asks before it acts.

**Needs first:** fxbot's agent core as a library with no database. That is work in fxbot's repository, outside this list.

**I ask you first** (the goal's questions 3 and 6 to 10):

- With whose rights Thermy's tools act, and how the record names an act: Thermy's, or yours who pressed the button.
- What "reads the page" gives it.
- Which models Thermy can think with, and whether an owner with only a Claude subscription gets Thermy.
- When each of its moods shows, and the one line it may offer from its corner.

**Look at:**

- Thermy on every screen, for the first time for real: its eyes, its moods, its one line.
- A chat over a run's Summary: does it know what the page shows?
- Ask it to start something: the act waits as a card with a button, and nothing starts before you press it.
- Ask it to judge: it may not.
- What a long thread costs, on Spend.

**Iterate on:** its voice, when it speaks up, and how much it says.

## E. The end

### 33 · The switch (goal 253) · changes your deployment

```text
/goal complete docs/plan/goals/253-the-switch.goal. rereview/reread before wrapping up
```

The app moves to `/`, and the old page code goes: about 34,000 lines.

**I ask you first:**

- How long an old address keeps opening its new screen: one version, or always.

**Look at:**

- The goal's line for each screen: checked against the rules, with each gap fixed or explained.
- Your bookmarks and old links: each opens its new screen.
- The docs site: every screenshot is of the new dashboard.
- **Your control on the new dashboard alone, for some days,** before step 34.

### 34 · The rig goes (goal 276, step 10 of goal 258) · XL · changes your deployment

```text
/goal complete docs/plan/goals/276-the-rig-goes.goal. rereview/reread before wrapping up
```

The rig's tables, bus users, commands, set-up and words leave the code and the docs. Goal 258 closes with it.

**I ask you first:**

- **Whether one released version may hold both shapes.** A deployment that moves up from v0.2.x has runs at work on rigs. Either the upgrade says what such a run must do first, or this step ships a version after step 31. Your answer decides whether v0.3.0 waits for this step.
- Which old routes, tools and commands stay under their old names, and for how long.
- What a rig's name becomes where you know a machine by it.

**Look at:**

- **The upgrade of your real control, at your yes:** each run and each machine holds what its rig held.
- A machine set up as a runner from Add a machine: over SSH, in a cluster, and rented.
- The word "rig": in no screen, route, tool, error or docs page, but where an old name is read.

### 35 · The release (the release plan)

```text
/goal complete the "Before the tag" list of docs/plan/release-v0.3.0.md, and stop before the tag. rereview/reread before wrapping up
```

The full `npm run check`, the browser check, every acceptance check, the docs, the images pinned by digest, the changelog and the upgrade's notes.

**Look at:**

- The changelog, read as a tester of v0.2.x: what changes for them, and what they must do (PostgreSQL, the sign-in, no rig).
- A new install by the quick start's own pages, and an upgrade of a copy of your control.
- The open goals of v0.3.0 that are not on this page: which are verified, and which move on.

**Then, at your word:** `v0.3.0` merges into `main`, the tag, CI's full run on the tag (a maintainer approves it), and the release.

## What is not on this page

- **The 38 older goals of v0.3.0** ([the release plan](release-v0.3.0.md#the-other-goals-of-v030)) ship if they are verified by then, and move on if not. One that you want in gets a step: the model's reasoning on Live (goal 093) after step 16; a run's use of its machine (134) after step 15; a kit bundle from the dashboard (097) and from research to the next campaign (120) after step 20; one budget in dollars (123) after step 23; faster pages (089) after step 27.
- **Fixes to v0.2.x** go on as versions of their own, and merge into the branch `v0.3.0`.
- **Thermy's steps 2 and 3, the harness on fxbot's agent core (goal 260), and a runner with no container engine (goal 277)** are after v0.3.0.

## Where I chose the order

The plans give lanes that run side by side. One goal at a time needs one line, so these are my choices. Say so to change any of them.

1. **The brand (step 3) and the sign-in (step 7) sit between the store's steps,** not after them. The plan puts them beside goal 258. Here they give you something to look at between long steps with nothing to see, and the sign-in's tables are made in PostgreSQL from the start.
2. **The provider catalogue's back end is built with its screens (step 19),** not pulled forward. Built alone it shows nothing, and it would hold back the first screens.
3. **The door (step 8) and the records (step 9) come before a run's tables (step 10).** Steps 10 to 13 change events, settings and actions, and each is smaller after them.
4. **Find the fault, one way to run a program, and layers and splits (steps 28 to 30) wait until after the screens.** They are work on the rig's side, which only step 31 needs. It is the shortest way to the first screen.
5. **The agents move (step 31) after every screen, and before Thermy.** The app is whole and in daily use before the largest change under it, and Thermy's loop then has a service to run in.
6. **The switch (step 33) comes before the rig goes (step 34).** The old pages read what step 34 removes.
