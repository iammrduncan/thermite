# Settled decisions

Decisions that shape the whole product, newest last in each section. A decision about one piece of work is in that work's goal. [How Thermite is planned](README.md) says how a new decision is recorded.

## The product

| Date | Decision |
| --- | --- |
| 2026-10-14 | TypeScript wherever possible, on Node.js LTS. Another language only where a target project's own tooling needs it, such as a measurement script in a kit. |
| 2026-10-14 | MIT license. |
| 2026-10-14 | Three campaign modes: hill climb, goal and research. |
| 2026-10-14 | SQLite stores, one for each harness and one for control, and a single control replica. |
| 2026-10-15 | The names: a **rig** is one judge, its agents and a supervisor on a set of devices, and a machine can host several rigs. A **run** is one campaign on one rig from one starting point. The hierarchy is Campaign ▸ Run ▸ Lane ▸ Trial ▸ Attempt. |
| 2026-10-18 | Thermite is for one researcher or one lab. It is not a multi-tenant service. |
| 2026-10-26 | NATS JetStream is the event log, the delivery and the queues between control, the rigs' supervisors and the dashboard (goal [168](goals/168-message-bus.goal)). Subjects follow the hierarchy of runs and rigs; only control and the supervisors hold bus credentials; every record a rig publishes keeps the harness's signature inside it. A rig's ledger stays its record, and JetStream holds control's one copy of it; record streams refuse deletes. The harness and the agents stay off the bus, bridged by the supervisor; kits and large files stay on git and HTTP. A RunPod rig is reached by control dialing a leaf node in its pod. |
| 2026-10-26 | The code's parts (control, the harness, the supervisor, the command line, the release tools) import only `core`, which holds contracts, and `common`, which holds runtime tools, never each other. The agent runtimes that the workers and the advisors share are a part of their own, `src/agents/`. A check in `npm run check` enforces it (goal [125](goals/125-code-to-the-conventions.goal)). |

## Research and judging

| Date | Decision |
| --- | --- |
| 2026-10-14 | Agents never judge. Measurement, completion and promotion live in code that the agents cannot write. |
| 2026-10-14 | The harness owns all research state. Every agent call starts fresh from context the harness builds. Parallel workers are isolated, and a central, stateless planner assigns their experiments. |
| 2026-10-14 | The judge measures on a device first, and agents use it the rest of the time. Dedicated devices for each are configuration. |
| 2026-10-15 | Replaced on 2026-10-22 by hands-off promotion, below. Was: a confirmed win promotes on its own when no audit holds it; a gain above the contract's absolute audit trigger (15% by default) waits for the owner after its audit. |
| 2026-10-15 | No default caps. Nothing ends or cuts research short by default: no turn, submission, failure or wall-time limit. A campaign runs until its goals are met. A cap exists only when someone configures it. |
| 2026-10-15 | Files that a kit lists in `run.copy` are copied fresh into every run, owned by the judge and read-only to the run. |
| 2026-10-16 | No default time limit for a single command. A lane's processes live for the whole trial. |
| 2026-10-16 | Kits order their verifiers and gate expensive ones on cheap prerequisites (`priority` and `requires`). |
| 2026-10-17 | Test cases fit any kind of project. A case is a name and what makes it different. The score is a run's time, a rate, or a number that the check reports. |
| 2026-10-17 | A "hidden test" is a case the judge uses only to confirm a change that already looks better, never while it screens. |
| 2026-10-18 | A rig is a set of GPUs. Judge GPUs and agent GPUs are pools, and the split is set where a campaign is deployed. |
| 2026-10-20 | Each run has one experiment queue: the experiments still to try, in order, and a log of those tried, with their results. The planner coordinates it: it gives lanes work that does not overlap. The planner, the advisors and the owner add and reorder experiments; workers propose ideas for the planner to queue. Rules for the plan are set on the run's Planner tab. |
| 2026-10-20 | Every agent writes a journal and research notes. Thermite keeps its own knowledge base: each campaign has a folder with everything its runs produce, and reads other campaigns' folders only when the owner grants it. An outside knowledge base (such as GBrain) is optional: a sync target and a source of outside context. |
| 2026-10-27 | The knowledge base lives on control, with all its storage and search indexes: one collection for each campaign, then runs, then slots, then items. Every agent reads it over MCP; the roles a campaign lets write each write into their own slot and never change another writer's items. An item is a blurb or a file (a reference an agent downloaded, or a doc an agent wrote). Writes arrive as durable events on NATS. A run continues its campaign's collection or starts fresh; other campaigns' collections are read only, by grant. ([175](goals/175-knowledge-base.goal)) |
| 2026-10-19 | Research workers search all of a run's research and write files. The harness builds a research folder from its records (read-only to workers), and each lane keeps a working area across its trials; the other lanes see a lane's files when its trial ends. A research run's output is its report plus the whole folder. Findings carry a summary and why they matter, and code checks them against verified claims. ([062](goals/_completed/062-research-folder.goal)) |
| 2026-10-22 | Hands-off by default; the owner is asked only where they set it. A win the judge confirms is promoted with no owner step, in every mode; an auditor, when one is set up, is the last step, and its block stops the win and says why. Built-in owner gates (a gain above the audit trigger, declared flaws) ask the owner only when the campaign is set to ask. The owner's words: "The system is supposed to be hands off for me. Theres no need for me to step in an confirm every win... cause thats why we have judges and auditors... I shouldn't ahve to do anything (Unless I set it to ask me) by default it should auto... research..." ([079](goals/_completed/079-thermite-overhead.goal)) |
| 2026-10-22 | The model provider decides when agents can work: its errors are sorted by kind. A rate limit waits for its time; no credits, a refused key or a failing model check stops the run's agents and asks the owner, with the provider's words; a passing fault backs off. A research run's clock stops while its agents cannot run. ([079](goals/_completed/079-thermite-overhead.goal)) |
| 2026-10-25 | Lanes may keep working while the judge works: a campaign's setting (`lanes.keep_working`), off by default, which a run turns on and off with a rule. On, a lane's next trial starts when its last one ends and a round ends when its trials end; `budget.max_open_attempts` bounds the changes waiting for the judge. Off, lanes wait for the judge's verdicts. The judge should work in parallel where it can, and a change written on an older champion is carried to the new one ([135](goals/_completed/135-lanes-and-judge-throughput.goal)). |
| 2026-10-25 | No lane sits idle behind another lane's trial: a round ends once every free lane has run its trials, and a lane still on a trial joins the next round. A run that waits for verdicts still waits for the judge ([goal 136](goals/136-no-idle-lanes.goal)). |

