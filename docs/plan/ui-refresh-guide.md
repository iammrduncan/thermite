# The UI refresh guide

This guide is for the refresh of the dashboard in v0.3.0, goals [243](goals/_completed/243-web-app-base.goal) to [253](goals/253-the-switch.goal). It is one result of goal [242](goals/_completed/242-v030-review.goal), the review of 2026-11-10. Its partner, the [code structure guide](code-structure-guide.md), covers the code behind the screens. The [release plan](release-v0.3.0.md) puts both in one order.

- **What it describes:** the dashboard of v0.2.0, as the browser check drew it on 2026-11-08 (159 pages, each at 1440 and 820 pixels wide, on the demo's data), and the UI of [fxbot](https://github.com/iammrduncan/fxbot) at its `release/0.8.0` branch (commit `ff53429`, read on 2026-11-10).
- **Where it comes from:** six reviewers on 2026-11-10, each with one area: fxbot's UI system and its provider set-up; every screen of the dashboard; how the dashboard is built; providers in Thermite; control's code; the rig's code. Their reports, with every count, screen and line number, are kept in the maintainers' private notes.
- **What it is not:** a set of mockups. Each screen is still chosen from a mockup the owner looks at ([rules for every goal](README.md#rules-for-every-goal)). This guide says what each mockup must settle, and what stays the same on every screen.
- **What is decided:** the owner decided the direction (below) and, on 2026-11-10, took the recommended answer to each of [the questions](#11-the-owners-questions). A screen's look is still chosen from its mockup.

The owner, 2026-11-10: "for v0.3.0 release I want to fix our UI and UX experience... I want to utilize the UI/UX system I started for fxbot ... including it's v0.8.0 provider login setup system. Its way cleaner and nicer than our ux. Our ux is cluttered and clunky and hard to navigate/understand."

## 1. What the review found

### The dashboard in numbers

| Measure | Today |
| --- | --- |
| Places in the left navigation | 9, with Settings behind an icon with no label. 2 more pages have no entry at all (Leaderboard, Agents) |
| Settings | 9 areas in 5 groups, in a navigation of its own that replaces the main one |
| Kinds of page | About 45 |
| Deepest path | 5 levels: Campaigns › campaign › run › Attempts › attempt |
| Tabs on a run's page | 9 on a hill climb or a goal run, 11 on a research run |
| Actions on a run's page | 5 buttons in view and up to 5 more in its **⋯** menu |
| Above a run's tabs, on every tab | A sentence on the knowledge base, a line of counts and 3 or 4 cards of cost and tokens: about 260 pixels. The tab's own content gets 62% of the first screen |
| Pages longer than two screens at 1440 pixels | 18 of 159. A run's History is 6,664 pixels, Metrics › Storage 6,327, a run's Attempts 3,893, Edit rig 2,340 |
| At 820 pixels | The left navigation stays 255 pixels wide, 31% of the window. 38 of 159 pages are longer than two screens, and several break |

### The findings

In the order of how much each one hurts a quick scan. Each fact is from the screenshots; the order is the reviewers' judgement.

1. **One fact has many places.** The pages follow where the data comes from, not what the operator came to do.
   - One decision that waits for the owner is signalled in at least 11 places: a badge and a word in the navigation, the footer, a tile, a card with buttons, a line in At work, the Campaigns page (5 times on that page alone), the campaign's page, the run's page, the attempt's row and the attempt's page.
   - "What is this run doing now" is drawn 6 times, each a little differently: Overview, Campaigns, the campaign's page, the rig's page, Live and the run's page.
   - Cost and tokens have 6 homes and 3 names (Model use, Stats, Agent figures).
   - "What takes space" has 3 pages in 3 areas, and Retention policies a fourth.
   - A run's results are in 4 top-level places (Reports, Exports, Knowledge and the run's page), and what happened is in 6 lists of 3 formats.
2. **The run's page holds too much.** 9 to 11 tabs, 10 actions and a fixed head on every tab.
   - Steering a run is on 5 surfaces: Message, the Experiments form, Tell the planner, Hypotheses and the **⋯** menu.
   - "Why is it stuck" takes at least 6 screens: Overview, History, Planner, Stats, Live and the rig's page.
   - A tab with nothing in it still shows (Prompts, Journal with 0 notes).
3. **Rules are written on the screens as prose.**
   - 10 kinds of page open with a paragraph. About 40 headings carry a grey sentence beside them.
   - "How it works" cards of 11 to 13 lines sit beside the data (Reviews, Hypotheses, Planner).
   - Edit rig has 16 sentences on its 8 switches. Each rig check has a description of 3 lines.
   - A state is often a banner across the page: a decision, an offline rig, a form that can't work, an empty Exports page.
   - Most of this text is correct and written with care. Its fault is its place: it has the weight of the data, so a scan can't skip it.
4. **One thing has many words.** 24 things have more than one word on the screens ([the table](#one-word-for-each-thing)). For example: Needs you, Waiting for you, Approval, Your decision and Review; Running, at work and Auditing; Finished, Closed and Stopped; round, epoch, plans and hand-out. "Live" names a rig's state, a page, a button and the footer's mode. The Attempts tab uses two sets of words for the judge's results on one screen.
5. **One thing has many looks.** About 10 ways to show a state, 6 ways to filter a list, 3 looks for a tile of figures, 4 for a section's heading, 3 for a card that is a choice, and 4 for "nothing here". Several actions are plain words that don't look like buttons (Pause, Promote, Retire, Remove, Drop).
6. **Long lists have no tools.** History (up to 400 sentences) and Attempts (51 rows on the demo) have no search, filter, sort or paging. The Audit log and Reports have them.
7. **The way back is lost.** A run's Live has no path back to its run. A rig's Live is filed under Live. Settings replaces the whole navigation. The title of a page is often an ID. A campaign in the navigation says "Running" while one of its decisions waits.
8. **An action's effect is somewhere else.** On the Overview, one click decides a change, and what each choice does is on the attempt's page. The **⋯** menus are empty-looking boxes. Send champion, Promote, Retire, Drop and Withdraw are one word each. The only button on an offline rig's banner is **Retire it**.
9. **Forms show everything at once.**
   - Edit rig shows about 45 controls on one page of 2.6 screens, and the agents' models, which most visits are for, start 900 pixels down.
   - New campaign's steps 4 and 5 hold about 15 and 20 fields.
   - Add forms are always open: Providers, MCP servers, Addresses, Experiments, Tell the planner.
   - A form that can't work shows in full under a banner that says so (Edit rig on an older harness, Add a rig with no images).
10. **Internals show as content.** Trial IDs on every Live line, `seq`, `(index 1)`, "card version 2", event code names in the Audit log, the names of environment variables and of SQLite tables, and "not reported by this rig's harness" in many blocks.
11. **A narrow window breaks pages.** The navigation doesn't fold. A run's buttons and tabs run off the screen. Knowledge's panes overlap. The right-hand columns of 6 tables are cut off.
12. **Faults of layout recur.** 14 at 1440 pixels on the demo: text wrapped into a column 70 pixels wide (the agents' model, on every rig's page), rule rows with no words, text printed over text in the Campaigns table, a placeholder longer than its box.

### What works, and stays

The refresh keeps these, in the new look.

- **The Overview's order:** what needs the owner, then what is at work, then what happened. Its decision row is understood at a glance: a label, one plain sentence, the reason it waits, its evidence as chips, how long it has waited, and two buttons.
- **The At work row:** the campaign and run, the rig, a small chart or a bar of goals, the headline number, then a line for each lane and the judge.
- **The decision card on an attempt's page:** the question as its title, the cause, the buttons, and a table of what each choice does, "Do nothing" included.
- **The timeline "What happened to it"** in plain words, with every event behind one line that opens.
- **The sentence of state** at the top of a run and of a rig ("Champion #4 is +11.0% against where the run started. No lane is at work.").
- **Results in pictures:** the champion's step chart with its headline, and goals as a bar and a list of ticks.
- **Standard patterns that are already right:** Knowledge at 1440 pixels (tree, list, details, one line of search, dropdown filters), the Audit log's toolbar (filters as chips that can be removed, search, pages), and the Rigs table with counted filters.
- **Live's transcript:** time, a coloured tag for who, one line for a tool call and its result, filters by agent, **Follow**, and one message box.
- **The effect before the action:** "What changes when you save" on Edit rig, "If it ran now" on a retention policy, and New campaign's sentence that says what the campaign will do.
- **Defaults in words** as placeholders ("no limit", "same as the workers"), and typed confirmation for what can't be undone.

### The operator's jobs

The new navigation ([section 6](#6-the-new-navigation)) is built from these, not from the data.

| Job | Screens it takes today |
| --- | --- |
| See what needs me, and decide | 6 ways in, 5 names, and counts that differ |
| See what is at work | Overview, or any of 5 other places |
| Start a campaign | New campaign's 6 steps. What it needs first (a rig, a machine, a provider, Git access) is in 3 other areas, and a missing one is refused at the last step |
| Start another run | The campaign's page. The button is absent on most |
| Watch a run | **watch**, a Live button, or Live in the navigation. Two designs of Live, and no way back |
| See how a run does | The run's Overview, under the cost cards |
| See why a run is stuck | At least 6 screens |
| Steer a run | 5 surfaces |
| Add a rig | Settings › Machines first, then Rigs › Add a rig |
| Connect a model and give it to agents | 2 areas and about 8 screens |
| Find a result | 4 top-level places, the run's page and a hidden Leaderboard |
| Check cost | 6 homes |
| Check or repair a rig | The rig's page and Metrics › Rigs |
| Manage what is kept | 4 pages in 3 areas |
| See who did what | The Audit log |
| Read what the agents learned | Journal, the campaign's Knowledge card, Knowledge |

## 2. fxbot's UI system

### What it is

fxbot's page is a small web app: about 10,100 lines for every screen of the product, of which 2,900 are components it did not write.

| Part | fxbot |
| --- | --- |
| Framework and build | React 19, built by Vite. No router library, no data library, no state library and no form library |
| Components | [shadcn/ui](https://ui.shadcn.com) in its `radix-nova` style: 25 component files made by shadcn's tool, on Radix UI. As far as the review could tell, fxbot changed none of them, and it added no component layer of its own |
| Styles | Tailwind CSS 4, with the theme as CSS variables in one file of 140 lines |
| Colours | shadcn's stock neutral theme: every colour is a grey, except the one for "this destroys something". The main button is near-black in the light theme and near-white in the dark one |
| Light and dark | The operating system's setting. No switch |
| Type | Geist, served by the app itself. Nearly all text is 14 pixels; captions are 12. Two weights. A title differs from body text by its weight, not its size |
| Icons | Lucide, 16 pixels, and few of them |
| Controls | 32 pixels high, at the left, never the full width |
| Layout | A left navigation that slides away, and one screen beside it. Each screen has a header of 56 pixels with its title, and one centred column: 576 pixels for forms and settings, 768 for the chat |
| Data | One typed client of the server's HTTP API. The page imports nothing else of the server |

### Why its screens read as clean

fxbot has no written guide for its look. Its restraint comes from its conventions ("Simplicity over complexity, small over huge, light over heavy"), from shadcn's components left as they are, and from choices its plans record ("Ask little, then go"; "Nobody should be trapped in a wizard"; "Ready means it works, not that something is set"). In the code it shows as nine habits:

1. One palette of greys. Colour means "this destroys something" or "this is a product's logo", and nothing else.
2. One size of type for nearly everything, and grey for what is secondary.
3. One column. No screen is a grid of panels.
4. Borders, not shadows and not filled panels.
5. One sentence under a heading at most, one hint under a field at most, and on most none. No help panels, no tips, no icon to hover on a label.
6. Small controls, and one main button on a screen.
7. Adding a thing happens in a dialog, or on a set-up page with no navigation around it. A row's actions are in a menu that a right-click opens.
8. The browser's own parts where they are enough: a link is a link, a select is a select.
9. Nothing shows before it is whole: no placeholders that jump.

### What it doesn't have

fxbot is a chat app. It has no table of many columns, no chart, no colours for states, and no screen that is dense on purpose. Thermite needs those: it is a dashboard, and the owner's rule is that a dashboard stays a dashboard. They are added in the same system, not beside it: shadcn's table, menu and tab components, the same tokens, and four colours for states ([the rules for screens](#4-the-rules-for-screens)).

fxbot's chat is close to one Thermite screen. **Live** is a stream of what agents say and do, with a box to write to them: fxbot's message list, its trace of tool calls and its message box are the same parts.

### Its provider set-up, in brief

fxbot 0.8.0's "Providers v2" is one component, used in Settings and in first-run set-up:

1. **A catalogue:** a search box, then tiles in groups (Sign in, Use a key, Clouds, On your machine), each a logo, a name and one line.
2. **A provider's card:** its logo and one line, what it costs to begin, a Help link, then a sign-in panel, a key form, or both. The key form is a numbered list (open the provider's key page, then one line for each step there), the fields that provider needs, and one button, **Add**, which checks the key with the provider and refuses a bad one.
3. **A model:** "Connected", a model picker with a good model filled in, and what the model can do.

The list of providers is data: one file of 36 entries, each with its address, its key page, the steps there, how to check a key and its quirks. [Section 7](#7-providers-and-first-run-set-up) says how Thermite takes it.

### What Thermite can take

fxbot is the maintainers' own project, under the Apache License 2.0.

| Part | Size | Taken as |
| --- | --- | --- |
| The theme (tokens, radius, type) | 116 lines | As it is |
| The components | 18 of the 25 files serve any app, about 1,950 lines | Made again by shadcn's tool with fxbot's settings, so they stay stock |
| The header, the links' helper, the phone check | 46 lines | As they are |
| The frame of Settings (tabs that are links, a column from 1,024 pixels, a row of pills below) | 27 lines | With Thermite's tabs |
| The Add-provider page and the provider rows | 866 lines | With small edits, if Thermite's API gives the same 12 calls and shapes |
| The model picker (search, or type an id) | 130 lines | With small edits. Edit rig needs it too |
| The registry of providers | 523 lines, 36 entries | With Thermite's own fields added ([section 7](#the-registry)) |
| The registry's reader, the device-code sign-in, OpenRouter's sign-in | About 200 lines | As they are |
| The shell, the navigation's content, first-run set-up | — | As patterns: they are mixed with bots and chats |
| The ChatGPT and Grok sign-ins, and the agent that calls the model | — | Not taken: they are in libfx, whose tokens are made for libfx's own agent. Thermite keeps its own ChatGPT sign-in and its agent programs |
| The logos of providers | 183, 274 KB | After each licence is checked ([question 9](#11-the-owners-questions)) |

## 3. How Thermite uses it: two designs

CONVENTIONS.md asks for two designs before a large one. These are the two ways to "use fxbot's UI system".

- **A: the same system.** The dashboard becomes a web app in this repository, built with what fxbot is built with: React, shadcn/ui, Tailwind, Geist and Lucide, built by Vite. It is a client of control's REST API and its event streams, and of nothing else. Control serves its built files. The pages drawn on the server are removed when the app covers them.
- **B: the look alone.** The dashboard stays HTML drawn on the server, as today. Its stylesheet takes fxbot's tokens and type. Its page code is written again, screen by screen, to the new navigation and rules. The parts fxbot gets from shadcn (a dialog, a menu, a picker with search, a sheet on a phone) are written by hand as browser scripts.

### How the dashboard is built today

The comparison rests on these facts, measured on 2026-11-10.

| Fact | Number |
| --- | --- |
| Page code (`src/control/ui/` and `src/control/dashboard/`) | 169 files, 33,769 lines: 38.8% of control |
| Its share of the work | 76% of the commits that touched control since 2026-11-01 touched page code, and 42% of all commits that touched code |
| Routes of the dashboard | 166. Its forms carry about 131 different actions of the owner |
| Actions with no API | 42 of its 90 form routes have no REST route. Providers, Git access, Machines, New campaign, Add a rig and a machine rig's buttons are among them |
| Reads with no API | The pages use 124 different calls of control's store; REST and MCP together use 48. "Needs you" exists only as HTML |
| Browser scripts | 3,429 lines of JavaScript kept as strings in 24 constants. No linter and no type check reads them. Four of them write a rule of control's a second time, for the browser |
| Styles | One string of 149 KB, written into every page, and 428 `style="…"` attributes (376 ten days before) |
| Parts | No shared button, input, table, tabs or dialog: each use is written out as markup. This is where the "many looks for one thing" come from |
| "No refresh" | After an action, the script fetches the whole page again and swaps its named regions. Every page draws every rig's view and the whole Needs you list, whatever it shows |
| Tests | 105 test files, 32,340 lines, hold dashboard HTML: a quarter of all tests. 9 acceptance scripts post the dashboard's forms, because their actions have no API |
| Docs | 111 of the site's 151 pages name a screen |

The faults that reached a release follow from this shape, not from carelessness:

- **A quote ended a string.** Settings › Retention could not save a policy, because an apostrophe in a sentence ended an attribute, and the form's script stopped (v0.1.4).
- **The page and control disagreed.** New campaign sent a field that control's check did not know, so no hill climb or goal campaign could start from the page (v0.1.4). Nothing held the script's request to the schema control reads.
- **A layout broke at one width.** A form drew one field over another at 820 and 1,150 pixels (v0.1.4). The stylesheet has 40 width rules at 10 different widths.
- **One number, two ways; a wrong word for a state.** The same figure is worked out, and the same state is worded, in each place that shows it.

### The comparison

| | A: the same system | B: the look alone |
| --- | --- | --- |
| What of fxbot is used | Its theme, its components, its frames, its provider pages and its registry | Its colour values and its patterns. None of its code: all of it is React |
| The two apps later | A new pattern in one is a file to copy to the other | Two systems that look alike, and drift |
| Dialog, menu, picker with search, tabs, sheet | Stock, with their keyboard and screen-reader behaviour | Written here, as more script in strings |
| The faults above | The first two can't happen in that form: text in a component can't end a string, and the page builds its request from the schema control checks. Layout faults drop with one set of parts and one scale of widths | All stay possible; the browser check finds them after the fact |
| One look for one thing | A component for each | B needs the same parts written as helpers first |
| Every action without the dashboard (goal [029](goals/029-api-mcp-coverage.goal)) | By structure: the app has no door but the API | Stays work of its own, and nothing holds it |
| Rules written twice | Once. Control checks; where a check as you type is wanted, the app reads the same schema | Stays |
| What a page costs | Files the browser keeps; data as JSON; changes over one stream | As today |
| Styles and the Content Security Policy (goal [177](goals/177-dashboard-styles-in-its-stylesheet.goal)) | Done by structure: a stylesheet file, no inline style | Stays work of its own |
| New things to carry | A build step for the app. About 15 packages, all for the browser or the build, none in control's process. A stage in control's image | None |
| The tests that hold HTML | They move to the API, where a later change of look can't break them. The browser check carries on | They change with the markup, and stay tied to it |
| Work | More. Every screen is built again, the API is completed, the tests move | Less at first |
| What it reverses | CONVENTIONS.md's rule for the dashboard, and the clean-up guide's answer on scripts as strings | Nothing |

### Chosen: A

The owner chose A on 2026-11-10. These were the reasons for the recommendation.

1. **It is what was asked for.** fxbot's system is its components and how they behave. They can't be used without their framework; B copies the colours and writes the rest again.
2. **The dashboard's faults come from how it is built.** A removes two of the four kinds by structure and shrinks the others.
3. **It finishes other goals on the way.** Goal 029 (every action in the API) and goal 177 (no inline style) become part of the build, and goal [089](goals/089-dashboard-performance.goal) (faster pages) gets its base.
4. **It puts the most-changed third of control behind one narrow interface.** Today a change to rigs' code touches page code 94 times in 100, and a change to an event's shape 86 times in 100 ([code structure guide](code-structure-guide.md)).
5. **The rule it reverses has been overtaken.** CONVENTIONS.md says "Frontend complexity grows faster than backend complexity, so resist it", and keeps the dashboard to "small client scripts". The scripts are no longer small: 3,429 lines and 131 actions. The complexity came anyway, without the tools that hold it. The rule's aim stays, as new limits on the app ([section 8](#8-how-the-web-app-is-built)).

**What A costs, and what keeps it safe.** The work is large. So the old dashboard stays whole and in use until the new one covers everything; each area gets its API first, with tests there; and each area is one goal that ends with its screens in the browser check and its docs pages written again.

**What B would have changed.** Sections 1 and 4 to 7 would stand: the findings, the rules for screens, the words, the navigation, the provider catalogue. Goal 243 would be "the stylesheet and the shared parts", goal 253 would have nothing to switch, goal 244 would not be forced by structure, and fxbot's provider pages would be built again, not taken.

## 4. The rules for screens

Every screen of the new dashboard follows these. They come from fxbot's habits and from the owner's standing rules for screens ([decisions](decisions.md#control-and-operation)). A mockup that breaks one says why.

**What a screen holds**

1. **One job for each screen,** and the job is the operator's ([the jobs](#the-operators-jobs)). A screen that serves two jobs is two screens, or tabs.
2. **One home for each fact.** Another screen that needs it shows one line and a link to its home. What needs the owner has one list; a run's cost has one place.
3. **One sentence at most under a heading, and one hint at most under a field.** No paragraph opens a page. How a thing works is a **Help** link to its docs page.
4. **A state is a badge,** from one component and one table of words. A banner is for one case: the screen itself can't work, and then the banner stands in place of what can't work.
5. **Nothing internal comes first.** A title is the thing's name in words. An ID can be copied (goal [094](goals/094-copy-id.goal)) but leads no line. Names of environment variables, tables and event codes show only under System.
6. **A tab or a block with nothing in it doesn't show,** unless the owner can add the first thing there.

**How things look**

7. **Type:** Geist, 14 pixels for nearly everything and 12 for captions, two weights, grey for what is secondary. Geist Mono for IDs, commands and terminals.
8. **Colour:** fxbot's greys. Colour means a state (four of them: good, needs you, wrong, at work), "this destroys something", a line in a chart, or a campaign's avatar. Nothing else.
9. **One main button on a screen,** dark, at the left of its row. An action that destroys is last, and asks for typed confirmation, as today.
10. **Borders, not shadows.** A card is a bordered block. Cards are not nested.
11. **Light and dark follow the operating system.**

**Where things are**

12. **Three widths.** A form, a settings page or a set-up step is one centred column of 576 pixels. A page to read (a run, a rig, Home) is one column of up to 1,024 pixels, with at most one panel beside it. A table or Live takes the width it needs.
13. **A list has one toolbar:** one line of search, dropdown filters whose choices show as chips that can be removed, a sort, and pages. The list is the first thing on its page.
14. **Adding and changing happen in a dialog or on a set-up page,** never in a form that is always open. A row's actions are in its menu, which a right-click also opens.
15. **A long form is split by what the owner came to do,** each part with its own **Save**. What a save changes is said before it, as Edit rig does today.
16. **Every screen works at 390 pixels wide.** The navigation becomes a sheet, a side panel becomes a sheet, a large dialog becomes the whole screen, and a table keeps its first columns and opens a row for the rest.

**What an action says**

17. **A decision shows what is decided, its evidence and what each choice does, wherever its buttons show.** A row in a list opens the decision; it doesn't decide in one click.
18. **A button says what it does** ("Make it the champion", not "Approve"), shows that it was pressed, and shows its result in place.
19. **A menu's items are words,** each with one line of what it does where that is not plain.
20. **Ready means it works.** A thing is shown as set up only after its check passed: a provider after its key was checked, a rig's model after the model check.

**Loading, nothing and errors**

21. **Nothing shows before it is whole;** after that, loading is one line of text. "Nothing here" is one sentence that says what to do. An error is control's own sentence, beside the thing that failed, with a way out.
22. **A screen stays current by itself.** No "page from 03:11 UTC" and no refresh link. When the stream to control drops, one line says so.

## 5. Hierarchy and words

### What owns what

```text
Thermite (one control)
├── Campaign, in a folder                 /campaigns/<campaign>
│   └── Run, on one rig                   /campaigns/<campaign>/runs/<run>
│       ├── Queue: experiments (hill climb, goal) or tasks (research)
│       ├── Lane › Trial                  one worker's line of work, one session at a time
│       ├── Attempt › Verdict             /campaigns/<campaign>/runs/<run>/attempts/<attempt>
│       │   └── Champion #n               an attempt the judge kept
│       ├── Research: Question › Answer; Hypothesis; Review
│       └── Notes                         the agents' field notes
├── Rig                                   /rigs/<rig>
│   ├── Core and runners
│   ├── Agents: workers, planner, advisors, each with a model
│   └── Rig checks
├── Machine: a computer, a cluster or a GPU cloud, where rigs run
├── Provider: a login for models; its models
├── Git access: a login for repositories
├── MCP server: tools for agents
├── Knowledge base › Collection (one for each campaign) › Run › Slot › Item
└── Records: reports, exports, logs, usage
```

A thing's address goes through what owns it, as CONVENTIONS.md says. Where a run ran is a fact about it, not its parent, so a run's Live is under its run.

### One word for each thing

Today's screens use the words on the left. The new screens use the one on the right, everywhere: screens, API, MCP and docs. These are the words the mockups use; the owner confirms each on the mockups ([question 6](#11-the-owners-questions)), and the [glossary](../_site/src/content/docs/reference/glossary.md), which holds several of the left-hand words as terms of their own, follows.

| Thing | Words today | The word |
| --- | --- | --- |
| Something waits for the owner | Needs you, Waiting for you, N decisions wait for you, Approval, Your decision, wait for you, Review (its button) | **Needs you**. A run keeps its own state, with a Needs you badge beside it |
| A run that works | Running, at work, Auditing | **Running**. "At work" is for a lane or an agent |
| A run that ended | Finished, Closed, Stopped, Completed, ended | The words of goal [099](goals/_completed/099-campaign-status-words.goal), each one meaning one way a run ended, from one table |
| A rig that reports, or does not | Live, live, reporting; Offline, Not reporting, stale | **Online**, **Late**, **Offline** |
| "Live" | A rig's state, a page, a button, the footer's mode, **watch** | **Live** is the page that shows agents at work. A link to it says **Watch** |
| Where a run started | the start, the starting point, baseline, where the run started | **Starting point** |
| A champion's number | champion #6, seq 6 | **Champion #6** |
| The agents that change code | lane-1, Worker · lane-1, Workers, agents | **Workers** for the role, **lane-1** for one line of work. One label, **Workers at a time**, on every form |
| A thing to try | Experiments, Tasks, the queue, Up next, Ideas | **Experiment** (hill climb, goal) or **Task** (research), in the run's **Queue**. A lane's suggestion is an **Idea** |
| One session of an agent | trial, try | **Trial** |
| One cycle of planning | round, epoch, plans, hand-out | **Round** |
| An instruction that stays in force | Rules, directive sets | **Rule** |
| A submitted change | attempt, change, candidate | **Attempt**. A sentence may say "the change" for the code inside it |
| The judge's result | Lost, Unclear, Broken; and regress, inconclusive, crash candidate, on the same screen | **Verdict**, in one set of words for people, from one table that maps the ledger's words |
| The store of what agents learned | Knowledge, Knowledge base, collection, corpus | **Knowledge base** › **Collection**, as settled on 2026-10-27. Never "corpus" |
| A stored thing | items, Records, Blurbs, Files | **Item** |
| The agents' notes | Journal, notes, Field notes, Notes | **Notes** |
| Tokens and cost | Model use, Stats, Agent figures | **Usage** |
| When a change becomes the champion | Promotion, promotion rule, and two sentences | **Promotion**: Automatic, or Ask me |
| "Audit" | The Audit log; the auditor's audit | **Logs** for who did what (goal [027](goals/027-logs-page.goal)). **Audit** is the auditor's alone |
| "Report" | A run's report; a rig's report to control | **Report** is what a run wrote. A rig was "last seen" |
| "Review" | A decision's button; the review panel's reviews; Review and start | **Review** is the review panel's alone |
| "Checks" | Rig checks; a goal's checks; rig-check campaigns | **Rig check**; **goal check** |
| A place where rigs run | Machines, Computers over SSH, Set up by you, The core | **Machine** |

## 6. The new navigation

The first mockups (goal 243) settle it. It follows the [jobs](#the-operators-jobs): what the operator works with comes first, and records come second.

### The left navigation

```text
Thermite                        [+ New campaign]

Home                        4   what needs you, what is at work, what happened
Live                            the agents at work, and a box to write to them
Rigs                        9

NEEDS YOU                       the things themselves, newest first
  decode-b: lane-1's change, +3.6%
  gpu-4 is offline

CAMPAIGNS                  [+]  folders, then campaigns; a right-click opens a campaign's menu
  decode-speed        Running
  opus-simd           Running

Library                         knowledge, reports, exports
Usage                           tokens and cost
Logs                            who did what, and control's own log
Settings
```

- **7 places and Settings,** where today there are 9, Settings behind an icon, 2 pages with no entry and a footer of 6 figures.
- **Needs you is a list in the navigation,** as "Waiting on you" is in fxbot's. It is the one signal of what waits. The other ten are removed.
- **The footer goes.** Its figures have homes: rigs on Rigs, what runs on Home, control's version in Settings. The page keeps itself current, so "page from" and "refresh" have no use.
- **Settings keeps the main navigation,** and has tabs of its own, as fxbot's has.

### A run

| Tab | Holds | From today's |
| --- | --- | --- |
| **Overview** | The sentence of state. What holds the run up, when nothing is at work (goal [072](goals/072-why-nothing-at-work.goal)). What needs the owner. The result: the chart and guards, the goals, or the questions. What each lane and the judge do now | Overview; the head above the tabs, without its cost cards |
| **Queue** | Up next, in progress, the lanes' ideas, tried. **Add** opens a dialog | Experiments or Tasks |
| **Results** | Champions and attempts in one table with filters. On a research run: answers, hypotheses and reviews | Attempts, Reviews, Hypotheses; Send champion from Planner; the Leaderboard |
| **Notes** | The agents' field notes, with filters | Journal |
| **Activity** | Everything that happened, with search, filters by who and kind, and days | History; "What the planner did" |
| **Setup** | What the run was started with (goal [090](goals/090-info-tab.goal)), its rules in force, its prompts, its usage | Info, Prompts, Stats, the rules of Planner |

- **6 tabs at most,** where there are 9 to 11; fewer when one has nothing.
- **The header is one line:** the run's name, its mode, its rig, its state. One main action that fits the state (Pause, or Resume), **Watch**, **Steer**, and a menu with words.
- **Steer is one panel** for the five surfaces of today: a message (to everyone, a lane or the planner), a rule, an experiment. It says in one line what each is for.

### A campaign, a rig, Settings

- **A campaign:** Runs (at work first, then earlier, in one table), Setup (its brief, contract, agents' context and additions), Reviews on a research campaign, and the Leaderboard where more than one rig ran it.
- **A rig:** Overview, **Agents** (each agent's model: what most visits are for), Settings (its parts, limits and promotion), Rig checks, Details. Edit rig as one page of 45 controls goes.
- **Settings:** Providers, Git access, Machines, MCP servers, Network, Knowledge base, Storage (what is kept, and the retention policies), Agents (each role and its texts), System (the message bus, control's health, versions).

### Where each page goes

| Today | In the new dashboard | Goal |
| --- | --- | --- |
| Overview | Home | [246](goals/246-home-and-decisions.goal) |
| A decision on 6 pages | Its one page, opened from Needs you | 246 |
| Campaigns | Campaigns: the table alone. Its "At work now" and "Waiting for you" are Home's | [247](goals/247-campaigns-and-runs.goal) |
| A campaign; a campaign with no run yet | A campaign: Runs, Setup | 247 |
| A run's 9 to 11 tabs | A run's 6 tabs and Steer | 247 |
| An attempt | An attempt, its title in words, its evidence inside the decision | 246 |
| Leaderboard (no entry) | A tab of its campaign | 247 |
| Live; a run's Live; a rig's Live; Everything | Live: one design, under its run or its rig, with the way back | [248](goals/248-live.goal) |
| New campaign; "the run is starting" | New campaign, as a set-up page with no navigation around it; what it needs is checked at the start | [249](goals/249-new-campaign.goal) |
| Start a run, Copy | Dialogs on the campaign | 249 |
| Rigs | Rigs | [250](goals/250-rigs-and-machines.goal) |
| A rig; Edit rig | A rig's 5 tabs | 250 |
| Add a rig; Launch on RunPod | Add a rig, as a set-up page; a machine can be added inside it | 250 |
| Settings › Machines | Settings › Machines | 250 |
| Knowledge; What's stored | Library › Knowledge; Settings › Storage | [251](goals/251-library.goal), [252](goals/252-usage-logs-settings.goal) |
| Reports | Library › Reports | 251 |
| Exports | Library › Exports (goal [109](goals/109-exports-page-shows-what-matters.goal)) | 251 |
| Metrics › Model use; Settings › Model prices; a run's Stats; a campaign's Model use | Usage | 252 |
| Metrics › Bus, Control, Storage, Rigs; Settings › Space, Retention, Message bus | Settings › System and Settings › Storage; a rig's figures on its Details | 252 |
| Audit log | Logs (goal [027](goals/027-logs-page.goal)) | 252 |
| Agents (no entry) | Settings › Agents | 252 |
| Settings › Providers | Settings › Providers, as a catalogue; Settings › Git access | [245](goals/245-providers-and-set-up.goal) |
| Settings › MCP servers, Addresses, Knowledge base | Settings › MCP servers, Network, Knowledge base | 252 |
| Sign in | Sign in | [243](goals/_completed/243-web-app-base.goal) |
| (none) | Set up Thermite, on a new control | 245 |

## 7. Providers and first-run set-up

The part the owner named. Goal [245](goals/245-providers-and-set-up.goal) builds it.

### Providers today

- **Five types, one form.** A provider is OpenAI-compatible, Anthropic, OpenCode, a Claude subscription or a ChatGPT subscription. The first three share one form with a **Type** list, a base URL and a key. Git access is in the same list.
- **The owner must know each address by heart.** Thermite knows three. OpenAI's own API has no entry: it is "OpenAI-compatible" with an address typed in.
- **No link to where a key is made,** and no steps.
- **"Checked" means the model list answered.** A provider is saved even when its list fails. A wrong key at a provider whose list is public passes.
- **The real test is later and somewhere else:** a rig's model check, after the model is chosen on Edit rig. A wrong Claude token, a model with no tool calls and a server Codex can't use all show only there. Connecting a model and giving it to agents takes 2 areas and about 8 screens.
- **No API.** No REST route adds, changes or removes a provider or a Git access; MCP only reads them.
- **Nothing on a new control says to start here.**

### What changes for the owner

1. **Add provider opens a catalogue:** search, then tiles in groups.
   - **Sign in:** ChatGPT and Codex; a Claude subscription; OpenRouter.
   - **Use a key:** OpenAI, Anthropic, Google Gemini, OpenRouter, DeepSeek, Z.ai, Qwen, Kimi, xAI, Mistral, Groq and the other gateways of fxbot's list.
   - **Your own server:** vLLM, llama.cpp, Ollama, LM Studio, LiteLLM.
   - **Custom:** any server that speaks OpenAI's API.
2. **A provider's card:** its logo and one line, what it costs to begin, **Help**, then its sign-in or its key form. The key form is the steps at the provider's own key page, the key, and **Add**.
3. **Add checks the key with the provider.** A bad key is refused in words ("Groq rejected this key: it's wrong, or it was deleted"), and nothing is saved.
4. **Then the model, and who gets it:** a picker with search, with what each model can do (its context, whether it calls tools), and **Give it to** a rig's agents. The rig's model check runs, and its result shows in place. This is the step that says the provider works.
5. **A provider's row** says its state (Key saved, Signed in, or what is wrong), a plan's usage, which rigs' agents use it, and its actions: Replace key or Sign in again, Refresh models, Remove.
6. **Git access has its own tab,** with the same kind of card: the steps at GitHub or GitLab, then the key or token, then **Try it on a repository**.

### The registry

- **A list of providers as data,** in `src/core`, taken from fxbot's `providers-registry.json`: each entry's name, one line, group, address, key page, steps, how to check a key, and its quirks.
- **A catalogue entry is a preset, not a new type.** Each maps to one of the five types rigs know today, nearly all to OpenAI-compatible. So no contract between control and rigs changes, and a rig of an older version works with a provider added from the catalogue.
- **Thermite adds what its agents need to know:** whether the server answers OpenAI's Responses API (Codex needs it), and which agent programs can use the entry. Edit rig then offers only the pairs that work, where today a wrong pair shows as an error on save.
- **What a model can do** (its context, tool calls) comes from a copy of [models.dev](https://models.dev)'s list taken when a release is built.
- **Shipped with the release.** Control fetches no list while it runs ([question 8](#11-the-owners-questions)).

### The ways in

| Way | Providers | Today | In v0.3.0 |
| --- | --- | --- | --- |
| A key, checked | About 20 gateways, OpenAI, Anthropic | One generic form; the list is the check | A card with steps; a real check; nothing saved on a refusal |
| A pasted token | A Claude subscription. Anthropic allows no sign-in from another app | The token's first letters are the only check | The same paste. The card says the rig's images need Claude Code. The first check is the rig's model check, run from the card. The token's year is counted |
| A sign-in with an address pasted back | ChatGPT and Codex | Works; a sign-in under way is lost when control restarts | The same flow in the sign-in panel, with its states (waiting, expired, failed) and kept through a restart. A device code in its place, if OpenAI gives Thermite's own app one: not known yet |
| A sign-in that comes back by itself | OpenRouter | None | fxbot's own code (28 lines). It gives a plain key |
| A device code | Hugging Face, OrcaRouter | None | After v0.3.0: each needs an app registered for Thermite |
| A plan's sign-in through libfx | Grok, Vercel | None | Not taken: libfx's tokens are for libfx's own agent |
| A cloud's own sign-in | Vertex AI, Bedrock, Azure, Cloudflare | None | After v0.3.0: each signs its calls in a way the rigs' model proxy and the agent programs don't know |
| An address | Your own server, Custom | A key is asked for even when the server takes none | The key is optional. See below |

### "Your own server" has three meanings

fxbot looks for a model server on the machine it runs on. Thermite has three machines: the owner's browser, control, and each rig.

- **A server control can reach** is listed and checked by control, as today.
- **A server only a rig can reach** (on the rig's own machine, the common case for a GPU box) can't be listed by control today, and the owner types its models by name. New in goal 245: control asks the rig to read the server's model list, and the card shows it.
- **A server on a private network** needs its address in Settings › Network before a cluster rig's harness may reach it. The card says so, with the link.

### The API

Every action of the catalogue has its REST route and its MCP tool, and the app uses the REST routes alone. The routes have the shapes of fxbot's, so its two provider pages come over with small edits: the providers and the catalogue, add, change and remove (never a secret in an answer), a provider's models, and a sign-in's start, state, pasted code and cancel. Git access gets the same.

### Set up Thermite

A new control opens on a set-up page with no navigation around it, as fxbot does. Thermite's has two more halves than fxbot's: a model is of no use until a rig's agents have it and the model check passes.

1. **Connect a model:** the catalogue, in the page.
2. **Your rig:** the rig of a one-machine install reports by itself; the step shows it and its checks. With no rig, **Add a rig**.
3. **Give its agents the model:** the model check runs. It passes, or says why not.
4. **Run the sample campaign,** or **New campaign**. Set-up ends on the run's page.

- **Skip for now** is on every step, and skips that step alone. A judge needs no model, so a run with no agents works with steps 1 and 3 skipped.
- **The step is kept on control,** so a restart or another browser lands in the same place. A control that already has a provider, a rig or a campaign never sees set-up.
- **The tutorials follow the same steps,** and the quick-start check drives them.

## 8. How the web app is built

Goal [243](goals/_completed/243-web-app-base.goal) builds this base.

### Where it lives, and what it may import

- **`web/`, at the repository's root:** a Node project of its own, with its own `package.json`, lockfile and TypeScript settings, as `docs/_site/` is. `src/` stays one TypeScript project for Node, with no browser types, and the harness's and the supervisor's images carry nothing of the app.
- **It imports one thing of Thermite's: the contracts in `src/core`.** Control's routes are already data there (`src/core/api/control/`): a method, a path and a schema for the body and the answer. The app's client calls a route and gets its answer typed, as the command line's client does.
- **`npm run check:imports` holds it:** the app imports only `core`, and only modules of `core` that use nothing of Node; nothing in `src/` imports the app.

### What the app may hold

The new form of "resist frontend complexity":

- **No rule of the product.** Control checks, refuses and words; the app shows. A check as the owner types reads the same schema, never a second copy of a rule.
- **No words for states, verdicts or events.** They come from control with the data, the same for REST, MCP and the app ([code structure guide](code-structure-guide.md)).
- **Stock components.** shadcn's, made by its tool and not edited. Thermite's own parts (the state badge, the list toolbar, a tile, the decision card, the timeline, the step chart, the transcript, a terminal) are few, and each is used on more than one screen.
- **No router, data, state or form library at the start,** as fxbot has none. One is added at its second real use, with its reason in CREDITS.md.
- **A size it says.** Each goal says what it adds to what the browser loads.

### Sign-in, the API and the stream

- **The owner signs in as today,** and the session's cookie counts for `/v1` too. A change is sent with the session's token in a header, checked as the forms' token is today. The audit log still says `owner:ui`.
- **Reads are JSON from `/v1`.** Where a page's read has no route today (Needs you, the list of campaigns, providers, machines), goal [244](goals/244-one-door.goal) and each area's goal add it.
- **One stream of changes,** Server-Sent Events as [decided](decisions.md#rigs-and-deployment) on 2026-10-27: control says what changed (what needs you, a run, a rig), and the app reads that thing again. Live's lines come as data, not as HTML; a terminal's frames come as today.

### Build, delivery and the policy

- **Vite builds the app to static files.** Control serves them, and answers any path that is not the API with the app. Control's image gains one build stage; the release bundle needs no change.
- **The Content Security Policy** allows scripts, styles, fonts and images from control alone, with no inline style: goal 177's end.
- **Tests of control need no build:** they use the API. The browser check builds the app first. For work on a screen, Vite's own server shows each change at once, against control on the demo's data.

### Mockups are screens

A screen's mockup is the real component on the demo's data, at an address that only a development build has, with switches for its states. The owner opens it in a browser, at each width, light and dark. What was approved is what ships, and no mockup is written twice.

### Checks

- **The type check and the linter read the app,** which they can't do for today's scripts.
- **The browser check** opens every kind of screen at 1,440, 820 and 390 pixels, light and dark, and fails as today on an error in the console, a request that fails, a page wider than its window, controls on top of each other and text cut off. Each area adds its flows.
- **The API's tests** take over what the 105 HTML-reading test files check of control's behaviour.
- **The docs:** each area's goal writes again the pages that describe its screens, and their screenshots come from the browser check's own captures.

## 9. The order of work

Each line is a goal. Each ends with the system working, the old dashboard whole, and nothing left for a later pass.

1. **The owner's answers** to [section 11](#11-the-owners-questions) (goal 242). Done, 2026-11-10.
2. **The base** (goal 243): the app, its shell and navigation, sign-in, the client and the stream, the build into control's image, the browser check on it. Its first three screens are the first mockups: Home, a run's Overview and the frame of Settings.
3. **One door** (goal [244](goals/244-one-door.goal)), beside the base: the reads every screen needs (Needs you as data, campaigns, the words), and the way an action is written once for REST and MCP.
4. **Providers and set-up** (goal 245): the first whole area, and the one the owner named. It stands nearly alone, so it proves the way of working.
5. **Home and decisions** (goal 246).
6. **Campaigns and runs** (goal 247), **Live** (goal 248), **New campaign** (goal 249).
7. **Rigs and machines** (goal 250).
8. **Library** (goal 251); **Usage, Logs and the rest of Settings** (goal 252).
9. **The switch** (goal [253](goals/253-the-switch.goal)): the new dashboard alone. The old page code and its tests are removed, the conventions are updated, and every docs page and screenshot matches.

**Each area's goal has the same five steps:** its mockups, approved; its API, with tests there; its screens; its cases in the browser check; its docs pages.

**While the work goes on:**

- The new dashboard is at `/next`, and the old one stays where it is, whole, until the switch. A running campaign is never without its screens.
- From the day goal 243 starts, the old pages take fixes only. A new screen is built in the new dashboard, or waits.
- The goals of v0.3.0 that are one screen each are built inside their area's goal ([release plan](release-v0.3.0.md)).

## 10. What to leave

- **The Overview's order, the decision card, the timeline and the sentences of state** ([what works](#what-works-and-stays)). They move; they are not thought out again.
- **The sentences themselves.** The words modules (`src/control/ui/words/`, 1,348 lines) turn events and states into plain sentences, and they are right. They move out of page code; they are not rewritten.
- **The demo's data** (`tests/helpers/demo/`). It seeds control through its store, with no HTML, so the browser check and the mockups stand on it as it is.
- **The browser check** (goal 239), which gains screens and widths.
- **Server-Sent Events,** and the terminals' frames and keys.
- **Typed confirmation** for Close run, Full reset and Retire.
- **One role, the owner,** until goal [030](goals/030-oauth-sign-in.goal).
- **No theme switch, no motion for its own sake, no component layer of our own over shadcn's, no second language.** Nobody asked for them.
- **"The page works without its script"** does not carry over: an app is its script. The API is what works without the dashboard.

## 11. The owner's questions

The owner answered these on 2026-11-10: every recommendation below is taken. Where a question is about a look (3, 6 and 12), the recommendation is what is mocked first, and the owner chooses from the mockups. The answers are goal 242's decisions, and those that shape the product are in [decisions.md](decisions.md).

1. **The design: A, the same system, or B, the look alone?** ([Section 3](#3-how-thermite-uses-it-two-designs).)
   - **Recommended:** A. It changes CONVENTIONS.md's rule for the dashboard.
   - **Instead:** B, with what section 3 says changes.
2. **Where a field's description goes.** The rule of 2026-10-17 gives every label an icon to hover. fxbot gives a field one hint sentence under it, and no icon.
   - **Recommended:** a hint under the field in forms. An icon stays only on a column or a figure whose meaning is not plain. "Every form label has a description" stays true.
   - **Why:** 19 icons on one screen read as noise, and a hint needs no hover, which a phone doesn't have.
   - **Instead:** keep the icon on every label.
3. **The navigation:** the 7 places of [section 6](#6-the-new-navigation), with Library, Usage and Logs as rows with words; or those three as icons at the foot, as fxbot has them.
   - **Recommended:** rows with words; both are mocked.
4. **Machines.** They stay in Settings (the owner, 2026-11-04), and Add a rig can add one without leaving; or they move under Rigs.
   - **Recommended:** they stay, with the add inside Add a rig.
5. **Git access** gets its own tab in Settings, apart from the providers of models.
   - **Recommended:** yes. Both are logins, but the catalogue is about models.
6. **The words** of [section 5](#one-word-for-each-thing): each row, yes or another word.
7. **Light and dark by the operating system,** with four colours for states and no other colour.
   - **Recommended:** yes, as fxbot.
8. **The registry of providers:** shipped with each release; or also read again from the site every hour, as fxbot does, so a moved key page needs no release.
   - **Recommended:** shipped. Control makes no new call outward, and a lab with no way out works the same. fxbot's file is the source: Thermite's copy is made from it when a release is built.
9. **Providers' logos.** fxbot ships 183. Each is its owner's mark; their icon sets say MIT in fxbot's comments, which is not yet checked, and one is a picture from a provider's site.
   - **Recommended:** ship the logos whose licence is checked and credited in CREDITS.md; the first letter for the rest.
   - **Instead:** letters for all.
10. **Which sign-ins in v0.3.0:** a Claude subscription and ChatGPT as today, in the new card; OpenRouter new. Hugging Face and OrcaRouter after it; Grok, Vercel and the clouds not planned.
    - **Recommended:** as written. Each later one is a goal of its own, with the question "is this account for the owner's own Thermite only" answered first, as for subscriptions.
11. **Set up Thermite** shows on a new control, and never on one that has a provider, a rig or a campaign.
    - **Recommended:** yes.
12. **A run's page:** the 6 tabs and the Steer panel of section 6, from mockups.
13. **A phone.** Every screen works at 390 pixels, so a decision can be made from a phone; or 820 pixels stays the narrowest width checked.
    - **Recommended:** 390, for every screen.
14. **While the work goes on,** the new dashboard is at `/next` and the old one takes fixes only.
    - **Recommended:** yes.
