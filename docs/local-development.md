# Contributor guide: running Thermite locally

This is the guide for people working on Thermite itself: the checks, the compose stack you develop against, the dashboard demo and the acceptance tests. [CONTRIBUTING.md](../CONTRIBUTING.md) has the essentials: the terms, how to send a change and the rules every change keeps. [CONVENTIONS.md](../CONVENTIONS.md) has the design rules that every review checks. To **use** Thermite, start with the documentation site: [Your first run](_site/src/content/docs/tutorials/first-run.md), then the [how-to guides](_site/src/content/docs/how-to/install/one-machine.md).

Thermite runs the same images under docker-compose, podman-compose and Kubernetes. Locally, one compose stack starts the control service and one rig (a harness and a supervisor), with the CPU target.

## Requirements

- Node.js 22.19 or later, for the checks and the command line (the agent libraries require it); 22.22 or later to build the documentation site (Astro requires it).
- Docker with Compose, or Podman with `podman compose` or podman-compose. Not `docker-compose` 1.x, the old Compose v1: it can't read `compose.yaml`, and `podman compose` uses it first when it is installed. [Troubleshoot](_site/src/content/docs/how-to/operate/troubleshoot.md#compose-wont-start-name-does-not-match-any-of-the-regexes) says how to replace it.

## Checks

```sh
npm ci
npm run check            # typecheck, lint, tests, public-content check, size and import checks
```

CI (`.github/workflows/ci.yml`) runs on every pull request, every push to `main` and to a version's branch (such as `v0.1.1`), and every version tag, once a maintainer approves the run: its first job, **approval**, deploys to the repository's environment `ci`, whose required reviewers approve it, and every other job waits for it. Then its fast jobs run at once. It runs the same checks on Node 22 and 24, with the judge's tests in jobs of their own, builds and checks the documentation site, and scans the whole history for secrets with gitleaks (the allowlists for made-up keys are in `.gitleaks.toml`). The heavy jobs, the compose smoke test, the rig image, RunPod and [the quick-start test](#the-quick-start-test), wait only for a short job, **heavy checks, needed?**, that decides which of them run: on a push or a pull request, those whose paths the change touches; on a version tag, a run by hand, a new branch or a rewritten history, all of them. [What CI runs](_site/src/content/docs/project/contributing.md#what-ci-runs) describes each job, and [AGENTS.md](../AGENTS.md#checks) lists every check and when each one is needed.

**Tests that need a judge.** Many tests need judged attempts, not the judge's timing: the scheduler's, the advisors', control's. The judge's test harness (`tests/helpers/judge-env.ts`, `makeJudgeEnv`) gives them the real judge with a stand-in runner: a run of the test kit's driver on one of its stock kernels (`SEED_KERNEL`, `FAST_KERNEL`, `WRONG_KERNEL`, `CRASH_KERNEL`), and the kit's check of it, are answered in the test's own process, with the result file the run would write and a wall time from a model of the kernel. The judge's statistics, verdicts and records stay the real judge's; a build, another kernel or a kit's own run or check script runs for real. The judge's own tests ask for real runs (`realRuns: true`), because they test its timing.

The documentation site has its own build and checks: see [Writing the documentation](writing-docs.md).

## The compose stack, built from source

Users install Thermite from a release: its `compose.yaml` runs the published images, and nothing is built ([Install Thermite on one machine](_site/src/content/docs/how-to/install/one-machine.md)). To work on Thermite, build the images from your clone instead. The repository's own `compose.yaml` does that:

```sh
git clone https://github.com/iammrduncan/thermite.git
cd thermite
npm ci
npm run dev:init         # writes local tokens to .dev/ (git-ignored)
npm run build            # the command line on your computer: npx thermite
docker compose up -d --build     # or: podman compose up -d --build
```