## Rigs and deployment

| Date | Decision |
| --- | --- |
| 2026-10-14 | A rig is a harness container and a supervisor container. Everything runs on Kubernetes or under docker-compose or podman-compose. |
| 2026-10-14 | The harness reaches only DNS, the internet and its model endpoint. The supervisor reaches the internet, its harness, control and, optionally, a knowledge base. The supervisor does all git operations. |
| 2026-10-14 | One central control service, with a dashboard, an API and MCP. Supervisors report to it, and it can pause, reset and assign rigs. |
| 2026-10-14 | Each project has its own results repository. The project's key is read-only. |
| 2026-10-16 | Thermite is self-contained. Campaigns, kits and rigs are managed through control. Infrastructure belongs to whoever runs it. |
| 2026-10-17 | Control sets rigs up itself. Given an SSH key or a kubeconfig, it checks the place, installs what is missing (only when the owner says yes), deploys the rig and manages it. Rigs still report by dialing out. |
| 2026-10-18 | Control refuses a pre-made Kubernetes slot whose network rules do not keep the harness off the cluster. "Join a rig yourself" is an optional third way to add a rig. |
| 2026-10-27 | A rig on a machine or a cluster reaches control's NATS server on NATS's own port, over TLS (a second port beside control's HTTPS), with a key the rig's supervisor made and registered over HTTPS; control keeps the server's users file. Secrets go to a rig sealed to its own key, only when they change. The dashboard's push is Server-Sent Events from control. ([168](goals/168-message-bus.goal)) |
| 2026-10-29 | Replaced in part on 2026-10-30 by "bus only", below: rigs no longer report over HTTP. Was: control needs its NATS server once its own copy of the rigs' events moves to JetStream (goal [168](goals/168-message-bus.goal)): rigs may still report over HTTP, and control publishes their events. Control's table of commands stays as its own signed record; JetStream snapshots back the streams up. |
| 2026-10-30 | Bus only. A rig and control talk only over NATS: its reports, commands, config, live view and knowledge base. A rig that can't reach the bus doesn't work and is shown as broken. HTTPS keeps only a rig's first registration of its keys and the large files (kits, exports, bundles) that stay on git and HTTP. A RunPod rig joins the bus through the leaf node in its pod. The owner's words: "NATS is the only supported way. Bus only. If bus doesn't work RIG doesn't work and is considered broken." ([168](goals/168-message-bus.goal)) |
| 2026-10-30 | Control keeps a list of addresses and ports that cluster rigs' harnesses may reach beside the internet, set by the owner. Control writes it into each rig's network rules, and it accepts a pre-made slot whose rules open exactly listed addresses and ports. ([172](goals/172-build-v011.goal)) |

## Providers and models

| Date | Decision |
| --- | --- |
| 2026-10-17 | A model provider is entered once: name, type, base URL and key. Its models are listed from the provider. Keys are sealed and sent only to the rigs that use them. |
| 2026-10-17 | Each rig picks its worker harness and its model as two separate choices. |
| 2026-10-18 | Each agent role (the planner, the workers and each advisor) can have its own model and effort. |
| 2026-10-18 | A Claude subscription runs only inside Claude Code, never in another program. Its token goes in Claude Code's environment. Claude Code is in an image only when the image is built with that option. |
| 2026-10-18 | ChatGPT works through Sign in with ChatGPT. Control keeps the refresh token sealed and is the only one that renews it. Rigs get one-hour access tokens. |
| 2026-10-18 | At a subscription's usage limit, agents wait for the reset. They never use paid credits. |
| 2026-10-18 | A subscription serves only its owner's own Thermite. A Thermite that several people use takes API keys. |
| 2026-10-20 | MCP servers are added once in Settings, with OAuth, a key, a client ID and secret, or no sign-in, sealed as keys are. A campaign's kit names the servers its agents use and which agents get each one. Control gives a rig only the servers its runs name; the harness makes the calls for workers and the planner, the supervisor for the advisors, and the secret stays in their memory. This replaces the outside knowledge base of 065: GBrain is an ordinary MCP server. ([068](goals/_completed/068-mcp-servers-for-agents.goal)) |

## Control and operation

| Date | Decision |
| --- | --- |
| 2026-10-16 | The dashboard is for a human operator. Every decision it asks for shows what is decided and what each choice does. |
| 2026-10-16 | Screens are chosen from mockups. Every form label has a description. |
| 2026-10-16 | Campaigns are operated only through control: the dashboard, REST, MCP or the CLI. |
| 2026-10-16 | The owner mints the admin token, and control keeps only its hash. An operator token lets agents assign, pause, resume, redirect, reset, export and message agents. Approvals, audits and reviews stay the owner's. |
| 2026-10-18 | Cards, call-outs and reports are written in Simplified Technical English. |

## Releases and planning

| Date | Decision |
| --- | --- |
| 2026-10-14 | Agents commit on branches. The maintainers push. |
| 2026-10-18 | The history was rewritten once, before the first public push. |
| 2026-10-19 | The first public release is v0.1.0. It holds the tester basics, published images and rigs on RunPod. The code moves to `main` only as the last step before it. |
| 2026-10-19 | Advisors have no default spend limit. |
| 2026-10-19 | The plans are public, in `docs/plan/`. Each roadmap item has a goal. A new idea becomes a new goal and goes into the roadmap by priority. |
| 2026-10-19 | The documentation is a site built with Astro Starlight from `docs/_site/` and arranged by Diátaxis: tutorials, how-to guides, reference and explanation. It is written for an average person, and agents read it through `llms.txt` and `llms-full.txt`. Repository docs stay in `docs/`. |
| 2026-10-20 | The documentation site is served at usethermite.com by Cloudflare Pages, built from `main`. The code moved to `main` early, for the site; work stays on the development branch, and `main` follows it. |
| 2026-10-24 | v0.1.0 does not ship without research mode, and it does not ship until research mode is solid (goal 117). |
| 2026-10-25 | v0.1.0's scope is frozen: it ships what is on `main`. A goal whose code is on `main` and whose only open item is a check on the lab doesn't hold the tag. Anything new goes into a later version. The list of what is left is in the [release plan](release-v0.1.0.md#what-is-left-before-the-tag). |
| 2026-10-24 | The development branch `v1/build` is retired: until v0.1.0 ships, the work happens on `main`. After it, each version is built on a branch named for it (`v0.1.1`, `v0.1.2` and so on), which merges into `main` when the version ships. The branch is deleted before the version's tag is made, so that a branch and a tag never share a name. `main`, and the docs site built from it, then show what is released. |
| 2026-10-26 | v0.1.1 breaks compatibility with v0.1.0, for the clean-up (goal [125](goals/125-code-to-the-conventions.goal)). It doesn't have to read data that v0.1.0 wrote, or work with v0.1.0's control, harness or supervisor, and names change to the public ones everywhere, the stored and wire names included. A ledger or database that v0.1.1 can't read is kept, never deleted, and the changelog says what an upgrade from v0.1.0 needs. |