- `npm run dev:init` needs only Node.js, not `npm ci`. It writes the same `.dev/` folder as a release's `init` service (`thermite local init`), and keeps every file that exists. A unit test (`tests/cli/local-init.test.ts`) checks that both make the same files and modes.
- Each rig's token for control (`.dev/secrets/control-rig-token`, `control-rig-token-2`) starts empty. At each `up`, the `enroll` service (`enroll-2` with the `two-rigs` profile) enrolls the rig with control once control answers, and writes the token control made there before the supervisor starts (`thermite local enroll`). A token written before is kept while control has the rig enrolled; after `docker compose down -v`, the next `up` enrolls the rigs again. Control reads no file of rig tokens.
- If `up` stops with `'name' does not match any of the regexes: '^x-'`, the compose program is the old Compose v1: [replace it](_site/src/content/docs/how-to/operate/troubleshoot.md#compose-wont-start-name-does-not-match-any-of-the-regexes).
- The first build takes 20 minutes or more; later starts take seconds. After `git pull`, run `npm run dev:init` and `docker compose up -d --build` again.
- `THERMITE_COMMIT=$(git rev-parse HEAD) docker compose build` gives the images their commit, which each service reports.
- On a Linux machine with NVIDIA GPUs and NVIDIA's container toolkit, `npx thermite local init .dev` (after `npm run build`) also writes `compose.gpu.yaml`, which builds the harness on the CUDA base as `thermite-harness:local-cuda` and gives it every GPU. Name it in every `up --build`: `docker compose -f compose.yaml -f compose.gpu.yaml up -d --build`. The CUDA base is a large download. `npm run dev:init` doesn't write it ([What the rig gets](_site/src/content/docs/how-to/install/one-machine.md#what-the-rig-gets)).
- With Claude Code in the images (`compose.claude.yaml`, from [Use a Claude subscription](_site/src/content/docs/how-to/models/claude-subscription.md)), name that file in every `up --build`.

The stack, its settings and how to operate it are described on the site:

- what each container is, its volumes and how to keep it running: [Install Thermite on one machine](_site/src/content/docs/how-to/install/one-machine.md);
- every setting: [Settings](_site/src/content/docs/reference/settings.md);
- models, advisors, the results repository, keys, tokens, restarts and resets: the [how-to guides](_site/src/content/docs/how-to/operate/check-a-rig.md);
- MCP and the REST API: [Let an agent run Thermite over MCP](_site/src/content/docs/how-to/automate/agent-over-mcp.md) and [Script Thermite with the REST API](_site/src/content/docs/how-to/automate/rest-api.md);
- the command line: [Command line](_site/src/content/docs/reference/command-line.md).

The `two-rigs` profile adds a second rig (`local-2`), which the control and steering acceptance tests use. The stack always runs the message bus, a NATS server with JetStream (`nats`): the supervisors send their reports and live lines over it and control reads them from it, and control sends its commands and each rig's config over it and the supervisors take them from it. Each connects over TLS, trusting control's own certificate authority, and signs in with its own key: control writes the server's users, certificate and key to the `nats-config` volume, and the server waits for them before it starts ([The compose file](_site/src/content/docs/reference/settings.md#the-compose-file)). A rig reaches control only on the bus, and nothing in `.env` turns the stack's rigs off it ([Run the message bus](_site/src/content/docs/how-to/operate/message-bus.md)). `compose.lifecycle.yaml` lets control restart containers through the engine's socket; it is for development only.

`compose.yaml` passes the optional settings through from your shell or `.env`, each with its default. That includes the knowledge base's timer, `THERMITE_KB_SYNC_SECONDS`, for both rigs' supervisors (180). Set it lower to see past research move sooner, or to `0` to turn it off.

## The dashboard demo

To work on the dashboard without a stack, run a demo with synthetic campaigns and rigs:

```sh
node --experimental-strip-types scripts/dev/dashboard-demo/main.ts   # http://127.0.0.1:8810/ui
```

It prints the token to sign in with. One of its runs has a made-up experiment queue: experiments tried, in progress and up next, a lane's idea and a hand-out. The same run has five made-up field notes on its **Journal** tab, from lane-1, lane-2, the planner, the auditor and a teacher, and the **Knowledge** page shows a folder for each of the demo's campaigns, built from their events. The demo has no campaign saved on control or assigned through it and no owner's messages, so it shows no **Start a run** and no kept messages; the dashboard's tests cover those. One of them (`tests/control/dashboard/run-page.test.ts`) also drives the **Experiments** and **Planner** tabs through a real harness: it adds, moves and drops experiments, and adds and removes a rule in free words. The dashboard's tests use a smaller fixture with the shapes the harness writes (`tests/helpers/control-demo.ts`): a goal campaign with attempts held for audits, a run at work, and a hill climb with an approval and an auditor's block, field notes and a research note.

The documentation's screenshots come from the demo, whose data is made up. With the demo running, `node scripts/docs/screenshots.mjs` takes them again: the Overview, the Campaigns list, a run's page, the run's **Experiments** and **Journal** tabs, Live for a run at work, the **Knowledge** page and a rig's page, at 1440×900 in the light theme, as WebP files in `docs/_site/src/assets/screenshots/`. It needs a local Chrome or Chromium (`--chrome PATH`); `--out DIR` writes the files elsewhere, to look at them first.

## Journals and the knowledge base

Goal 065's parts are covered by unit tests, which `npm test` runs like any other: field notes (`tests/harness/journal.test.ts`, `tests/harness/agents/scheduler/notes.test.ts`), research in every mode (`tests/harness/research/research-everywhere.test.ts`), the export (`tests/system/export-notes.test.ts`), the supervisor's past-research sync (`tests/supervisor/kb-sync.test.ts`), the advisors' notes (`tests/supervisor/advisors/pass/notes.test.ts`), control's knowledge base and its pages (`tests/control/kb.test.ts`, `tests/control/dashboard/knowledge.test.ts`).

- **Control's assignments** (`tests/helpers/assignments.ts`): control serves a rig's past research and MCP servers only for runs it assigned, so a test that seeds a rig's events records control's own assignment of the run with `assigned(store, rig, run, campaign)`, and any other field of the assignment, such as its `mcp_servers`, as a fifth argument.

No compose acceptance test covers them yet.

## MCP servers for the agents

Goal 068's parts are covered by unit tests too: control's servers, their sign-ins and secrets, the update from an outside knowledge base, the kit refusal, what a rig gets, the REST routes, control's MCP tools and the Settings block (`tests/control/mcp-servers.test.ts`, `tests/control/dashboard/settings/mcp-servers.test.ts`); the harness's gateway, the run's recorded servers, the planner's narrowed tools and a failing server (`tests/agents/mcp/gateway.test.ts`); and the supervisor's share, the advisors' tools and their local servers for Claude Code (`tests/supervisor/advisors/pass/mcp.test.ts`). Nothing in them reaches the internet.

- **A fake MCP server and its OAuth server** (`tests/helpers/fake-mcp.ts`) stand in for a real one, on a free local port: an MCP server at `/mcp` with `search` and `get_page`, which say they only read, and `put_page`, which writes. It takes the sign-in a test sets: a bearer token, a key in a header of its own, an access token from its own OAuth server, or none. Its OAuth server, at the same address, has protected resource metadata, authorization server metadata, client registration, an authorization page that allows at once and sends the browser back with a code, and a token endpoint for codes (checked against PKCE), refresh tokens and client credentials. A test can stop it answering (`down`), stop client registration (`dcr`), shorten a token's life (`expiresIn`) or end every refresh token. It keeps every request's headers and every call, so a test can see that a secret reached the server and nothing else.
- **The judge's test harness** (`tests/helpers/judge-env.ts`) takes `kitMcpServers`, the `mcp_servers` its kit's `kit.json` names.

## The smoke test

The smoke test runs the whole path once, end to end:

1. It bundles the smoke project and its kit into the inbox.
2. It starts the stack.
3. It assigns a campaign through control with a signed command. The supervisor relays the command, and the harness imports both bundles and checks their commits and hashes.
4. It submits one candidate as a proposer from inside the harness container.
5. It waits until the judge's verdict reaches control.
6. It prints how many seconds the run's events took to reach control: from each event's time at the rig to control holding it, the median, the 90th percentile and the longest. Then it stops the stack and removes its volumes.

```sh
COMPOSE="docker compose" npm run smoke:compose
COMPOSE="podman compose" npm run smoke:compose
COMPOSE="podman-compose" npm run smoke:compose
```

The stack runs with the message bus, as `compose.yaml` does by default: the supervisor sends its reports and live lines over it and takes its commands from it, and the smoke checks that control's health says `"bus":"connected"` and, before step 6, that they came that way: the NATS server's `REPORTS` stream holds the reports, and control's consumer acked every one; and control's `GET /v1/bus` shows the `LIVE` stream with messages, control's lines taken from it, and the supervisor's lines published. It checks too that control's `EVENTS` stream holds every event control keeps and that control applied them all.

Set `KEEP=1` to leave the stack running afterwards. To run it beside another stack, give it its own project, control port and bus port: `THERMITE_PROJECT=thermite-smoke THERMITE_CONTROL_PORT=8801 THERMITE_NATS_PUBLISH=127.0.0.1:4223`.

### The smoke project's commits

A rig's smoke check (one of its [rig checks](_site/src/content/docs/how-to/operate/check-a-rig.md)) makes git repositories from `examples/smoke-project` and `kits/smoke-cpu` (without its candidates). The same files always give the same commits, and `examples/contracts/smoke-cpu-goal.json`, the contract of the [goal-campaign tutorial](_site/src/content/docs/tutorials/first-goal-campaign.md), names them. So a change to either folder changes the commits the contract must name. A unit test in `tests/harness/smoke-check.test.ts` makes the repositories as the smoke check does and compares: when it fails, it says which field of the contract to set to which commit.

`examples/matmul-cpu` is the sample project of the [agents tutorial](_site/src/content/docs/tutorials/agents-with-a-free-model.md): a copy of the same project (`project/`) and kit (`kit/`, named `matmul-cpu`, without candidates), kept apart so that the smoke check's commits don't move when the sample changes. A fix to the project or the kit usually belongs in both. The new-campaign page test uploads the sample's kit as the tutorial packs it, and the new-campaign acceptance runs a try of it from its folder.

## The judge acceptance test

`npm run acceptance:judge` runs the smoke campaign (`kits/smoke-cpu`, `examples/smoke-project`) through the whole judge under compose. It submits every candidate in `kits/smoke-cpu/candidates`, each with an expected outcome:

| Candidate | Expected |
| --- | --- |
| A faster kernel | screened, confirmed on fresh data, promoted |
| The same kernel, restated | neutral |
| Wrong results, a build error, NaN output | invalid |
| A timer in the kernel, an edit to the reference | refused before building (static checks) |
| A call to the reference implementation | invalid: the dispatch probe shows the reference ran |
| Too much memory, a full disk | crash_candidate: killed at the run's limits |
| An attempt to overwrite the champion's binary | judged normally; the build store is unchanged |
| A process left running after the benchmark | judged normally; nothing of the run survives it |

It also checks that every role user is refused access to the ledger, kits, builds, secrets and the broker; that a killed controller is recorded as one infrastructure failure and the job still completes; and that the A/A noise of the machine is measured. The report goes to `.dev/acceptance/`.

```sh
COMPOSE="podman compose" npm run acceptance:judge
```

## Agents without a model

`node scripts/acceptance/agents.mjs` checks the agent machinery without a real model: a scripted model on your machine plans one round and plays two workers, which edit, build, use the device and submit through the real harness image. Then the rig's agents move to OpenCode: a hill-climb trial runs in OpenCode's own terminal, the default, and submits with `thermite-trial`; then, with the rig set to headless, a research run's trial runs the research tools as `thermite-trial research` commands. Its fetch names your machine, so the harness's fetcher must refuse it as a private address; its note, report section and progress must come back from the harness. From its working area, its shell must read and search the run's research folder, be refused when it tries to change the harness's files there or add to them, and the file it writes must be saved and recorded when the trial ends.

## A long research run

`node scripts/acceptance/research-longrun.mjs` runs a research campaign for a set time (`MINUTES`, 125 by default) with a scripted worker.

- It reads real public pages, at about one page every two minutes, with robots.txt respected.
- It records quote-verified claims, and kills the harness controller once halfway.
- It checks that the campaign closes on its clock with digests, verified claims and a final report.
- This tests the machinery only; research quality needs a real model.

## The steering acceptance test

`node scripts/acceptance/steering.mjs` runs two rigs with a scripted model on your machine. It checks:

- directives from the teachers (two, and their merged by model) and their attribution in the next round;
- an audit block holding a confirmed win, and a cleared audit letting the next one promote;
- propagation of a champion to the second rig, judged there and shown cross-verified;
- the supervisor's limits (it cannot submit, and it cannot forge a command);
- daily reports;
- a restart, when an engine socket is available;
- a full reset.

## The quick-start test

`node scripts/acceptance/quick-start.mjs` follows the quick start as a tester does: [Your first run](_site/src/content/docs/tutorials/first-run.md), then [Hand the work to agents](_site/src/content/docs/tutorials/agents-with-a-free-model.md) to the judge's first verdict on the sample in `examples/matmul-cpu`.

1. **The release, from your copy.** It builds the control, harness and supervisor images, and writes the release bundle for them with `scripts/release/bundle.ts`, pinned by digest. With Podman the images stay in local storage. With Docker they go to a registry container on `127.0.0.1`, so that each one has a digest. The CUDA harnesses and the RunPod rig image are not built: the bundle names the CPU harness in their place, and no step uses them.
2. **The pages' own steps.** `tests/helpers/quick-start.ts` reads the tutorials, the command line section of [Install Thermite on one machine](_site/src/content/docs/how-to/install/one-machine.md#the-command-line) and [Check the machine](_site/src/content/docs/how-to/operate/troubleshoot.md#check-the-machine). The test runs each shell block as written, in a new folder, with the line for your container tool. It types the values the pages give, presses the buttons they name, and checks the words they quote: the init's last line, Overview's first line, the smoke check's result and its verdict counts, the model check, the kit's summary, the campaign's start and its pause.
3. **Only what cannot work before a release.** The release's files come from a small server on your computer, and the source from your copy's tracked files, committed and tagged as the release and served by `git daemon`. The agents' model is the scripted model of the agents test (`scripts/acceptance/lib/scripted-model.mjs`), added as an OpenAI-compatible provider, under OpenCode v2 as the page says. **Look it up** reads only `https://` addresses, so the test looks the tag up itself. The doctor checks the scripted model's address. When a page no longer has what one of these changes is for, the test fails.

It needs port 8800 free and no volumes of a compose project named `thermite`: it stops before it builds anything otherwise. It removes its stack, its volumes, its images, dangling images and its folder at the end, and writes a report to `.dev/acceptance/`. `KEEP=1` leaves the stack and the folder.

```sh
COMPOSE="podman compose" node scripts/acceptance/quick-start.mjs
```

A change to the steps of those pages runs this test in CI. Run `node scripts/test.mjs tests/docs/quick-start.test.ts` first: it reads the pages as the test does, and fails at once when a step, a value or a quoted line it needs has gone.

## Other acceptance tests

[AGENTS.md](../AGENTS.md#checks) lists the rest, each with when it is needed: control (two rigs), new campaign, machines over SSH, clusters on kind, rig deploy, multi-GPU, Claude Code (a stand-in for it), real Claude Code (a stand-in for Anthropic's API), Codex, the one-container rig image, RunPod (against a fake RunPod API) and the paid RunPod run (by hand, with the owner's OK to spend). Each uses local stand-ins, never a real host or cluster, except the paid RunPod run. Two of them check more than their names say:

- **New campaign** (`scripts/acceptance/campaign.mjs`) creates a campaign through the New campaign form, which starts a try of its kit, then starts the campaign's own run from the campaign's page (**Start a run**) with the agents on. The rig gets a model route that nothing answers (`THERMITE_MODEL_BASE_URL=http://127.0.0.1:9/v1`), so control lets the agents start and they fail at once; the script submits the changes itself.
- **Clusters on kind** (`scripts/acceptance/cluster.mjs`) keeps control's records on a Podman volume. After the slot's rig reports, it tags both rig images `:accept-update`, loads them into kind and restarts control with them. Then it checks that the rig's page offers **Update to these images**, that the rig's new pods run those images and report again, and that its volume claim and secret are unchanged. Next it gives the slot a quota (3 CPUs, 8 GiB) and moves the rig from the namespace's defaults onto 2 CPUs and 6 GiB with `POST /v1/rigs/<rig>/cluster/resources`: a size above the quota must be refused in words, and the rig's new pods must run with the new limits and report again, with its volume claim and secret unchanged. The update and the change of size are tried on the slot's CPU rig only: kind has no GPUs, so a new number of GPUs is the unit tests'.

## Releases

A release is made from a tag. `.github/workflows/release.yml` runs on every tag that starts with `v`, once a maintainer approves the run, as CI's runs are:

1. **Version.** It takes the version from the tag (`v0.1.0` gives `0.1.0`) and stops unless it is `package.json`'s version, or a pre-release of it such as `0.1.0-rc.1`, made of letters, digits, dots and hyphens only. The version reaches each later step's script as an environment variable.
2. **Images.** It builds six images from their Containerfiles and pushes them to `ghcr.io/<owner>/`: `thermite-control`, `thermite-harness` (CPU) and `thermite-supervisor` for amd64 and arm64 (arm64 under QEMU), and two CUDA harnesses in the `thermite-harness` package: CUDA 12.6 for amd64, with tags that end in `-cuda`, and CUDA 13.0 for amd64 and arm64, with tags that end in `-cuda13` (built, but not yet run on a GPU: see [Known limits](_site/src/content/docs/reference/known-limits.md#the-cuda-13-harness-is-untested)). Their bases, `nvidia/cuda:12.6.3-devel-ubuntu22.04` and `nvidia/cuda:13.0.3-devel-ubuntu24.04`, are pinned by digest in the workflow. In the CUDA 12 job, it builds `thermite-rig`, the one-container rig image for RunPod, for amd64 with tags that end in `-cuda`, on the CUDA harness named by the digest it was just pushed with. Each image is pushed with a tag of the commit's first 12 characters, and labelled with the source repository, the version and the commit. Every build but the rig image's gets `THERMITE_COMMIT`, and the harness builds `THERMITE_IMAGE_ID`; the rig image keeps the CUDA harness's. No build sets `CLAUDE_CODE_VERSION`.
3. **Checks.** `scripts/release/check-images.ts` pulls each pushed image by its digest, on a runner that never signed in, and holds it to `src/release/checks.ts`: it pulls without signing in (its package is public), it reports the release's commit in `THERMITE_COMMIT`, it carries no Claude Code, it has no set-id file (every Containerfile clears set-id bits last, and its build fails if one is left), it sets no key, token or password in its environment, and it is published for each platform its image has (arm64 too, where it has one). The harnesses and the rig image also report `THERMITE_IMAGE_ID` and carry neither socat nor bubblewrap; the supervisor and the rig image name no STE checker. The step summary lists each image with its digest and its result. An image that fails stops the release.
4. **Version tags.** Each image that passed gets the version's tag (`0.1.0`, `0.1.0-cuda` or `0.1.0-cuda13`), a copy of the checked manifest, so the version's tag and the commit's name the same digest.
5. **Bundle.** `scripts/release/bundle.ts` fills in `containers/release/compose.template.yaml` and `containers/release/README.template.md` with the images' digests, and the workflow attaches `compose.yaml` and `README.md` to a **draft** GitHub Release. A maintainer reads the draft and publishes it.

The template is the repository's `compose.yaml` with `image:` lines in place of `build:` lines, this release's images as control's rig image defaults (the RunPod rig image in `THERMITE_RUNPOD_RIG_IMAGE` too), and an `init` service that runs `thermite local init`. `tests/release/bundle.test.ts` fails when the two drift apart, and the script refuses to write a bundle from a template that has drifted: a change to `compose.yaml`'s services goes into the template in the same commit.

To publish a build between releases, so that a lab can pin it by its digest (for example a RunPod rig image), run the workflow by hand with **publish** ticked: **Actions › release › Run workflow**, or `gh workflow run release.yml --ref main -f publish=true`. It pushes the six images tagged with the commit only and checks them as a release does, with no version tag and no release; the check's step summary lists each image's digest.

To test the workflow without publishing, run it by hand without **publish**. A push to `main` or to a version's branch that changes the images or the release's files runs it the same way. It builds every image and the bundle, pushes nothing out and makes no release, and keeps the bundle as the run's artifact `release-bundle`. Its CUDA jobs push the CUDA harnesses only to a registry that runs inside each job and ends with it, so that the rig image is built on the CUDA 12 one by digest, as in a release. To make a bundle on your computer from digests you have:

```sh
mkdir -p digests   # one file per image: control, harness, harness-cuda, harness-cuda13, supervisor, rig-cuda, each with sha256:…
node --experimental-strip-types scripts/release/bundle.ts --version 0.1.0 \
  --registry ghcr.io/iammrduncan --repo-url https://github.com/iammrduncan/thermite \
  --digests digests --out bundle
```

Before a release, check the images Thermite pins by digest and does not build (its bases, the bus's NATS server and the release job's registry): `node --experimental-strip-types scripts/release/pins.ts --registry` lists each tag whose digest moved at its registry since it was pinned, and `--update` writes the new digest into every copy. Without `--registry`, it lists the pins and where each one is written, and needs no network.

New GHCR packages start private, and the checks fail on an image that does not pull without signing in. After a package's first push, a maintainer makes it public in its settings, once, and runs the checks again (**Re-run failed jobs**). A package first pushed by hand, outside the workflow, also needs the repository's write access under **Manage Actions access** in its settings, or the workflow cannot push to it.

## Clean up

The compose scripts prune dangling images and trim the Podman VM when their stack comes down. After a run stopped by hand, do the same: `podman image prune -f`, then `podman machine ssh sudo fstrim -a`. Never prune tagged images, which may be other projects'.
