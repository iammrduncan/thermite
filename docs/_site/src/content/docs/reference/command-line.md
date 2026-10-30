---
title: "Command line"
description: "Every thermite command and option, where it runs, what it prints and its exit codes, and thermite-trial inside the harness image."
type: reference
sidebar:
  order: 5
---

`thermite` is Thermite's command line. It checks the machine it runs on, checks contracts, makes tokens, starts runs, copies campaigns, manages the MCP servers in **Settings**, sends [signed commands](signed-commands.md) through control, enrolls rigs, and talks to a rig's harness. The harness image also holds `thermite-trial`, the command a worker agent uses from its own shell.

```sh
npx thermite contract validate contract.json
npx thermite command --control https://control.example.com --token-file ~/thermite-owner-token \
  --rig rig-1 --kind pause_run --payload '{"run":"run-1","reason":"checking the kit"}'
```

The first prints `ok`, the contract's mode, name, version and SHA-256. The second prints the new command's id and `"status":"pending"`. For the steps around these commands, see [Start a campaign from the command line](../how-to/campaigns/start-from-command-line.md) and [Make and change tokens](../how-to/operate/tokens.md). The words [control](glossary.md), [rig](glossary.md), [harness](glossary.md) and [run](glossary.md) are in the glossary.

## Where it runs

| Where | How to run it | Used there for |
| --- | --- | --- |
| Your computer, in a clone of the repository | `npx thermite <command>`, after `npm ci` and `npm run build`. It runs `dist/cli/thermite/main.js` and needs Node.js 22.19 or later. With a release's compose stack, link its `.dev/` folder into the clone, as [the command line](../how-to/install/one-machine.md#the-command-line) shows | Checking the machine, contracts, tokens, starting runs, commands, enrolling rigs |
| Control's image | `thermite` (`/usr/local/bin/thermite`, which runs `node /opt/thermite/dist/cli/thermite/main.js`) | The same commands, from inside control's container, except `doctor`, which checks the machine it runs on. A release's `init` service runs `local init` from this image, and the compose stack's `backup` service runs `backup` and `restore` |
| The supervisor's image | `thermite`, the same wrapper | The same commands |
| The harness image | `thermite`, the same wrapper, and `thermite-trial` | `submit` and `status` against the harness at `http://127.0.0.1:8700`; `selftest isolation`, which must run there, as root |

Under the local compose stack the harness publishes no port, so `submit`, `status` and `selftest isolation` run inside the harness container, for example with `docker compose exec harness thermite selftest isolation`.

## Usage

`thermite`, `thermite help` and `thermite --help` print this text and exit 0:

```text
usage: thermite <command> [options]

  doctor [--control URL] [--model-url URL] [--port N] [--json]
                                      check this machine: the container engine and its compose
                                      tool, control's port, disk, the clock, the GPU driver and
                                      container toolkit where there is a GPU, and whether control
                                      and the model server answer. It says how to fix each
                                      problem, and exits 1 when a check fails
  contract validate <file>            validate a contract and print its sha256
  keys generate <dir>                 write a new Ed25519 control signing key pair
  token new --out F                   make a control token: write it to F (mode 0600; keep it,
                                      for example in a password manager) and print its SHA-256,
                                      the only part control's deployment needs
  assign --contract F --run ID [--seed GIT_URL[@COMMIT] | --seed-commit C]
         [--kit GIT_URL | --kit control:NAME]
         [--model NAME=URL ...] [--note TEXT] [--agents off] [--promotion auto|owner]
         [--ask gain:PERCENT|flaws|reviews|not-possible ...]
         [--queue-from RUN] [--mcp-servers JSON|@file]
         [--context-window TOKENS] [--compact-at PERCENT]
         [--info-file F] [--link URL ...] [--idea TEXT ...] [--hypothesis TEXT ...]
         (--control URL --token-file F --rig R [--ttl MIN] | --print)
                                      start a run. The rig's supervisor fetches the project and
                                      kit commits from their repositories, and models from their
                                      URLs, before the harness checks them. --seed-commit names a
                                      commit already on the rig (an earlier run's result); a kit
                                      already there needs no --kit. --kit control:NAME fetches
                                      the kit NAME that control keeps (kit add, or one the New
                                      campaign page wrote). --queue-from starts the new
                                      run's queue with a past run's untried experiments, read
                                      from control, which knows the run by its name wherever it
                                      ran (it needs --control and --token-file, with --print
                                      too).
                                      --mcp-servers gives the MCP servers the kit's kit.json
                                      names, as in kit.json; the rig refuses a run whose list
                                      differs. --note keeps a text with the run (--direction,
                                      its old name, still works and says so). --context-window
                                      and --compact-at set the campaign's own context settings
                                      in the contract sent (its agents_context, over the file's):
                                      every agent's window is the lower of it and its own, and
                                      the point replaces the rig's; the contract's hash changes
                                      with them. --info-file, --link, --idea and --hypothesis
                                      give the campaign's brief in the contract sent, each in
                                      place of the file's: its additional information (Markdown,
                                      from file F), its starting links (a research campaign's
                                      seeds), its ideas to try (hill climb and goal) and its
                                      hypotheses, one per option. --print shows the payload (for
                                      issue_command over MCP) instead of issuing it
  assign-payload --contract F --run ID --seed-repo R --seed-commit C --bundle PATH
                 [--bundle-sha256 H] [--kit-repo R --kit-commit C --kit-bundle PATH
                 [--kit-bundle-sha256 H]] [--model NAME=SHA256:PATH ...] [--note TEXT] [--agents off]
                                      print an assign_campaign payload (bundle and model
                                      paths are relative to the rig's inbox)
  rig add RIG --control URL --token-file F --out DIR
                                      enroll a rig with control (owner's token): control makes
                                      its token, and DIR gets the files the rig's host needs
  rig token RIG --control URL --token-file F --out FILE
                                      give an enrolled rig a new token (the old one stops working)
  rig retire RIG --control URL --token-file F
                                      shut an enrolled rig out of control; its history stays
  rig list --control URL --token-file F [--json]
                                      list the rigs (owner's token): reporting, stale or
                                      offline, and each one's Thermite version against
                                      control's, with what to do when it is behind or refused
  runpod launch CLOUD --gpu G [--gpus N] [--cloud-type SECURE|COMMUNITY] [--datacenter DC]
         [--image I] [--disk GB] [--volume GB] [--rig NAME] [--enroll-within MIN]
         [--setting NAME=VALUE ...] [--spend-limit USD] [--idle-stop MIN|off]
         --control URL --token-file F
                                      spends money: launch a rig on the GPU cloud CLOUD from
                                      Providers (owner's token), a pod of the one-container rig
                                      image in pull mode. Defaults: 1 GPU, SECURE, any data
                                      center, control's rig image, a 40 GB disk, a 100 GB
                                      volume, no spend limit, no idle stop. --idle-stop MIN
                                      stops the pod after MIN minutes with no run at work;
                                      off: no idle stop
  runpod list [CLOUD] --control URL --token-file F [--json]
                                      list the rigs launched on GPU clouds (owner's token):
                                      each pod's status, price per hour, spend so far and limits
  runpod limits RIG [--spend-limit USD|off] [--idle-stop MIN|off] --control URL --token-file F
                                      set or clear a RunPod rig's spend limit and idle stop
                                      (owner's token)
  runpod stop RIG --control URL --token-file F
                                      stop a RunPod rig's pod (owner's token): its runs paused
                                      and its results sent out first; its volume stays
  runpod start RIG --control URL --token-file F
                                      start a stopped pod again, and resume the runs its stop
                                      paused; refused when RunPod has no GPU free (owner's token)
  runpod restart RIG --control URL --token-file F
                                      stop the pod and start it again (owner's token)
  runpod terminate RIG --control URL --token-file F
                                      remove the pod for good, once every result has left it;
                                      refused, with the pod kept running, when one can't leave
                                      (owner's token)
  runpod reset RIG --control URL --token-file F
                                      start a full reset of a RunPod rig: every result out,
                                      then the wipe after your confirmation (owner's token)
  runpod confirm-wipe RIG --control URL --token-file F
                                      confirm the wipe of the rig's full reset (owner's token)
  runpod cancel-reset RIG --control URL --token-file F
                                      cancel the rig's full reset before its wipe (owner's token)
  run start CAMPAIGN --rig R [--agents off] [--provider P --model M] [--promotion auto|owner]
         [--ask gain:PERCENT|flaws|reviews|not-possible ...]
         [--judge-gpus N] [--queue-from RUN] [--past ID ...] [--fresh]
         [--granted C ... | --no-granted] --control URL --token-file F
                                      start a run of a campaign control keeps (owner's token), as
                                      Start a run on the campaign's page does, with its checks and
                                      refusals: a campaign saved on the New campaign page or
                                      assigned before. --provider and --model give the rig's
                                      agents that model first: the run does not start, and the
                                      command exits 1; run it again once the rig has the model.
                                      --queue-from starts the queue with the untried experiments
                                      of a run of the campaign, by its name; --past adds
                                      items of Thermite's knowledge base by id. Its agents search
                                      the campaign's whole collection, or with --fresh only the
                                      run's own items, and every collection the campaign is
                                      granted, or those --granted names, or none with
                                      --no-granted; fixed as it starts. It prints the new
                                      run and its command id; a stopped RunPod pod starts first
  campaign copy FROM NAME [--mcp-servers-json FILE] [--context-window TOKENS]
         [--compact-at PERCENT] [--info-file F] [--link URL ...] [--idea TEXT ...]
         [--hypothesis TEXT ...] --control URL --token-file F
                                      copy a campaign control keeps (owner's token): a new
                                      campaign NAME with FROM's contract and kit, its own empty
                                      collection in Thermite's knowledge base and no runs. Start
                                      a run of it with run start. It prints the copy.
                                      --mcp-servers-json: for a research campaign, the MCP
                                      servers the copy's agents use instead, as a JSON list
                                      ([] for none). --context-window and --compact-at give the
                                      copy its own context settings, in place of FROM's. The copy
                                      keeps FROM's brief; --info-file (Markdown; an empty file
                                      for none), --link, --idea and --hypothesis give its own,
                                      each in place of FROM's
  campaign context CAMPAIGN [--context-window TOKENS] [--compact-at PERCENT]
         --control URL --token-file F
                                      set a campaign's own context settings for all its runs'
                                      agents (owner's token): every agent's window is the lower
                                      of TOKENS and its own model's, and PERCENT replaces the
                                      rig's compaction point. Control saves a new version of the
                                      campaign; runs started from then take it. Without either
                                      option, the settings are removed. It prints the version
  campaign additions CAMPAIGN [--add ROLE=FILE]... --control URL --token-file F
                                      set the owner's additions to a campaign's roles (owner's
                                      token): each --add gives ROLE's text, from FILE, added to
                                      that role's own instructions in every prompt of the
                                      campaign's runs. Control saves a new version of the
                                      campaign; runs started from then take it. Without --add, the
                                      additions are removed. It prints the version
  kit add NAME BUNDLE [--ref REF] [--force] --control URL --token-file F
                                      give control a kit repository written elsewhere, as a git
                                      bundle file (owner's token; at most 64 MiB): control keeps
                                      every commit with its id, and the kit's head is the
                                      bundle's HEAD, its only branch, or --ref (a branch, a tag or
                                      a commit). The head needs a valid kit.json at its top.
                                      --force replaces a head the new one does not descend from;
                                      the old head's commits stay. Rigs fetch it from control:
                                      assign --kit control:NAME. It prints the kit's head
  kit list --control URL --token-file F [--json]
                                      the kits control keeps (owner's or reader's token): each
                                      one's head, commits and kit.json's name and target
  kb search [WORDS...] [--query Q ...] [--mode words|exact] [--like ADDRESS] [--seen ADDRESS ...]
         [--collection C ...] [--kind K ...] [--outcome O ...] [--run R ...] [--slot S ...]
         [--offset N] [--limit N] --control URL --token-file F
                                      search Thermite's knowledge base (owner's token): items with
                                      any of the words, best first, each with its id, address,
                                      slot, outcome, an excerpt, why it matched, its passage in a
                                      long text and, for an experiment, its result; with how many
                                      matched, the next page, where the words land and how many
                                      items hold each word; no words: the newest. --query adds a
                                      search, fused with the words; --mode exact takes FTS5's
                                      syntax; --like finds more like an item; --seen leaves items
                                      out; --collection, --kind, --outcome, --run and --slot keep
                                      only those. It prints JSON
  kb read ADDRESS [--version N] [--offset N] --control URL --token-file F
                                      one item of the knowledge base, by its address
                                      (<campaign>/<run>/<slot>/<kind>:<id>): its newest version,
                                      or version N, with its links, and its text from --offset,
                                      10,000 characters at most. It prints JSON
  agents list --control URL --token-file F [--json]
                                      the agents' roles (owner's token): each
                                      one's name and what it does
  agents show ROLE [--run RUN [--prompt N] [--sections]] --control URL --token-file F [--json]
                                      a role's definition: its model, programs, the function
                                      that puts its prompt together and its fixed texts. With
                                      --run, the prompt the run's agent in that role was sent
                                      (the newest, or prompt N): each section with its source
                                      and text; --sections lists the sources only. Control has
                                      at most 8,000 characters of a prompt's own text; the
                                      whole is on the rig and in the run's export
  mcp list --control URL --token-file F [--json]
                                      the MCP servers in Settings (owner's token): each one's
                                      sign-in, state, last error, tools and the kits that name
                                      it. No secret, only its last four characters
  mcp add NAME --url URL --auth oauth|key|client|none [--header H] [--secret-file F]
          [--client-id ID] [--client-secret-file F] [--scope S] --control URL --token-file F
                                      add an MCP server (owner's token). key: --secret-file
                                      holds the header's whole value (Bearer and the token);
                                      client: --client-id and --client-secret-file. Control
                                      seals each secret and reads the server's tools. oauth:
                                      prints the sign-in page's address: open it and allow
                                      Thermite
  mcp change NAME [--url URL] [--auth oauth|key|client|none] [--header H] [--secret-file F]
          [--client-id ID] [--client-secret-file F] [--scope S] --control URL --token-file F
                                      change a server; a secret left out is kept, except for
                                      another address or another --auth, which needs it again
  mcp check NAME --control URL --token-file F
                                      read the server's tools again (it calls none)
  mcp sign-in NAME --control URL --token-file F
                                      print the address of an OAuth server's sign-in page
  mcp delete NAME --control URL --token-file F
                                      forget a server and its secrets; refused while a kit
                                      names it
  command --control URL --token-file F [--rig U] --kind K --payload JSON|@file [--ttl MIN]
                                      issue a signed command through control (admin token). A
                                      kind about one run (its payload's run) goes to the rig the
                                      run is on, so --rig may be left out; every other kind
                                      needs it. assign_campaign and resume_run on a RunPod rig
                                      whose pod is stopped start the pod first, and say so
  invalidate --run RUN (--attempt ID | --job N) --reason TEXT [--yes] --control URL --token-file F
                                      withdraw bad evidence (owner's token): an attempt, for
                                      good, with every attempt built on it, or a judge job's
                                      measurements, whose attempts are judged again. It prints
                                      what it would reach, from the rig, and changes nothing;
                                      with --yes it then withdraws exactly that, or the rig
                                      refuses when what it reaches changed. Nothing is deleted
  submit --harness URL --token-file F --run ID --patch-file P --hypothesis TEXT
         [--known-flaw TEXT ...]      submit a patch as a proposer
  status --harness URL --token-file F --attempt ID
                                      show an attempt's lifecycle and verdict
  local init DIR [--engine docker|podman]
                                      make DIR, the local compose stack's .dev folder: random
                                      tokens in DIR/secrets, the inbox, the outbox, and the
                                      advisors' and backups' folders. Files that exist are
                                      kept. Run as root, it gives what it makes to the owner of
                                      DIR's parent folder. It says what the local rig gets
                                      (CPUs, memory, GPUs), and with NVIDIA GPUs the rig can
                                      have, writes compose.gpu.yaml next to DIR for the engine
                                      named, or the one it finds. Each rig's token for control
                                      starts empty: local enroll fills it
  local enroll RIG --control URL --token-file F --out FILE
                                      the compose stack's enroll step: wait for control (up to
                                      5 minutes), enroll RIG with the owner's token in F unless
                                      control has it enrolled and FILE holds a token, and write
                                      its token into FILE. A retired rig is left as it is
  selftest isolation [--force]        inside the harness container, as root, with the rig idle: check that role
                                      users cannot reach the ledger, kits, builds or secrets
  backup FOLDER [--state DIR] [--bus URL]
                                      where control's state folder is mounted (compose: the
                                      backup service): copy control's state (control.db, whole
                                      while control runs, its keys, kits and exports) and a
                                      snapshot of the bus's EVENTS stream into a new folder in
                                      FOLDER, named for the time, with a manifest of each file's
                                      SHA-256 and each stream's count and last place. --state:
                                      control's state folder (THERMITE_CONTROL_DIR, or
                                      /var/lib/thermite-control); --bus: the bus
                                      (THERMITE_NATS_URL)
  restore BACKUP [--state DIR] [--bus URL] [--control URL] [--bus-store DIR]
                                      with control stopped: check the backup against its
                                      manifest, restore each stream the bus does not have and
                                      check it (its count, last place and last message), then
                                      put control's state back, what it replaces moved aside
                                      into a dated folder. A stream on the bus is kept when it
                                      holds the backup's events unchanged, with or without
                                      newer ones after them; any other is refused, and nothing
                                      changes. --control: refused while control answers there.
                                      --bus-store DIR, with the bus stopped: only move the
                                      bus's store aside into a dated folder in DIR, so that
                                      the bus starts empty
```

## Rules for every command

- **Options.** Each option takes its value as the next word or after `=`. In `doctor`, `local init`, `backup`, `restore`, `token new`, `assign`, `assign-payload`, `rig`, `run start`, `campaign copy`, `campaign context`, `campaign additions`, `command`, `invalidate`, `submit` and `status`, an option the command does not know, or a word it does not expect, ends the command with Node's own message and exit code 2. In `runpod` and `mcp`, an option it does not know does the same; a word after the name it takes is ignored.
- **Older option names.** `--instance` is read as `--run`, and `--unit` as `--rig`. These are the names from before runs and rigs were renamed.
- **Control's token.** The commands that talk to control (`assign`, `run start`, `campaign copy`, `campaign context`, `campaign additions`, `mcp`, `command`, `invalidate`, `rig add`, `rig token`, `rig retire`, `rig list`, and every `runpod` command) send the contents of `--token-file`, trimmed, as `Authorization: Bearer <token>`. Only the owner's token works on these routes; any other token gets `401 {"error":"unauthorized"}`. See [Tokens and roles](tokens.md).
- **Control's address.** `--control` is control's base address, such as `https://control.example.com`. A trailing `/` is removed.
- **Refusals.** When control or the harness refuses a request, the command prints `<url> -> <status> <body>` on standard error and exits 2. `status` is the exception: see [below](#status). A request body that does not match the route gives `400 {"error":"invalid request"}` from control. The harness says which field and why, such as `400 {"error":"invalid request: run is missing: it must be a string"}`. A command that control refuses before signing it gives `400` with the reason (for example a payload that does not fit its kind, or a message that nothing would read), or `404` for an unknown rig; another refusal from inside control gives `500` with the reason. The [REST API reference](rest-api.md) lists the routes.

### Exit codes

| Code | When |
| --- | --- |
| `0` | The command did its work. Also `thermite`, `help` and `--help` |
| `1` | `doctor` found a check that failed; `contract validate` found the contract invalid; `restore` refused the backup, a stream on the bus or a running control; `run start` gave the rig a model and did not start the run yet; `invalidate`: the rig refused the preview or the withdrawal, or did not answer within 10 minutes; `selftest isolation` found a probe that was not refused |
| `2` | Missing or wrong options (the usage text goes to standard error); an unknown command (the usage text goes to standard output); a refused request; any other error, with its message on standard error |

## Commands

### `doctor`

`thermite doctor` checks the machine it runs on, before control or a rig starts there: the container engine and its compose tool, control's port, free disk, the clock, the GPU driver and NVIDIA's container toolkit where there is a GPU, what the local rig gets, and whether control and the model server answer. Each check says what it found, and a check that failed or warns says how to fix it. It changes nothing on the machine. Run it on the machine itself, not inside a container: it checks that machine's engine and disks. [Troubleshoot](../how-to/operate/troubleshoot.md#check-the-machine) says when to run it.

```sh
npx thermite doctor --control https://control.example.com --model-url https://opencode.ai/zen/v1
```

| Option | Required | Default | Meaning |
| --- | --- | --- | --- |
| `--control URL` | No | | Control's address. The doctor checks that this machine reaches control, and compares this machine's clock with control's. On a rig's machine, give control's address for rigs. A trailing `/` is removed |
| `--model-url URL` | No | | The model server's address: the provider's base URL, as on **Settings › Providers**. `host.docker.internal` and `host.containers.internal`, the containers' names for this machine, are checked at `127.0.0.1` |
| `--port N` | No | `THERMITE_CONTROL_PORT`, else `8800` | Control's port on `127.0.0.1`, as the compose file publishes it: a whole number from 1 to 65535. Otherwise: `--port is a port number from 1 to 65535`, exit 2 |
| `--json` | No | | Print `{"ok": true or false, "checks": [...]}` instead of text. Each check has `check`, `title`, `status`, `said` and, for a failure or a warning, `fix` |

The checks, in the order it runs them:

| Check (`check`) | What it looks at | Fails when | Warns when | Skipped when |
| --- | --- | --- | --- | --- |
| Container engine (`engine`) | `docker --version` and `docker info`; `podman --version` and `podman info`. A `docker` command that is Podman's stand-in counts as Podman | Neither is installed, or none answers. The fix depends on the engine and the system, such as `podman machine start` on a Mac | | |
| Compose tool (`compose`) | For each engine that answers: `docker compose version`, else `docker-compose version`; `podman compose version`, else `podman-compose version`. `docker-compose` 1.x (Compose v1) doesn't count: it can't read Thermite's compose file. The line names it, and for `podman compose` the program Podman hands the work to | No compose tool works | A compose tool works, but another command finds `docker-compose` 1.x: `podman compose` uses it before podman-compose | No engine answers |
| Control's port (`port`) | Whether a program listens on `127.0.0.1` at the port. If one does, whether it is control: `GET /v1/health`. A rig listens on no port of its own on its machine; it needs to reach control's port, which the **Control** check tests | Another program has the port | | |
| Disk (`disk`) | Free space for the engine's images: Podman's own numbers (`podman info`), or on Linux the file system of Docker's root folder. Free space in the current folder | Under 5 GB for the images, or under 1 GB in the folder | Under 15 GB for the images, or under 5 GB in the folder | Neither can be read. Docker Desktop's own disk can't be read: the check says where to look |
| Clock (`clock`) | With `--control`: control's `Date` header. Without it, on Linux: `timedatectl`, whether the system says its clock is synchronized | More than 300 s from control's clock. Control refuses a rig's reports from more than 5 minutes ahead | More than 30 s from control's clock, or not synchronized | Without `--control` on macOS, or on Linux without `timedatectl`; or when control does not answer |
| GPU driver (`gpu-driver`) | On Linux, with an NVIDIA GPU (`/dev/nvidia0`, `/proc/driver/nvidia/gpus`, or an NVIDIA display controller in `lspci`): `nvidia-smi` | `nvidia-smi` is missing or fails | | No NVIDIA GPU, or macOS. The line names AMD GPUs and a Mac's Apple GPU, which the rig does not use |
| GPU container toolkit (`gpu-toolkit`) | `nvidia-ctk --version`, and what the engine the rig runs on needs from it: with Docker, NVIDIA's runtime in `docker info`; with Podman, a CDI spec at `/etc/cdi/nvidia.yaml` or `/var/run/cdi/nvidia.yaml`, or one that `nvidia-ctk cdi list` shows as `nvidia.com/gpu=all`. With no engine that answers, or GPUs that `nvidia-smi` doesn't list: the toolkit and a CDI spec | The toolkit, the runtime or the CDI spec is missing. The fix says how to install or make it | | No NVIDIA GPU, or macOS |
| Local rig (`rig`) | What the local rig gets: the CPUs and memory of `docker info` or `podman info` (on a Mac, the virtual machine's, with how to give it more; when both engines answer, the other one's too), the NVIDIA GPUs `nvidia-smi` lists and whether the engine can give them to containers, AMD GPUs (`/sys/class/drm` cards with AMD's vendor id, or `/dev/kfd`), and a Mac's Apple GPU. With GPUs the rig can have, it says how `thermite local init` puts the rig on them | | The machine has NVIDIA GPUs that the rig can't have: the driver doesn't list them, or the engine can't give them to containers | No engine answers |
| Control (`control`) | `GET /v1/health` at `--control` | No answer, an answer that is not control's, or control's 503 while it starts or one of its loops is late (`Control answers at <address>, but one of its loops is late: /v1/health answered HTTP 503.`) | | No `--control` |
| Model server (`model`) | `GET` at `--model-url`. Any HTTP answer counts, even `401` or `404`: the rig's [Model route check](rig-checks.md) tests the model itself | No answer | | No `--model-url` |

A request waits at most 10 seconds. A failed request says why: nothing listens at the address, the name does not resolve, no answer in time, or a TLS certificate this machine does not trust.

The text report has one line for each check. The line starts with `ok`, `WARN`, `FAIL` or `skip`, then the check's name and what it found. A failure or a warning has a second line, `Fix:` and what to do:

```text
ok    Container engine: Podman 5.2.1 answers.
ok    Compose tool: podman compose works.
FAIL  Control's port: Port 8800 is in use by another program. Control needs this port for its dashboard and API.
      Fix: Stop that program. To find it, run lsof -nP -iTCP:8800 -sTCP:LISTEN. Or use another port: put THERMITE_CONTROL_PORT=8801 in a .env file next to compose.yaml. Then run thermite doctor --port 8801.
ok    Disk: 47.1 GB is free for Podman's images in its virtual machine. 306.2 GB is free in this folder.
skip  Clock: Give --control to compare this clock with control's clock.
```

The last line counts them: `No check failed.` and the number of warnings, or the number of failed checks and warnings, then `Fix the failures, then run thermite doctor again.` The command exits 0 when no check failed, whatever the warnings and skipped checks, and 1 when one failed.

### `contract validate`

`thermite contract validate <file>` parses a [contract](contract.md) with the same schema control and the harness use. It needs no network.

| Result | Output | Exit |
| --- | --- | --- |
| Valid | `ok <mode> <campaign> v<version> sha256=<hex>` on standard output | `0` |
| Valid, but a hill climb or goal contract names no `project.kit` | The `ok` line, then on standard error: `warning: no project.kit: the judge cannot measure this campaign until the contract names a kit repository and commit` | `0` |
| Invalid | One line per problem on standard error | `1` |
| Not JSON, or no such file | The error on standard error | `2` |

The SHA-256 is the contract's hash: an `assign_campaign` command carries it as `contract_sha`.

### `keys generate`

`thermite keys generate <dir>` writes a new Ed25519 key pair for signing commands: `<dir>/control-signing.key` (mode 0600) and `<dir>/control-signing.pub` (mode 0644). It creates `<dir>` if needed and prints `wrote <dir>/control-signing.{key,pub}`.

Control makes its own pair in its data directory the first time it starts, so it does not need this command.

### `token new`

`thermite token new --out F` makes a token for control: 32 random bytes, written base64url-encoded to `F` with mode 0600.

| Option | Required | Meaning |
| --- | --- | --- |
| `--out F` | Yes | The file to write. An existing file is never overwritten: `F exists; a token is never overwritten` |

It prints:

```text
wrote the token to F
sha256 <64 hexadecimal characters>
Deploy control with the hash as THERMITE_CONTROL_<ROLE>_TOKEN_SHA256, where ROLE is ADMIN (the owner), OPERATOR, AGENT or READ.
```

The hash is what control's settings take; the token itself stays with you. See [Tokens and roles](tokens.md).

### `assign`

`thermite assign` builds an `assign_campaign` command from a contract and sends it to a rig through control, or prints it. The rig's [supervisor](glossary.md) fetches what the command names, and the harness checks it and starts the run.

| Option | Required | Default | Meaning |
| --- | --- | --- | --- |
| `--contract F` | Yes | | The contract file. It is checked before anything is sent; an invalid contract ends the command with its problems (exit 2) |
| `--run ID` | Yes | | The new run's id: lowercase letters, digits, `.`, `_` and `-`, starting with a letter or digit, at most 64 characters. Control refuses another form with `bad assign_campaign payload: run: lowercase id` |
| `--seed GIT_URL[@COMMIT]` | No | | The project's repository, and the commit to start from. `COMMIT` is a full commit id (40 or 64 hexadecimal characters). Without `@COMMIT`, the contract's `project.commit` is used. The supervisor fetches that commit from the repository |
| `--seed-commit C` | No | The contract's `project.commit` | A full commit id that is already on the rig, such as an earlier run's result. Nothing is fetched |
| `--kit GIT_URL` | No | | The [kit](glossary.md)'s repository. The kit's commit comes from the contract's `project.kit`. Without `--kit`, the kit's commit must already be on the rig |
| `--kit control:NAME` | No | | The kit `NAME` that control keeps: one given to it with [`thermite kit add`](#kit-add), or one the **New campaign** page wrote. The rig's supervisor fetches the contract's `project.kit.commit` from control. `NAME` is lowercase letters, digits, dots, dashes and underscores, at most 64, starting with a letter or digit |
| `--model NAME=URL` | No, repeatable | | A [model file](glossary.md) the contract lists under `models` (a data file the project loads, such as a model's weights), and an `http` or `https` address to fetch it from |
| `--note TEXT` | No | | The run's note: a text kept with the run, and shown as `Note: …` on the run's page in the [knowledge base](knowledge-base.md). Thermite does not act on it. It is sent as the command's `direction` field, a name from before a direction meant a named line of experiments |
| `--direction D` | No | | The old name of `--note`. It still works in v0.1.0, and prints `--direction is now --note: a direction is now a named line of experiments` on standard error. With `--note` as well, the command stops: `--direction is the old name of --note: give only --note` (exit 2) |
| `--agents on\|off` | No | `on` | `off` starts a judge-only run: no worker agents, the judge still works |
| `--promotion auto\|owner` | No | The rig's own setting | The run's promotion rule. `owner` is sent as `owner_approval`: every confirmed win waits for the owner |
| `--ask WHAT` | No, repeatable | Nothing: the run is hands-off | What else the run asks the owner about, sent as the command's `ask_owner`: `gain:PERCENT`, a confirmed gain above it (`gain:15` is 15%); `flaws`, a win whose worker declared flaws; `reviews`, a review panel's pass of a goal or of a research run's answers; `not-possible`, a "not possible" ending of a goal campaign. See [Decide what waits for you](../how-to/campaigns/decide-what-waits.md) |
| `--queue-from RUN` | No | Off: the new run's queue starts empty | A past run, by its name, whose untried experiments start the new run's [experiment queue](../how-to/campaigns/choose-what-runs-next.md). Control knows the run by its name, wherever it ran. They are read from control, so it needs `--control` and `--token-file`, with `--print` too. See [below](#copy-a-past-runs-untried-experiments) |
| `--mcp-servers JSON\|@file` | When the kit names MCP servers | None | The MCP servers the kit's `kit.json` names, as it names them ([`mcp_servers`](kit-manifest.md#mcp-servers)): the JSON list itself, or `@` and a file that holds it. Sent as the command's `mcp_servers`. Control refuses a server **Settings** lacks, and the rig refuses the run when the list differs from `kit.json`'s. A research contract's own `mcp_servers` are sent without it |
| `--context-window TOKENS` | No | The contract's | The campaign's own context window for the run's agents: the contract's [`agents_context.context_window`](contract.md#agents-context), over the file's. 4,096 to 100,000,000. Each agent works with the lower of it and its own window. The contract sent, and its hash, change with it |
| `--compact-at PERCENT` | No | The contract's | The campaign's own compaction point: the contract's `agents_context.compact_at`, over the file's. 50 to 95. It replaces the rig's point for every agent of the run |
| `--info-file F` | No | The contract's | The campaign's additional information: the contract's [`notes`](contract.md#the-campaigns-brief), in Markdown, read from file `F`, over the file's. No length limit of its own. An empty file removes it. The contract sent, and its hash, change with it |
| `--link URL` | No, repeatable | The contract's | One starting link, a web address. Together they are the contract's `links` (hill climb and goal), or a research contract's `seeds`, in place of the file's. A research run's harness fetches and archives them when the run starts |
| `--idea TEXT` | No, repeatable | The contract's | Hill climb and goal: one idea to try. Together they are the contract's `ideas`, in place of the file's. For a research contract the command stops: `--idea is for hill-climb and goal campaigns: a research campaign has questions` (exit 2) |
| `--hypothesis TEXT` | No, repeatable | The contract's | One hypothesis. Together they are the contract's `hypotheses`, in place of the file's. A research run starts with them as its hypotheses |
| `--control URL` | To send it | | Control's address |
| `--token-file F` | To send it | | A file with the owner's token |
| `--rig R` | To send it | | The rig that runs it |
| `--ttl MIN` | No | `60` | Minutes before the command expires if the rig has not taken it: a whole number from 1 to 10080 (7 days) |
| `--print` | Instead of the four above | | Print the payload as indented JSON and send nothing. The output is what the MCP tool `issue_command` takes as `payload` |

`--info-file`, `--link`, `--idea` and `--hypothesis` put the campaign's brief in the contract sent, so you can keep the brief in a Markdown file beside the contract. An `--info-file` that can't be read ends the command with `--info-file:` and why (exit 2).

A `--context-window` or `--compact-at` out of range ends the command before anything is sent, with exit code 2: `--context-window and --compact-at: A context window is a whole number of tokens from 4,096 to 100,000,000.` or `… The compaction point is a whole percent of the context window, from 50 to 95.` Control refuses a window above what a provider lists for one of the rig's agents' models: [Campaigns](rest-api.md#campaigns) has the words.

`--seed` and `--seed-commit` together are refused. When the contract's project is one folder of its repository (`project.folder`), `--seed` and `--seed-commit` still name the whole repository and its commit: the harness starts the run from that folder of the commit. For a research contract, the run has no seed and no kit, and `--seed`, `--seed-commit` and `--kit` are not used.

#### Copy a past run's untried experiments

`--queue-from` puts the same experiments in the payload's `queue` as **Copy the untried experiments of** in a campaign's **Start a run** panel: the past run's experiments up next, in their order, then its lanes' ideas, at most 500. The tried and dropped ones stay with their run. The command reads them from control (`GET /v1/runs/<run>/untried`, see [the REST API](rest-api.md#runs)) before it sends or prints anything. Control takes each one's title, details, direction, why and author from its own records of the past run, with every edit, as for a copied experiment over MCP. That holds for a run of the contract's campaign, or of a campaign whose folder it may read; any other run's experiments keep their words, with the author `copied`. Each one names where it came from, as `from: {run, id}`.

```sh
npx thermite assign --contract contract.json --run sort-speed-3 --seed-commit 0123456789abcdef0123456789abcdef01234567 \
  --queue-from sort-speed-2 \
  --control https://control.example.com --token-file ~/thermite-owner-token --rig rig-1
```

A past run with nothing untried leaves the queue empty: the command says `<run> has no untried experiments: the new run's queue starts empty` on standard error, sends no `queue`, and goes on.

The imports it adds to the payload:

| Option | Import | `path` in the rig's inbox | `source` |
| --- | --- | --- | --- |
| `--seed` | `repo_bundle` for the contract's `project.repo` and the seed commit | `repos/<repo>-<commit>.bundle` | `{"git": "<GIT_URL>"}` |
| `--kit` | `kit_bundle` for the contract's `project.kit` repository and commit | `repos/kit-<repo>-<commit>.bundle` | `{"git": "<GIT_URL>"}`, or `{"control": "kits/<NAME>"}` for `--kit control:NAME` |
| `--model` | `model` with the contract's SHA-256 for that model | `models/<sha256>` | `{"url": "<URL>"}` |

Sent, it prints control's answer on one line, such as `{"id":"<command id>","status":"pending"}`. On a [rig launched on RunPod](rest-api.md#rigs-on-a-gpu-cloud) whose pod is stopped, control starts the pod first; the answer's `woke` says so, and the command also prints those words on standard error: `rp-1a2b3c4d's pod was stopped: control started it. The run starts once the pod runs.` When control can't start it, the command is not sent, and it ends with control's `409` and the reason, such as no GPU free at RunPod or the spend limit reached. [Signed commands](signed-commands.md) describes the `assign_campaign` payload and what the harness checks. The campaign's page on the dashboard can start further runs of it, and so can [`thermite run start`](#run-start): each signs the newest assignment again as a new run, with the same contract, seed and imports. A run on another rig works only if that rig already has what the imports leave out: the seed commit when `--seed` was not given, the kit's commit when `--kit` was not given, and each model the contract lists that no `--model` gave.

| Message | Cause |
| --- | --- |
| `give --control, --token-file and --rig to issue it, or --print to show it` | Neither the three options nor `--print` |
| `--seed or --seed-commit, not both` | Both were given |
| `the seed commit must be a full commit id (40 or 64 hexadecimal characters)` | `--seed` without a full `@COMMIT`, and the contract's `project.commit` is not one either |
| `--seed-commit must be a full commit id (40 or 64 hexadecimal characters)` | The commit from `--seed-commit` or the contract is not a full commit id |
| `--kit given, but the contract names no project.kit` | `--kit` with a contract that has no kit |
| `--kit control:NAME names a kit control keeps: "<NAME>" is not one` | `--kit control:` with a name that is not a kit's name |
| `--model <arg>: expected NAME=URL for a model the contract lists` | No `=`, or a name the contract's `models` does not list |
| `--agents is on or off` | Another value |
| `--promotion is auto or owner` | Another value |
| `--ask is gain:PERCENT, flaws, reviews or not-possible` | Another value |
| `a run without agents has no queue: leave out --queue-from` | `--queue-from` with `--agents off`. The harness refuses such a payload the same way |
| `--queue-from reads the past run from control: give --control and --token-file` | `--queue-from` without either |
| `--queue-from names a run` | An empty run name |
| `<url> -> 404 {"error":"no run <run>"}` | Control has no run of that name |

### `assign-payload`

`thermite assign-payload` prints an `assign_campaign` payload, on one line, for bundles and models that are already in the rig's inbox. It does not talk to control. Paths are relative to the inbox.

| Option | Required | Meaning |
| --- | --- | --- |
| `--contract F` | Yes | The contract file |
| `--run ID` | Yes | The new run's id |
| `--seed-repo R` | Yes | The project's repository name |
| `--seed-commit C` | Yes | The full commit to start from: `--seed-commit must be a full commit id (40 or 64 hexadecimal characters)` otherwise |
| `--bundle PATH` | Yes | The project's git bundle in the inbox (a `repo_bundle` import) |
| `--bundle-sha256 H` | No | The bundle file's SHA-256, checked as well as the commit |
| `--kit-repo R`, `--kit-commit C`, `--kit-bundle PATH` | No, together | The kit's bundle in the inbox (a `kit_bundle` import) |
| `--kit-bundle-sha256 H` | No | The kit bundle's SHA-256 |
| `--model NAME=SHA256:PATH` | No, repeatable | A model file in the inbox, with its SHA-256: `bad --model <arg>; expected NAME=SHA256:PATH` otherwise |
| `--note TEXT` | No | As for `assign` |
| `--direction D` | No | As for `assign`: the old name of `--note` |
| `--agents on\|off` | No | As for `assign` |

It has no `--promotion`; the run takes the rig's own promotion rule.

### `rig add`

`thermite rig add RIG --control URL --token-file F --out DIR` enrolls a rig with control (`POST /v1/rigs`) and writes the files the rig's host needs into `DIR`. Control makes the rig's token and keeps only its SHA-256.

| Option | Required | Meaning |
| --- | --- | --- |
| `RIG` | Yes | The rig's name: 2 to 40 characters of `a`–`z`, `0`–`9` and `-`, starting and ending with a letter or digit. Control refuses another name with `400 {"error":"invalid request"}` |
| `--control URL` | Yes | Control's address |
| `--token-file F` | Yes | A file with the owner's token |
| `--out DIR` | Yes | An empty or new directory. Otherwise: `DIR is not empty; a rig's files are never overwritten` |

It prints `enrolled RIG; control's key fingerprint <fingerprint>`, then `wrote` and each file:

| File | Mode | Holds | Read by |
| --- | --- | --- | --- |
| `secrets/control-rig-token` | 0600 | The rig's token for control | The supervisor, as `THERMITE_CONTROL_TOKEN_FILE` |
| `secrets/harness-supervisor-token` | 0600 | A new token the command makes itself. Control never sees it | The harness, as `THERMITE_SUPERVISOR_TOKEN_FILE`, and the supervisor, as `THERMITE_HARNESS_TOKEN_FILE` |
| `keys/control-signing.pub` | 0644 | Control's public key | The harness, as `THERMITE_CONTROL_PUBKEY_FILE` |
| `keys/control-signing.fingerprint` | 0644 | That key's fingerprint | You, to compare with the fingerprint control's dashboard shows |
| `keys/bus-ca.pem` | 0644 | The certificate of control's authority for the message bus | The supervisor, as `THERMITE_NATS_CA_FILE` |
| `rig.env` | 0644 | `THERMITE_RIG_ID=<rig>`, `CONTROL_URL=<control's address>` and `THERMITE_NATS_URL=<the bus's address for rigs>` | The rig's settings |
| `README.txt` | 0644 | What each file is for | You |

Control refuses a name that is taken: `409 {"error":"rig <rig> is already enrolled"}`. When control has no address for rigs on its message bus, the command writes no file, since a rig works only on the bus: `control enrolled <rig> but has no address for rigs on its message bus (THERMITE_NATS_PUBLIC_URL, or THERMITE_CONTROL_PUBLIC_URL), and a rig works only on the bus. Set it on control, retire this rig (thermite rig retire <rig>) and add it again`.

No token is printed. Thermite has no ready-made deployment that starts a rig from this directory; the dashboard's **Add a rig** sets rigs up for you. See [Add a rig on a machine over SSH](../how-to/install/rig-on-a-machine.md) and [Join a rig yourself](../how-to/install/join-a-rig.md).

### `rig token`

`thermite rig token RIG --control URL --token-file F --out FILE` gives an enrolled rig a new token (`POST /v1/rigs/RIG/token`) and writes it to `FILE` with mode 0600. The old token stops working at once.

It prints `RIG has a new token, in FILE; its old token no longer works`. An existing `FILE` is never overwritten: `FILE exists; a token is never overwritten`. Control refuses a rig it did not enroll: `404 {"error":"rig <rig> is not enrolled"}`.

### `rig retire`

`thermite rig retire RIG --control URL --token-file F` retires a rig (`POST /v1/rigs/RIG/retire`): its token stops working, and its history stays on control. It works on any rig control knows: enrolled, or one that has reported. It prints `RIG is retired: its token no longer works`. A rig control does not know gives `404 {"error":"no rig <rig>"}`.

### `rig list`

`thermite rig list --control URL --token-file F` lists the rigs (`GET /v1/rigs`): whether each one reports, and its Thermite version against control's. `--json` prints control's answer as it is instead.

```text
control 0.2.0 (1a2b3c4d5e6f), protocol 1
RIG    STATE      LAST REPORT               VERSION  HARNESS               SUPERVISOR
rig-1  reporting  2026-10-20T12:00:00.000Z  behind   0.1.0 (abcdef012345)  0.1.0 (abcdef012345)
  This rig runs an older Thermite than control: harness 0.1.0, supervisor 0.1.0. Control runs 0.2.0. Control still works with it. Update the rig's images.
rig-2  offline    never                     refused  no version            0.1.0
  Control cannot work with this rig: its supervisor speaks protocol 0, and control works with protocol 1. Update the rig's images.
rig-3: enrolled, no report yet
```

- **The first line** is control's build: its version, the first 12 characters of its commit when its image has one, and its protocol. `(works with 1 to 2)` follows when control works with older protocols too.
- **`STATE`** is `reporting`, `stale` or `offline`. **`LAST REPORT`** is `never` for a rig that never sent one.
- **`VERSION`** is `current`, `behind`, `ahead`, `unknown` or `refused`. Under a rig that is not `current`, an indented line says what to know and do.
- **`HARNESS`** and **`SUPERVISOR`** are the version each part reports, with its commit, or `no version` for a part from before version checks.
- **Enrolled rigs** that never reported come last.

[Rig versions](rest-api.md#rig-versions) says what each state means and when control refuses a rig. Against a control from before version checks, the first line is `control: no version (control is older than version checks)`, and each rig's state and version are `unknown`.

### `runpod launch`

`thermite runpod launch CLOUD` **spends money**. It launches a rig on the GPU cloud `CLOUD` from **Providers** (`POST /v1/gpu-clouds/CLOUD/rigs`): one pod of the [one-container rig image](harness-image.md#the-one-container-rig-image), in [pull mode](../explanation/trust.md#rigs-in-pull-mode), billed by the hour until it is stopped or removed. Only the owner's token may launch. Control enrolls the rig once its pod runs.

```sh
thermite runpod launch runpod --gpu "RTX A4000" --spend-limit 20 --idle-stop 60 \
  --control https://control.example.com --token-file ~/.thermite/owner-token
```

It prints the rig on one line, then `Launched: RunPod bills the pod from now. Control enrolls it once it runs; follow it with thermite runpod list.`

| Option | Required | Default | Meaning |
| --- | --- | --- | --- |
| `--gpu G` | Yes | | A GPU type's id or name in RunPod's list |
| `--gpus N` | No | `1` | GPUs in the pod: 1 to 8 |
| `--cloud-type SECURE` | No | `SECURE` | Secure cloud on demand. Control refuses `COMMUNITY` until a later version |
| `--datacenter DC` | No | any | A data center's id |
| `--image I` | No | control's `THERMITE_RUNPOD_RIG_IMAGE` | The one-container rig image |
| `--disk GB` | No | `40` | The container's own disk |
| `--volume GB` | No | `100` | The pod's volume at `/workspace`, which keeps a snapshot of the rig's state |
| `--rig NAME` | No | `rp-` and 8 hexadecimal characters | The rig's name |
| `--enroll-within MIN` | No | no expiry | The enrollment code expires this many minutes after the launch |
| `--setting NAME=VALUE` | No | a GPU rig on all the pod's GPUs | One of the rig's settings at enrollment; give it again for each |
| `--spend-limit USD` | No | none | Control stops the pod once it has cost this much |
| `--idle-stop MIN` | No | none | Control stops the pod once no run has been at work on the rig for this many minutes: no run running, or every run paused, blocked or finished. `off`: no idle stop. [Rigs on a GPU cloud](rest-api.md#rigs-on-a-gpu-cloud) says what counts as at work |
| `--control URL`, `--token-file F` | Yes | | Control's address, and a file with the owner's token |

[Rigs on a GPU cloud](rest-api.md#rigs-on-a-gpu-cloud) gives each field's limits and every refusal. An option with a value it can't take ends the command with exit code 2 and a reason, such as `--gpus takes a whole number, not "two"` or `--cloud-type is SECURE or COMMUNITY, not "spot"`.

### `runpod list`

`thermite runpod list --control URL --token-file F` lists the rigs launched on GPU clouds, from `GET /v1/rigs`. With `CLOUD`, only that cloud's (`GET /v1/gpu-clouds/CLOUD/rigs`). `--json` prints control's answer instead.

```text
rp-1a2b3c4d · pod pod1 · RUNNING · 1 × RTX A4000 (Secure) · $0.25/h · spent $1.50 · spend limit $20.00 · no idle stop · enrolled
```

Each line has the rig, its pod, the pod's status at RunPod (`gone` once RunPod no longer has it), its GPUs and cloud, its price per hour, what it has cost so far, its limits and its enrollment. Indented lines under it say `stopped by control: spend limit` (or `idle stop`) when control stopped the pod at a limit, or `stopped by the owner`; `under way:` and the stop, start, restart or terminate under way, such as `under way: stopping: waiting for its results to leave the pod`; and `last error:` with what control's last read of the pod found, or why a terminate was refused (that stays until the owner's next stop, start, restart or terminate of the pod, or its full reset). With no rig it prints `no rig on a GPU cloud`.

### `runpod limits`

`thermite runpod limits RIG --spend-limit USD --idle-stop MIN` sets a rig's limits (`POST /v1/rigs/RIG/runpod/limits`), and prints the rig's line. `off` clears a limit, and a limit left out stays: `--spend-limit off` removes the spend limit and keeps the idle stop. Without either option it ends with `give --spend-limit, --idle-stop or both (a number, or off)`. Only the owner's token may change them.

### `runpod stop`, `start`, `restart`, `terminate`

These change a RunPod rig's pod, with the owner's token. Each prints the rig's line, as `runpod list` does, then what happens next.

```sh
thermite runpod stop rp-1a2b3c4d --control https://control.example.com --token-file ~/.thermite/owner-token
```

| Command | Route | What it prints after the rig's line |
| --- | --- | --- |
| `thermite runpod stop RIG` | `POST /v1/rigs/RIG/runpod/stop` | `Stopping: its runs are paused and its results go out first, then the pod stops. Follow it with thermite runpod list.` |
| `thermite runpod start RIG` | `POST /v1/rigs/RIG/runpod/start` | `Started: RunPod bills the pod from now. The runs the last stop paused resume once it runs.` |
| `thermite runpod restart RIG` | `POST /v1/rigs/RIG/restart`, then `GET /v1/rigs/RIG/runpod` | `Restarting: the pod stops, then starts again. Its volume stays.` |
| `thermite runpod terminate RIG` | `POST /v1/rigs/RIG/runpod/terminate` | `Terminating: its runs are paused, and the pod is removed only once every result has left it. Follow it with thermite runpod list.` |

Naming the rig in `terminate` is the confirmation: the command sends `{"confirm":"terminate RIG"}`. A refusal, such as `RunPod has no free GPU for pod … now, so the pod stays stopped (…)`, ends the command with exit code 2, as in [Refusals](#rules-for-every-command). [Stop, start, restart and terminate](rest-api.md#stop-start-restart-and-terminate) lists each refusal and how each change goes.

### `runpod reset`, `confirm-wipe`, `cancel-reset`

A full reset of a RunPod rig, with the owner's token: every result leaves the pod, the rig's state is wiped after your confirmation, and the pod and its GPU stay. Each first reads `GET /v1/rigs/RIG/runpod`, so a rig not on RunPod gets 404 and nothing starts.

| Command | Route | What it prints |
| --- | --- | --- |
| `thermite runpod reset RIG` | `POST /v1/rigs/RIG/reset` with `{"confirm":"reset RIG"}` | `Full reset <id> of RIG started: its runs are paused, and every result leaves the pod. Check the export, then confirm the wipe with thermite runpod confirm-wipe RIG.` |
| `thermite runpod confirm-wipe RIG` | `POST /v1/resets/<id>/confirm`, for the rig's reset that has not ended (`GET /v1/resets`) | `The wipe of reset <id> is confirmed: RIG's state is wiped, and the pod and its GPU stay.` |
| `thermite runpod cancel-reset RIG` | `POST /v1/resets/<id>/cancel`, likewise | `Reset <id> is cancelled: nothing was wiped, and RIG's runs stay paused.` |

With no reset of the rig under way, `confirm-wipe` and `cancel-reset` end with `no full reset of RIG is under way` and exit code 2. [Restart and full reset](rest-api.md#restart-and-full-reset) gives a reset's states.

### `run start`

`thermite run start` starts a run of a campaign control keeps, as **Start a run** on the campaign's page does (`POST /v1/campaigns/<campaign>/runs`). The campaign is one saved on the **New campaign** page, a copy made with [`campaign copy`](#campaign-copy), or one assigned before with `thermite assign`, the REST API or MCP; control then assigns it again with the same contract, starting point and imports. Control runs the dashboard's own code for it, with the same checks and refusals.

```sh
npx thermite run start sort-speed --rig rig-1 --queue-from sort-speed-1 \
  --control https://control.example.com --token-file ~/thermite-owner-token
```

It prints control's answer on one line, such as `{"started":true,"campaign":"sort-speed","rig":"rig-1","run":"sort-speed-2","command":"<command id>","status":"pending"}`, and writes on standard error what else to know: `sort-speed-1 is at work on rig-1, and pauses when this run starts (a rig runs one run at a time).`, `sort-speed-1 on rig-1 has no untried experiments: the new run's queue starts empty.`, or, on a [rig launched on RunPod](rest-api.md#rigs-on-a-gpu-cloud) whose pod was stopped, `rp-1a2b3c4d's pod was stopped: control started it. The run starts once the pod runs.`

| Option | Required | Default | Meaning |
| --- | --- | --- | --- |
| `CAMPAIGN` | Yes | | The campaign, as on its page |
| `--rig R` | Yes | | The rig the run starts on |
| `--agents on\|off` | No | `on` | `off`: a try, with no agents. The judge alone measures the starting point: a hill climb's [baseline](contract.md#the-baseline), or a goal campaign's check of every goal |
| `--provider P` and `--model M` | No | | For a rig with no model for its agents: give it model `M` of provider `P` in **Providers** first, with the harness the model needs (the rig's own when control gave it this model already). When the rig does not run `M` yet, the run does not start: the answer is `{"started":false,"said":"rig-1 takes M within a minute; …"}`, `said` goes to standard error, and the command exits 1. Run it again without them once the rig runs the model. When the rig runs `M` already, the run starts |
| `--promotion auto\|owner` | No | the rig's default | When a change is confirmed better: keep it at once, or wait for the owner |
| `--ask WHAT` | No, repeatable | nothing | **Ask me first about**: `gain:PERCENT`, `flaws`, `reviews` or `not-possible`, as for `assign` |
| `--judge-gpus N` | No | the rig's current split | For a rig with several GPUs: how many the judge measures on. The rig's harness restarts to apply a new split |
| `--queue-from RUN` | No | | Another run of this campaign, by its name (one of a retired rig or from before a full reset too): its untried experiments start the new run's queue |
| `--past ID` | No | | An item of Thermite's knowledge base, by the id `thermite kb search` or MCP's `kb_search` gives; give it again for more. Experiments join the queue; findings, claims, notes and reports go to every agent's brief |
| `--fresh` | No | continue | The run's agents search only the run's own items in the knowledge base, not the campaign's whole collection. Fixed when the run starts ([A run's scope](knowledge-base.md#a-runs-scope)) |
| `--granted C` | No, repeatable | every collection the campaign is granted now | A granted collection the run's agents also search, read only |
| `--no-granted` | No | | They search no granted collection |
| `--control URL` | Yes | | Control's address |
| `--token-file F` | Yes | | A file with the owner's token |

Before it sends anything, it ends with exit code 2 and one of these: `--no-granted searches no granted collection: leave out --granted`, `--rig names the rig the run starts on`, `--agents is on or off`, `--promotion is auto or owner`, `--ask is gain:PERCENT, flaws, reviews or not-possible`, `--provider and --model go together: the agents' model is one of a provider's models`, `--queue-from names a run`, `--judge-gpus takes a whole number, not "…"` or `--past takes a whole number, not "…"`. Control's refusals come back as `<url> -> <status> <body>` with the words of **Start a run**, such as `-> 409 {"error":"rig-1 has no model for its agents, so they could not work: …"}`: [Campaigns](rest-api.md#campaigns) lists them. MCP's [`start_run`](mcp-tools.md#start_run) does the same with an operator's token too. With `--agents off`, control refuses `--provider`, `--queue-from` and `--past`: `-> 400 {"error":"A try (agents off) takes no model, no experiments and no background: leave them out, or start the run with agents."}`.

### `campaign copy`

`thermite campaign copy` copies a campaign control keeps under a new name, as **Copy** on the campaign's page does (`POST /v1/campaigns/<campaign>/copy`). The copy has the campaign's contract and kit, as its newest saved version has them or as it was assigned before. It has its own collection in Thermite's knowledge base, which starts empty, and no runs.

```sh
npx thermite campaign copy sort-speed sort-speed-b \
  --control https://control.example.com --token-file ~/thermite-owner-token
```

It prints control's answer on one line, such as `{"campaign":"sort-speed-b","version":1,"contract_sha":"<sha256>","from":{"campaign":"sort-speed","version":2}}`. `from` is `{campaign, rig, run}` for a campaign that was only assigned before. Then start a run of the copy with [`thermite run start`](#run-start).

| Option | Required | Default | Meaning |
| --- | --- | --- | --- |
| `FROM` | Yes | | The campaign to copy, as on its page |
| `NAME` | Yes | | The copy's name: lowercase letters, digits, dashes and underscores, at most 64, starting with a letter or a digit. No campaign may have it yet |
| `--mcp-servers-json FILE` | No | the source's | A research campaign only: a file with the MCP servers the copy's agents use instead of the source's, as a JSON list, sent as the request's `mcp_servers` ([Copy a campaign](rest-api.md#copy-a-campaign)). `[]` names none |
| `--context-window TOKENS` | No | the source's | The copy's own context window for its runs' agents, 4,096 to 100,000,000, sent in the request's `agents_context`. With it or `--compact-at`, the copy's context settings are these, in place of the source's |
| `--compact-at PERCENT` | No | the source's | The copy's own compaction point, 50 to 95, sent in the request's `agents_context` |
| `--info-file F` | No | the source's | The copy's own additional information, in Markdown, read from file `F` and sent as the request's `notes`. An empty file gives the copy none |
| `--link URL` | No, repeatable | the source's | The copy's own starting links, sent as the request's `links`: a research copy's seeds |
| `--idea TEXT` | No, repeatable | the source's | The copy's own ideas to try, sent as the request's `ideas`. A hill-climb or goal campaign only |
| `--hypothesis TEXT` | No, repeatable | the source's | The copy's own hypotheses, sent as the request's `hypotheses` |
| `--control URL` | Yes | | Control's address |
| `--token-file F` | Yes | | A file with the owner's token |

To give a research copy's workers one server with all its tools, write the list to a file and pass it:

```sh
echo '[{"name": "web-search", "agents": ["workers"]}]' > servers.json
npx thermite campaign copy survey survey-b --mcp-servers-json servers.json \
  --control https://control.example.com --token-file ~/thermite-owner-token
```

`{"name": "web-search", "agents": ["workers", "advisors"], "tools": {"workers": ["search"]}}` gives it to the advisors too, and narrows the workers to its `search` tool.

Without `--control` and `--token-file`, it ends with `give --control and --token-file: control copies the campaign` and exit code 2. A file that is not JSON ends it with `--mcp-servers-json: <file> is not a JSON list:` and the parser's message, and exit code 2. Control's refusals come back as `<url> -> <status> <body>`, such as `-> 409 {"error":"There is a campaign named sort-speed-b already. Choose another name."}`: [Copy a campaign](rest-api.md#copy-a-campaign) lists them. MCP's [`copy_campaign`](mcp-tools.md#copy_campaign) does the same with an operator's token too.

### `campaign context`

`thermite campaign context` sets a campaign's own context window and compaction point for all its runs' agents (`POST /v1/campaigns/<campaign>/context`). Control saves a new version of the campaign, with the settings in its contract's [`agents_context`](contract.md#agents-context); runs started from then take it.

```sh
npx thermite campaign context sort-speed --context-window 131072 --compact-at 70 \
  --control https://control.example.com --token-file ~/thermite-owner-token
```

It prints control's answer on one line, such as `{"campaign":"sort-speed","version":3,"contract_sha":"<sha256>","agents_context":{"context_window":131072,"compact_at":70},"said":"…"}`, and its `said` on standard error: `Version 3 of sort-speed is saved. Its runs' agents: a context window of 131,072 tokens, compaction at 70% of the window. Runs started from now take it.`

| Option | Required | Default | Meaning |
| --- | --- | --- | --- |
| `CAMPAIGN` | Yes | | The campaign, as on its page |
| `--context-window TOKENS` | No | none | The most tokens of context window each agent works with, 4,096 to 100,000,000. Each agent's window is the lower of this and its own model's |
| `--compact-at PERCENT` | No | none | The share of the window, 50 to 95, at which each agent's conversation is compacted, in place of the rig's point |
| `--control URL` | Yes | | Control's address |
| `--token-file F` | Yes | | A file with the owner's token |

Each call sets the settings anew: without either option, they are removed. A value out of range ends the command before anything is sent, with exit code 2: `--context-window and --compact-at:` and why. Without `--control` and `--token-file`, it ends with `give --control and --token-file: control keeps the campaign` and exit code 2. Control's refusals come back as `<url> -> <status> <body>`: [A campaign's context settings](rest-api.md#a-campaigns-context-settings) lists them. MCP's [`set_campaign_context`](mcp-tools.md#set_campaign_context) does the same with an operator's token too.

### `campaign additions`

`thermite campaign additions` sets your additions to a campaign's agent roles (`POST /v1/campaigns/<campaign>/additions`): your own words, from a file for each role, added to that role's instructions in every prompt of the campaign's runs. Control saves a new version of the campaign, with them in its contract's [`role_additions`](contract.md#your-additions-to-the-agents-roles); runs started from then take it.

```sh
npx thermite campaign additions sort-speed --add worker=worker-notes.md --add planner=planner-notes.md \
  --control https://control.example.com --token-file ~/thermite-owner-token
```

It prints control's answer on one line, such as `{"campaign":"sort-speed","version":4,"contract_sha":"<sha256>","role_additions":{"worker":"…","planner":"…"},"said":"…"}`, and its `said` on standard error: `Version 4 of sort-speed is saved, with additions for worker, planner. Runs started from now take it.`

| Option | Required | Default | Meaning |
| --- | --- | --- | --- |
| `CAMPAIGN` | Yes | | The campaign, as on its page |
| `--add ROLE=FILE` | No, more than once | none | One role's addition: the role's id, such as `worker` or `research-planner`, and a file whose text is added to that role's instructions. [Your additions to the agents' roles](contract.md#your-additions-to-the-agents-roles) lists the roles of each mode |
| `--control URL` | Yes | | Control's address |
| `--token-file F` | Yes | | A file with the owner's token |

Each call sets the additions anew: a role it gives no `--add` has none in the new version, and without `--add` they are all removed. A word without `=` ends the command before anything is sent, with exit code 2: `--add takes ROLE=FILE, such as worker=worker-notes.md: not …`; so does a file that can't be read: `--add worker: <file> can't be read:` and why. Without `--control` and `--token-file`, it ends with `give --control and --token-file: control keeps the campaign` and exit code 2. Control's refusals come back as `<url> -> <status> <body>`, such as a role the campaign's mode never runs: [The owner's additions to a campaign's roles](rest-api.md#the-owners-additions-to-a-campaigns-roles) lists them. MCP's [`set_campaign_additions`](mcp-tools.md#set_campaign_additions) does the same with an operator's token too.

### `kit add`

`thermite kit add` gives control a kit repository written elsewhere, as a [git bundle](https://git-scm.com/docs/git-bundle) file, with the owner's token (`POST /v1/kits/<name>`). Control keeps every commit of the bundle with its id, and a rig fetches the kit from control with [`assign --kit control:NAME`](#assign). [Give control a kit you wrote elsewhere](../how-to/campaigns/write-a-kit.md#give-control-a-kit-you-wrote-elsewhere) shows the steps.

```sh
git -C ~/src/project-kit bundle create ~/project-kit.bundle main
npx thermite kit add project-kit ~/project-kit.bundle \
  --control https://control.example.com --token-file ~/thermite-owner-token
```

It prints control's answer on one line, such as `{"name":"project-kit","head":"<commit>","previous":null,"commits":12,"kit":{"name":"project-kit","target":"cpu"},"forced":false,"refs":[…],"size":48213,"said":"…"}`, and its `said` on standard error: `Control keeps the kit project-kit at 5f0c1d2e3a4b (12 commits). Rigs fetch it with the source {"control": "kits/project-kit"}.`

| Option | Required | Default | Meaning |
| --- | --- | --- | --- |
| `NAME` | Yes | | The kit's name in control: lowercase letters, digits, dots, dashes and underscores, at most 64, starting with a letter or digit. Give it the contract's `project.kit.repo` |
| `BUNDLE` | Yes | | The bundle file, at most 64 MiB |
| `--ref REF` | No | The bundle's `HEAD`, or its only branch | The kit's head: a branch or a tag the bundle has, or a full commit id in it |
| `--force` | No | Off | Make the head a commit that does not descend from the kit's head. The old head's commits stay on control |
| `--control URL` | Yes | | Control's address |
| `--token-file F` | Yes | | A file with the owner's token |

A refusal ends the command with `control refused the kit (<status>): ` and control's words (exit 2): [Kits control keeps](rest-api.md#kits-control-keeps) lists them. A bundle file it can't read ends it with the file's name and why. Without `--control` and `--token-file`, it ends with `give --control and --token-file: control keeps the kits` (exit 2). MCP's [`kit_add`](mcp-tools.md#kit_add) does the same with an operator's token too, for a bundle of at most 3,000,000 bytes.

### `kit list`

`thermite kit list` lists the kits control keeps (`GET /v1/kits`), with the owner's or the reader's token: one line for each, `<name>  <head>  <n> commits  <kit.json's name> on <target>`, or `control keeps no kit`. A kit whose head has no valid `kit.json` shows why in place of its name and target. `--json` prints the route's answer.

```sh
npx thermite kit list --control https://control.example.com --token-file ~/thermite-owner-token
```

### `kb`

`thermite kb search` searches Thermite's [knowledge base](knowledge-base.md#search), as `GET /v1/kb/search` and MCP's `kb_search` do; `thermite kb read` reads one item, as `GET /v1/kb/item` and `kb_read` do. Each prints control's answer as JSON on one line.

```sh
npx thermite kb search which approaches failed to improve speed --collection sort-speed \
  --control https://control.example.com --token-file ~/thermite-owner-token
npx thermite kb search unroll --query "loop unrolling" --kind experiment --outcome regress \
  --control https://control.example.com --token-file ~/thermite-owner-token
npx thermite kb read sort-speed/sort-speed-1/records/experiment:x-3 \
  --control https://control.example.com --token-file ~/thermite-owner-token
```

| Option | Required | Default | Meaning |
| --- | --- | --- | --- |
| `search [WORDS...]` | | | The words to find: an item matches with any of them, best first. None: the newest items |
| `read ADDRESS` | | | The item's address, `<campaign>/<run>/<slot>/<kind>:<id>`, as a search gives it |
| `--query Q` | No, repeatable; search only | | One more search, up to 5, fused with the words by reciprocal rank fusion |
| `--mode M` | No; search only | `words` | `words`, or `exact`: FTS5's own syntax ([Search](knowledge-base.md#search)) |
| `--like ADDRESS` | No; search only | | More like this item, by its own most telling words |
| `--seen ADDRESS` | No, repeatable; search only | | An item to leave out, up to 100 |
| `--collection C` | No, repeatable; search only | every collection | A collection to search, by its campaign |
| `--kind K` | No, repeatable; search only | every kind | Only items of this kind |
| `--outcome O` | No, repeatable; search only | every outcome | Only experiments and attempts that ended so: `won`, `screened`, `regress`, `neutral`, `broken`, `unclear`, `dropped` or `open` |
| `--run R` | No, repeatable; search only | every run | Only this run's items |
| `--slot S` | No, repeatable; search only | every slot | Only this slot's items, such as `records` or `planner` |
| `--offset N` | No | 0 | Search: where the page starts, a page's `next_offset`. Read: where the text starts, in characters |
| `--limit N` | No; search only | 10 | How many hits, 1 to 50 |
| `--version N` | No; read only | its newest | One of the item's versions |
| `--control URL` | Yes | | Control's address |
| `--token-file F` | Yes | | A file with the owner's token |

A search prints `{note, collections, matched, next_offset, counts, words, did_you_mean, hits}` (and `like`, the words "more like this" searched with), each hit with its `id` (`run start --past` takes it), `address`, `slot`, `outcome`, `excerpt`, `why`, `passage` and, for an experiment, its `result`; a read prints `{note, item}`, the item's text from the offset with `chars` and `next_offset`. Control's refusal ends it with exit code 2 and control's words, such as `bad request: kinds.0: …`, `the exact search is not FTS5's query syntax: …` or `the knowledge base has no item <address>`. Before it sends anything, it ends with exit code 2 and `kb read takes one item's address: <campaign>/<run>/<slot>/<kind>:<id>`, `kb read takes only an address, --version and --offset: kb search takes the others` or `kb search takes no --version: kb read does`.

### `agents list`

`thermite agents list` lists every agent role Thermite runs (`GET /v1/agents`), with the owner's token: one line for each, `<id>  <name>: <what it does>`. `--json` prints the route's answer. [Agent roles](agent-roles.md) lists the same roles with their texts.

```sh
npx thermite agents list --control https://control.example.com --token-file ~/thermite-owner-token
```

### `agents show`

`thermite agents show ROLE` shows one role's definition (`GET /v1/agents/<role>`): what it does, its model and agent programs, the function that puts its prompt together for a run, and each of its fixed texts, under a `# <id>: <where it goes>` line.

With `--run RUN`, it shows the newest prompt the run's agent in that role was sent, or the one `--prompt N` names (`GET /v1/runs/<run>/prompts/<id>`): a first line with its number, rig, role, agent program, lane, trial or call, its role's version and its size, then each section under `# <part> · <id> · from <source> · <n> characters`, with its text. A section from the role's definition says so; one control has only part of says `cut: the whole is on the rig and in the run's export`. `--sections` prints those lines alone, without the texts. `--json` prints the route's answer. A run that sent no prompt to that role ends with `<run> has sent no <role> a prompt yet` (exit 2). See [What a run's agents were sent](agent-roles.md#what-a-runs-agents-were-sent).

```sh
npx thermite agents show worker --run matmul-3 --sections --control https://control.example.com --token-file ~/thermite-owner-token
```

### `mcp`

The MCP servers in **Settings › Providers**, with the owner's token ([Manage MCP servers](../how-to/operate/mcp-servers.md)). Every subcommand takes `--control URL` and `--token-file F`. A secret comes from a file, never from the command line, where other users of the machine could see it.

```sh
thermite mcp add gbrain --url https://brain.example.com/mcp --auth key --secret-file brain.secret \
  --control https://control.example.com --token-file ~/.thermite/owner-token
```

| Command | Route | What it prints |
| --- | --- | --- |
| `thermite mcp list` | `GET /v1/mcp-servers` | One line for each server, `<name>  <auth> <secret's last four characters>  <status>  <n> tools  <url>  named by <kits>` (`<status>` is `ok`, `failing`, `needs_sign_in` or `unchecked`), then its last error and its tools, a tool that may write marked `(writes)`. `no MCP server in Settings` when there is none. `--json` prints the route's answer |
| `thermite mcp add NAME --url URL --auth KIND` | `POST /v1/mcp-servers` | The server's lines, then `its tools were not read: <why>` when they could not be read, or, for `--auth oauth`, `open this address within 15 minutes and allow Thermite:` and the address of its sign-in page, or the reason the sign-in could not start |
| `thermite mcp change NAME` | `PUT /v1/mcp-servers/NAME` | The server's lines, and `its tools were not read: <why>` when they could not be read. For an OAuth server whose address or client changed, only its lines: sign in again with `thermite mcp sign-in NAME` |
| `thermite mcp check NAME` | `POST /v1/mcp-servers/NAME/check` | The same |
| `thermite mcp sign-in NAME` | `POST /v1/mcp-servers/NAME/sign-in` | `open this address within 15 minutes and allow Thermite:` and the address |
| `thermite mcp delete NAME` | `DELETE /v1/mcp-servers/NAME` | `NAME is deleted: control keeps nothing of its secrets` |

The options of `add` and `change`:

| Option | Meaning |
| --- | --- |
| `--url URL` | The server's MCP address: `https://`, or `http://` for `localhost`, `127.0.0.1` and `[::1]` only |
| `--auth oauth\|key\|client\|none` | How it signs Thermite in. Required for `add`. With `change`, another sign-in needs its secret again |
| `--header H` | `key`: the header the key goes in. Default `Authorization` |
| `--secret-file F` | `key`: a file with the header's whole value, such as `Bearer` and the token |
| `--client-id ID` | `client`, or `oauth` for a server that does not register clients by itself |
| `--client-secret-file F` | `client`: a file with the client secret |
| `--scope S` | The scopes to ask for, separated by spaces |

A refused request ends the command with the route's answer, such as `… -> 409 {"error":"q4-gemv-kit names it. Take it out of that kit first.","named_by":["q4-gemv-kit"]}` (exit 2).

### `command`

`thermite command` sends any [signed command](signed-commands.md) through control (`POST /v1/commands`) and prints control's answer on one line, such as `{"id":"<command id>","status":"pending"}`. For `assign_campaign` and `resume_run`: on a [rig launched on RunPod](rest-api.md#rigs-on-a-gpu-cloud) whose pod is stopped, control starts the pod first; the answer's `woke` says so, and the command also prints those words on standard error: `rp-1a2b3c4d's pod was stopped: control started it. The run starts once the pod runs.` When control can't start it, the command is not sent, and it ends with control's `409` and the reason, such as no GPU free at RunPod or the spend limit reached.

| Option | Required | Default | Meaning |
| --- | --- | --- | --- |
| `--control URL` | Yes | | Control's address |
| `--token-file F` | Yes | | A file with the owner's token |
| `--rig U` | For a kind about the rig | The run's rig | The rig. A kind about one run (its payload's `run`, every kind but `assign_campaign`, `rig_check`, `export_now`, `drain_rig`, `rig_settings` and `wipe_state`) goes to the rig the run is on: leave it out, or give that rig. Control refuses another, and a run that is an earlier one, in words: [Signed commands](rest-api.md#signed-commands) lists them |
| `--kind K` | Yes | | The command's kind, such as `pause_run`, `rig_check` or `queue_add` |
| `--payload JSON\|@file` | Yes | | The payload as JSON, or `@` and a file that holds it |
| `--ttl MIN` | No | `60` | Minutes before it expires: 1 to 10080 |

It takes every kind but `wipe_state`, the owner's commands for a run's experiment queue among them. For example, this adds an experiment at the top of `run-1`'s queue (without `position`, it goes to the end):

```sh
npx thermite command --control https://control.example.com --token-file ~/thermite-owner-token \
  --kind queue_add \
  --payload '{"run":"run-1","title":"unroll the inner loop by 4","why":"the profile shows loop overhead","position":"top"}'
```

A run you no longer want is closed for good with `close_run`, as **Close run** on its page does:

```sh
npx thermite command --control https://control.example.com --token-file ~/thermite-owner-token \
  --kind close_run --payload '{"run":"run-1","reason":"another run finished the work"}'
```

A rig's own settings, as **Edit rig** has them, go with `rig_settings` and only the fields to change ([`rig_settings`](signed-commands.md#rig_settings) lists them). This runs the next trials' Claude Code, Codex or OpenCode headless on `rig-1`, not in its own terminal, the default:

```sh
npx thermite command --control https://control.example.com --token-file ~/thermite-owner-token \
  --rig rig-1 --kind rig_settings --payload '{"program_mode":"headless"}'
```

Unlike [`POST /v1/rigs/<rig>/settings`](rest-api.md#a-rigs-settings), it sends the fields as given, without comparing them with what the rig reports.

The owner's input to a running trial's terminal goes with [`terminal_input`](signed-commands.md#terminal_input). This gives a worker in Pi words to take when it would stop, as a follow-up, rather than before its next model call:

```sh
npx thermite command --control https://control.example.com --token-file ~/thermite-owner-token \
  --kind terminal_input --payload '{"run":"run-1","trial":"t-0123456789abcdef","text":"then run the tests","follow_up":true}'
```

Control refuses `wipe_state` with `400 {"error":"wipe_state is issued only by a full reset"}`, and a payload that does not fit its kind with `400 {"error":"bad <kind> payload: …"}` (an unknown rig: `404`). `GET /v1/commands/<id>` and the dashboard's **Commands** page show the command's status. A command the rig refuses, such as a `queue_move` for an experiment that is no longer queued, shows there as `failed`, with the reason.

### `invalidate`

`thermite invalidate` withdraws bad evidence ([`invalidate_evidence`](signed-commands.md#invalidate_evidence)), the owner's alone: an attempt, for good, with every attempt built on it, or the measurements of one of the judge's jobs, whose attempts are judged again. It always asks the rig first what it would reach, and prints it; nothing changes then. With `--yes` it sends the withdrawal next, naming what the preview reached, so the rig does exactly that or refuses. [Withdraw bad evidence](../how-to/campaigns/withdraw-bad-evidence.md) says what to check first.

| Option | Required | Default | Meaning |
| --- | --- | --- | --- |
| `--control URL` | Yes | | Control's address |
| `--token-file F` | Yes | | A file with the owner's token |
| `--run RUN` | Yes | | The run. Control sends the command to the rig the run is on |
| `--attempt ID` | One of the two | | An attempt of the run: withdrawn for good, with every attempt built on it |
| `--job N` | One of the two | | A judge job of the run that finished: its measurements are withdrawn, and the attempts whose verdict rests on them, and those built on them, are judged again |
| `--reason TEXT` | Yes | | Why, 1 to 2000 characters. The record keeps it, and every page that shows the withdrawal says it |
| `--yes` | No | Off | Withdraw it once the preview is printed. Without it, nothing is withdrawn |

```sh
npx thermite invalidate --control https://control.example.com --token-file ~/thermite-owner-token \
  --run sort-speed-1 --attempt a-0123abcd4567ef89 --reason "it reads the timer it is measured with"
```

```text
What withdrawing it reaches:
Attempt a-0123abcd4567ef89 and the 1 attempt built on it (a-89ab01cd23ef4567) are withdrawn for good: none is judged again, and none can become the champion.
2 verdicts are superseded by an invalidated verdict. Nothing is deleted: the old verdicts stay in the record.
Champions #2 (a-0123abcd4567ef89) and #3 (a-89ab01cd23ef4567) are reopened.
The run's champion moves back from #3 to #1, the starting point: new trials build on it.

  a-0123abcd4567ef89  win_confirmed, promoted  ->  withdrawn for good
  a-89ab01cd23ef4567  win_confirmed, promoted  ->  withdrawn for good
```

On standard error it then says `Nothing was withdrawn. To withdraw it, run this again with --yes.` With `--yes`, the same lines come first, then `Withdrawn: invalidation <n> on the rig.` It waits for the rig's answer to each command, asking control every 2 seconds, until the rig's signed report confirms it (`GET /v1/commands/<id>`); a refusal, such as `the rig refused it (command <id>): what it reaches changed since the preview: preview it again, and confirm what it reaches now`, an expiry, or no answer within 10 minutes ends it with exit code 1.

### `submit`

`thermite submit` sends a change to a harness as a proposer (`POST /v1/attempts`), the way a person or a script tests a kit by hand. See [Test a kit with known candidates](../how-to/campaigns/test-a-kit.md).

| Option | Required | Meaning |
| --- | --- | --- |
| `--harness URL` | Yes | The harness's API, such as `http://127.0.0.1:8700` inside the harness container |
| `--token-file F` | Yes | A file with the harness's proposer token (`THERMITE_PROPOSER_TOKEN_FILE` on the harness; `/run/secrets/harness-proposer-token` under compose). Without a proposer token on the harness, every submission is refused |
| `--run ID` | Yes | The run |
| `--patch-file P` | Yes | A patch from `git diff --binary` against the run's champion |
| `--hypothesis TEXT` | Yes | What the change does and why it should help: 1 to 4000 characters |
| `--known-flaw TEXT` | No, repeatable | A flaw you know of, 1 to 1000 characters each, at most 50 |

It prints the harness's answer on one line: `{"attempt":"<id>","lifecycle":"queued","commit":"<commit>","violations":[]}`. `lifecycle` is `queued`, `rejected_v0` (the change broke a rule before judging, listed in `violations`) or `duplicate` (with `duplicate_of`). The [verdicts reference](verdicts.md) lists the states.

### `status`

`thermite status --harness URL --token-file F --attempt ID` prints what the harness knows of an attempt (`GET /v1/attempts/ID`): `attempt`, `run`, `lane`, `lifecycle`, `commit`, `v0`, `violations`, `verdict` and `held_out`. The token is the proposer's or the supervisor's.

It prints the harness's answer whatever its HTTP status, and exits 0 even when the harness answers with an error such as `no attempt <id>`.

### `local init`

`thermite local init DIR [--engine docker|podman]` makes `DIR`, the `.dev` folder that the local compose stack reads, and keeps every file that is there already. Then it says what the local rig gets, and on a machine with NVIDIA GPUs the rig can have, it writes `compose.gpu.yaml` next to `DIR`. A release's compose file runs it in its `init` service as `thermite local init /work/.dev`, with the folder of `compose.yaml` mounted at `/work`. In a checkout of the source code, `npm run dev:init` makes the same folder without a build, and says nothing about the machine. It needs no network.

| What | Mode | Made |
| --- | --- | --- |
| `DIR` itself | 0700, set again at every run | When missing. Only its owner may open it, so no other user of the computer reaches the tokens, the inbox or the advisors' keys. The containers mount the folders and files in it, which their own users reach as the modes below say |
| `secrets/`, `outbox/`, `advisors/`, `backups/` | 0755 | When missing. The compose stack's `backup` service writes [backups](../how-to/operate/backup-and-restore.md) into `backups/` |
| `inbox/`, `inbox/repos/`, `inbox/models/` | 0777, set again at every run | When missing. The supervisor writes into the inbox as its own user |
| `secrets/control-admin-token`, `control-operator-token`, `harness-supervisor-token`, `harness-proposer-token`, `harness2-supervisor-token`, `harness2-proposer-token` | 0644, so that control's and the supervisors' users in their containers can read them | When missing: 24 random bytes each, base64url-encoded |
| `secrets/control-rig-token`, `control-rig-token-2` | 0644 | When missing: empty. [`local enroll`](#local-enroll) writes each rig's token, which control makes, at each `up` |
| `secrets/model-api-key` | 0644 | When missing: `local-placeholder` |

Run as root, when the folder that holds `DIR` belongs to another user, it gives what it makes to that user and group, and says so. It prints `made` and the path of each folder and file it made, never a token, then what the rig gets, then `local init: <name> ready (<n> made, <m> kept)`, where `<name>` is the last part of `DIR`. Without `DIR`, it prints the usage text on standard error and exits 2.

| Option | Default | Meaning |
| --- | --- | --- |
| `--engine docker` or `--engine podman` | In a container, the one that runs it. On the machine: the one that can give containers the GPUs, else Docker, else Podman | The engine that the rig runs on, and that `compose.gpu.yaml` is written for. Any other value: `--engine is docker or podman`, exit 2 |

**What the rig gets.** Lines that start with `rig:` say what the local rig can use, as the **Local rig** check of [`doctor`](#doctor) does: the CPUs and memory, the NVIDIA GPUs it can have and how the judge and the agents split them, AMD GPUs and a Mac's Apple GPU, which it doesn't use, and a line that starts with `rig: Fix:` when GPUs are kept from it. [What the rig gets](../how-to/install/one-machine.md#what-the-rig-gets) says what each kind of machine gets. Where it looks depends on where it runs:

| Where it runs | What it reads | Whether the engine can give containers the GPUs |
| --- | --- | --- |
| On the machine | `docker info` or `podman info`, `nvidia-smi`, `nvidia-ctk`, `lspci`, `/sys/class/drm` | Checked: NVIDIA's runtime for Docker, a CDI spec for Podman |
| In a container, as the release's `init` service | The container's CPUs and memory, the GPUs under `/proc/driver/nvidia/gpus`, and `/sys/class/drm`. The engine is the one that runs the container, from the file it puts there (`/.dockerenv` or `/run/.containerenv`) | Not checked: its `rig:` line says to run `thermite doctor` on the machine |

**`compose.gpu.yaml`.** When the rig can have NVIDIA GPUs, `local init` writes `compose.gpu.yaml` in the folder that holds `DIR` (when `DIR` is a link, the folder that holds its target), mode 0644, again at every run, and prints `wrote compose.gpu.yaml: start Thermite with docker compose -f compose.yaml -f compose.gpu.yaml up -d` (or `podman compose`). It changes only the `harness` service:

| What | Value |
| --- | --- |
| `image` | `${THERMITE_RIG_HARNESS_CUDA_IMAGE:-…}`, with the release's CUDA harness from `compose.yaml` after `:-`. Next to a checkout's `compose.yaml`, which builds the harness, it builds it on the CUDA base instead, as `thermite-harness:local-cuda`. With neither, compose stops and asks for `THERMITE_RIG_HARNESS_CUDA_IMAGE` |
| `THERMITE_TARGET` | `cuda-gpu` |
| `THERMITE_GPUS` and `THERMITE_JUDGE_GPUS` | With two GPUs or more: the GPUs as the container numbers them, and the judge's share: 1, or more when the agents would get more than 8. With one GPU: `THERMITE_GPU_INDEX` `0` |
| Docker | A device reservation for NVIDIA's driver: `count: all`, `capabilities: [gpu]` |
| Podman | The CDI device `nvidia.com/gpu=all`, and `label=disable` |

A rig takes 16 GPUs at most. On a machine with more, the file names the first 16 by number in place of all of them.


### `local enroll`

`thermite local enroll RIG --control URL --token-file F --out FILE` is the local compose stack's enroll step: each `up` runs it in the `enroll` service for `local-1` (and in `enroll-2` for `local-2`, with the `two-rigs` profile), as `thermite local enroll local-1 --control http://control:8800 --token-file /run/secrets/control-admin-token --out /enroll/control-rig-token`, with `.dev/secrets/control-rig-token` mounted at `/enroll/control-rig-token`. The rig's supervisor starts only once it has finished.

1. It asks control for its rigs (`GET /v1/rigs`) with the owner's token in `F`, again every 2 seconds while control does not answer or answers 503 as it starts, for 5 minutes at most. Then it stops with what the last try got, and exits 2 for an answer that refused.
2. A rig the owner retired is left as it is: `local enroll: <rig> is retired in control: it is not enrolled again. Bring it back on its page to use it.`
3. A rig control has enrolled, with a token in `FILE`: the token is kept. It prints `local enroll: <rig> is enrolled with control: its token is kept`.
4. A rig control has enrolled, with `FILE` empty or missing: control gives it a new token (`POST /v1/rigs/<rig>/token`), and the old one stops working. It prints `local enroll: <rig> is enrolled with control and its token file was empty: control made it a new token`.
5. A rig control does not have enrolled, such as on the first `up`, after control's volume was removed, or after the owner brought a retired rig back: control enrolls it (`POST /v1/rigs`). It prints `local enroll: <rig> enrolled with control`.

In cases 4 and 5 it writes the token into `FILE`, in place, mode 0644 for a file it makes. It never prints a token. Control keeps only the token's SHA-256. A token you replaced with [`rig token`](#rig-token) goes into `FILE` by hand: the step keeps whatever token `FILE` holds while control has the rig enrolled.
### `selftest isolation`

`thermite selftest isolation [--force]` runs the isolation check inside the harness container, as root: it checks that each role's user is refused the ledger, the kits, the builds, the secrets and anything else it must not reach. It prints the report as indented JSON (`ok`, `devices`, `roles`, `skipped`) and exits 1 if `ok` is false.

| Option | Meaning |
| --- | --- |
| `--force` | Probe even while trials or judge jobs are open. Each probe ends every process of the role it tests, so those trials and jobs end too |

Without `--force`, a busy rig is refused, with exit 2: `the rig is busy: <n> open trial(s) and <m> judge job(s): pause the rig's runs and let the judge finish first (each probe kills its role's processes); rerun with --force to probe anyway`.

It reads where the broker's socket and the rig's directories are from `THERMITE_BROKER_DIR` (default `/run/thermite`), `THERMITE_STATE_DIR` (`/var/lib/thermite`), `THERMITE_SCRATCH_DIR` (`/scratch`) and `THERMITE_OUTBOX_DIR` (`/outbox`), and probes the rig's secret files: the model routes control set for the agents and for the planner (`model-route.json` and `model-route-planner.json` in the state directory), the files named by `THERMITE_SUPERVISOR_TOKEN_FILE`, `THERMITE_PROPOSER_TOKEN_FILE` and `THERMITE_MODEL_API_KEY_FILE`, and, in the one-container rig image, the tunnel's `keys.json` in `THERMITE_TUNNEL_DIR`. The same check, with the same files, runs from the dashboard as a rig check; see [Rig checks](rig-checks.md) and [Check a rig](../how-to/operate/check-a-rig.md).

### `backup`

`thermite backup FOLDER [--state DIR] [--bus URL]` backs up control: its state folder and every rig's events on the message bus. It runs where control's state folder is mounted and the bus is reached as control reaches it; under compose, in the `backup` service, which mounts control's state and `.dev/backups` at `/backups`. Control may go on running. [Back up and restore control](../how-to/operate/backup-and-restore.md) gives the steps for each placement.

```sh
docker compose --profile backup run --rm backup thermite backup /backups
```

It makes a new folder in `FOLDER`, named for the time, such as `thermite-backup-2026-10-29T10-00-00-000Z`, written first as `<name>.partial` and renamed once its manifest is written. A folder that still ends in `.partial` is a backup that stopped part way: no restore reads it.

| In the backup | What |
| --- | --- |
| `state/control.db` | Control's store, copied first, whole and consistent while control writes to it (`vacuum into`) |
| `state/control-signing.key`, `control-signing.pub`, `secrets.key`, `bus-ca.pem`, `bus-ca.key`, `bus-backup.seed` | Control's keys, each as it is in the state folder, with its mode. A secrets key kept elsewhere (`THERMITE_CONTROL_SECRETS_KEY_FILE`) is not in it |
| `state/kits/`, `state/exports/`, `state/kb-files/` | The kits control keeps, the exports of rigs without a results repository and the knowledge base's files, file by file |
| `streams/EVENTS.snapshot` | The bus's `EVENTS` stream, every rig's events, as the server's snapshot API gives it, taken after the store |
| `manifest.json` | Each file's path, size and SHA-256; the stream's message count, first and last place, bytes, last message's SHA-256 and settings; control's place in each stream (`bus_position`), which is at or before the stream's end; the store's schema version; the Thermite version and commit that made it; and the streams left out, with why |

It leaves out the `REPORTS`, `COMMANDS`, `LIVE`, `CONFIG` and `KB_FILES` streams: a page waits in `REPORTS` only until control takes it, and a rig sends again what control lacks; control keeps every command in its store and publishes those still pending again as it starts; `LIVE` holds the newest live lines, which the rigs make again; control writes each rig's config again from its store; and a chunk waits in `KB_FILES` only until control keeps its file in its state, which the backup holds. It prints each step, then `backup: <folder> (<n> files, 1 streams)`.

| Option | Default | Meaning |
| --- | --- | --- |
| `--state DIR` | `THERMITE_CONTROL_DIR`, else `/var/lib/thermite-control` | Control's state folder. One without `control.db`: `<dir> holds no control.db: give control's state folder with --state`, exit 2 |
| `--bus URL` | `THERMITE_NATS_URL` | The bus, as control reaches it. It signs in as the backup's own user, with the seed in `bus-backup.seed`, and trusts the server through `bus-ca.pem`, both in the state folder. Control makes the seed as it starts; without it: `<file> is not there: control makes the backup's key on the bus as it starts. Start control once, then run this again`, exit 2 |

A failure, such as the bus away or `FOLDER` missing, says why and exits 2, leaving the `.partial` folder.

### `restore`

`thermite restore BACKUP [--state DIR] [--bus URL] [--control URL] [--bus-store DIR]` puts a backup back, with control stopped. It runs where `backup` runs. [Restore a backup](../how-to/operate/backup-and-restore.md#restore-a-backup) gives the steps.

```sh
docker compose stop control
docker compose --profile backup run --rm backup thermite restore --control http://control:8800 /backups/thermite-backup-2026-10-29T10-00-00-000Z
```

In order, it:

1. With `--control`, asks control's health there, and refuses while control answers: `control answers at <url>: stop it first`.
2. Checks every file of the backup against its manifest: there, its size and its SHA-256. A file that differs: `<path> is not the file the backup's manifest names: it changed`.
3. For each stream in the backup: where the bus has none of that name, restores it through the server's restore API, printing the memory the server needs for it (about 1 KiB a message, over 128 MiB), then checks the stream it finds against the manifest. Where the bus has one already, it checks that one the same way, and leaves it as it is. The check keeps a stream that holds the backup's events unchanged, with or without newer ones after them: its first place is the backup's, its last place is the backup's or after, it holds one message more than the backup for each place more (the stream deletes none, so every place holds one), and its message at the backup's last place has the SHA-256 the manifest gives. For a stream with newer events, as on a bus that ran on since the backup, it prints `EVENTS on the bus holds the backup's events and <n> newer ones after them, to <last>: control applies them from its place, <place>, as it starts`; control, started on the restored store, applies them from its place in the backup. Any other stream is refused, naming what differs: `EVENTS on the bus is not the backup's: <what differs>. …`, such as `it holds <n> messages to <n>, and the backup holds <m> to <m>`, which a server stopped part way through a restore leaves, `its message at <m>, the backup's last place, is not the one the backup recorded`, `its first place is <f>, and the backup's is <g>`, or `…: a place holds no message, and this stream deletes none`.
4. Puts control's state back: each of control's files and folders that is there now (`control.db` with its `-wal` and `-shm`, the keys, `kits/`, `exports/`, `kb-files/`) is moved into `replaced-<time>/` in the state folder, and the backup's are copied in, given to the state folder's owner when it runs as root. Nothing is deleted, and files that are not control's stay. A state folder that holds the backup's files already is left as it is.

A refusal at any step changes no file of control's, prints `restore refused: <why>` on standard error, and exits 1. It ends with `restored: start control, and it applies the events from its place in the stream`.

| Option | Default | Meaning |
| --- | --- | --- |
| `--state DIR`, `--bus URL` | As for `backup` | Control's state folder, and the bus. It signs in with the backup's seed in the state folder before it puts anything back, which the bus's server knows |
| `--control URL` | None: not asked | Control's address, such as `http://control:8800` in the compose stack: the restore refuses while control answers there |
| `--bus-store DIR` | None | The bus's store, mounted (`/bus-store` in the `backup` service), with the bus stopped: it checks the backup, then only moves everything in `DIR` into `DIR/replaced-<time>/`, so that the bus starts with an empty store, and says to run the restore again without it. The bus answering at its address: `the bus answers at <host>: stop it first, then set its store aside`, exit 1 |

## `thermite-trial`

`thermite-trial` is in the harness image only (`/usr/local/bin/thermite-trial`, which runs `node /opt/thermite/dist/harness/agents/trial-cli.js`). A worker agent that works through its own shell, under OpenCode, Claude Code or Codex, uses it to submit its change, run a command on the device, read an attempt, propose an idea for the run's [experiment queue](signed-commands.md#queue_add), keep [field notes](knowledge-base.md#field-notes), and record the sources it reads with five of its `research` commands. A research worker under OpenCode uses all its `research` commands, and may propose ideas and keep field notes too. It runs as the [lane](glossary.md)'s user, in the trial's workspace (a research trial's: its lane's working area), with the trial's own token, which stops working when the trial ends.

```text
usage:
  thermite-trial submit --hypothesis TEXT [--claim TEXT] [--flaw TEXT]...
  thermite-trial dev-run [--timeout SECONDS] -- COMMAND...
  thermite-trial status ATTEMPT
  thermite-trial idea TITLE [--why TEXT] [--family TEXT] [--details TEXT] [--question N]
  thermite-trial note --kind KIND [--about TYPE:ID] TEXT
    KIND: observation, decision, surprise, question, lesson or note
    TYPE: run, experiment, attempt, source, claim, finding, round, trial or message
      (no --about: the note is about the run)
  thermite-trial research TOOL ... (thermite-trial research help lists them)
```

| Command | What it does | Prints |
| --- | --- | --- |
| `submit --hypothesis TEXT [--claim TEXT] [--flaw TEXT]...` | Stages and diffs only the trial's editable paths, then submits the change. The hypothesis and the claim are cut to 2000 characters, each flaw to 1000. Submitting ends the trial | `submitted <attempt>: <lifecycle>. The trial ends with this submission.`, with `; refused: <violations>` before the last sentence when the change broke a rule |
| `dev-run [--timeout SECONDS] -- COMMAND...` | Runs the command on the measurement device, as a [development run](glossary.md), in the trial's workspace | The run's result as indented JSON |
| `status ATTEMPT` | Shows an attempt of this campaign on the rig: this lane's, another lane's or an earlier run's, with `violations` for a change the static checks refused | The attempt as indented JSON |
| `idea TITLE [--why TEXT] [--family TEXT] [--details TEXT] [--question N]` | Proposes another experiment for the run's queue, as the lane's idea: something worth trying that is not the trial's own work. The words after `idea` are its title, cut to 200 characters; `--why` is cut to 2000, `--family` (its direction) to 80 and `--details` to 4000. A repeated option keeps its last value. A title that is one word naming a command (`submit`, `dev-run`, `status`, `idea`, `note`, `research`, `list`, `ls`, `show`, `help`, `-h`, `--help`) is refused, so a slip does not become an idea; a longer title that starts with one is fine. The idea waits until the planner or the campaign's owner queues it or drops it, and the trial goes on. Without the planner's model (none set, its answer refused, the planner off, or a research run), it waits for the owner. No limit is set on how many. In a research run, `--question` names the question the task is about, by its index from 0 (a question the run does not have is refused, and so is `--question` in another run), and an idea whose words ask for a measurement is refused: `this asks for a measurement ("<words>"), and a research run measures nothing: record it as a next experiment in a report section or a note (what it would settle, and how), and propose only work that sources can answer` ([Research](../explanation/campaign-modes.md#research) says what the rule looks for) | `proposed <experiment id>: it waits until the planner or the campaign's owner queues it or drops it. Your trial goes on.` |
| `note --kind KIND [--about TYPE:ID] TEXT` | Writes a [field note](knowledge-base.md#field-notes) for the run's journal: an observation, a decision and why, a surprise, a question or a lesson. The words after the options are its text, 1 to 2000 characters. `--kind` is one of the kinds in the usage text, in any case. `--about` names one record of the run it is about, such as `attempt:a-11110003` or `round:12`, or the run itself, as `run:<run>`; a round or a message is named by its number. Without `--about`, the note is about the run. A repeated option keeps its last value. The note is recorded as the lane's, and the trial goes on. No limit is set on how many. In a research run, a note that repeats one of the run's last 200 field notes word for word (case, punctuation and spaces aside), whoever wrote it, is refused: `this note repeats field note #<id> (by <writer>, <time>) word for word: it is not recorded again. Note what is new, or go on with the work` | `noted (#<id>). Your trial goes on.` |
| `research TOOL [WORDS...] [--FLAG VALUE]... [-]` | Runs one of a research trial's tools (below) through the harness's research service. The words fill the tool's main field and the flags its others; `-` reads a JSON object of fields from standard input | The tool's answer: text as it is, anything else as JSON, at most 14,000 characters. A cut is always said: a text read from an offset is cut with `next_offset` and where to read on, anything else ends `… [cut: this answer has <n> characters, and only its first 13800 are shown]` ([Limits and pacing](limits-and-pacing.md#checks-and-research)) |
| `research help` | Lists the research tools | `research tools:` and each tool's use, then the limits of a claim: `add_claim: The text has 5 to 4,000 characters. A claim has 1 to 10 quotes, and each quote has 20 to 2,000 characters: give a short phrase with the words around it.` |

The research tools are a Pi research worker's, without its file tools. In a hill-climb or goal trial only five of them work: `fetch`, `read_source`, `search_corpus`, `add_claim` and `add_note`. They archive the pages a worker reads and record what they say in the run's research folder. The harness refuses the others there: `a hill-climb run records sources, claims and notes only (fetch, read_source, search_corpus, add_claim, add_note); the rest belongs to research runs` (`a goal run` in a goal campaign). `research help` lists all eleven.

| Tool | Words | Flags | What it does |
| --- | --- | --- | --- |
| `fetch` | `URL` | | Fetches a web page; the harness archives it and returns the first 6,000 characters of its text, with `next_offset` when there is more, and its links (as many of the first 60 as fit in 5,000 characters, with `links_not_shown` for the rest) |
| `read_source` | `SOURCE` | `--offset N`, `--length N` | Reads more of an archived source's text, from an offset: 6,000 characters by default and at most 10,000. While more is left, the answer has `next_offset` and `more`, such as `4000 more characters: read_source s-3f2a9c41d0b7 with offset 16000` |
| `search_corpus` | `TEXT` | `--skip N` | Searches the archived sources for a piece of text, ignoring case: a page of at most 30 matches, each with 500 characters around it, and fewer when they would not fit the answer. When more sources match, the answer has `next_skip`, which `--skip` takes for the next page |
| `add_claim` | none | `--text`, `--question N`, `--confidence N`; the quotes only through `-` | Records a claim with exact quotes from archived sources. Unverified quotes leave it a draft. Its text has 5 to 4,000 characters, and it has 1 to 10 quotes of 20 to 2,000 characters each. A claim outside these is refused and not recorded, with each field and what is wrong: `error: 400: {"error":"invalid request: quotes[0].quote has 9 characters; it needs at least 20"}`. Each quote's `source` is the source's id, `s-…`, as `fetch` returned it; its address and its file name are taken too (below). `question` is the index of the campaign question it answers, from 0. In a research run with more than one question, a claim without it is refused and not recorded (`give "question": the index of the campaign question this claim answers, from 0 to <n-1>, …`), as is an index the campaign has no question for (`no question <n>: …`); with one question, a claim without it answers that one. In a hill-climb or goal run it is left out |
| `add_note` | `TEXT` | `--source SOURCE`, repeated | Records a research note, with the sources it relies on: its text cut to 4000 characters, at most 20 sources. An empty text is refused: `a note needs its text`, and so is a note that repeats one of the run's last 200 research notes word for word, case, punctuation and spaces aside: `this note repeats note <id> (by <lane>, <time>) word for word: it is not recorded again. Record what is new, or go on with the work`. A research note is not a field note |
| `propose_hypothesis` | `TEXT` | `--question N`, `--supporting CLAIM`, repeated | Proposes a new hypothesis for the run's pool: `question` is the index of the campaign question it is about, from 0 (none: the whole run), and the supporting claims are verified claims of the run (others are listed as `ignored`). Its text is cut to 2000 characters. Refused, with nothing recorded: an empty text (`a hypothesis needs its text`), a question the run does not have (`no question <n>: "question" is the index of one of the campaign's <n> questions, from 0 to <n-1>`), and words that repeat a live hypothesis of the run, case, punctuation and spaces aside: `this hypothesis repeats <id> (proposed by <lane>): change that one with revise_hypothesis (id <id>), its words, its question or its supporting claims, instead of proposing it again`, or, for the author's, `this hypothesis repeats <id>, one of the author's: the review panel gives it a verdict already. Record claims for or against it instead of proposing it again`. The answer is `{hypothesis, status, question, supporting, ignored, note}` |
| `revise_hypothesis` | `HYPOTHESIS` | `--text TEXT`, `--question N`, `--supporting CLAIM`, repeated; or every field through `-` (`"question": null` makes it about the whole run) | Changes a hypothesis of the pool, or a promoted one: its words, its question or its supporting claims, whose list replaces the old one (verified claims of the run only; a list with none is refused). Refused: one of the author's (`hypothesis <id> is one of the author's: only the campaign's brief changes it. …`), a merged one (`hypothesis <id> was merged into <id>: revise <id> instead`), a retired one, an unknown one, and a revision that gives nothing to change. When the new words repeat another live hypothesis, this one is merged into it: the answer is `{hypothesis, status: "merged", merged_into, note}`, and the work goes on there |
| `add_finding` | none | none: every field through `-` | Records a finding: `text`, `summary`, `why_it_matters` and the `supporting` claims. Draft claims, or numbers not in those claims, leave it a draft |
| `update_section` | none | `--name`, `--body` | Writes or replaces a section of the campaign report |
| `progress` | none | | Shows the corpus, claims, question coverage and time remaining |

A claim's quotes go through standard input, in a quoted heredoc so the shell changes nothing inside them:

```sh
thermite-trial research add_claim - <<'EOF'
{"text": "the claim", "quotes": [{"source": "SOURCE", "quote": "exact words from it"}], "question": 0, "confidence": 0.8}
EOF
```

In a claim's quote, `SOURCE` is the id `fetch` returned, such as `s-3f2a9c41d0b7`. There the harness also takes, as that source's id (`read_source` and `add_note --source` take the id only):

- the address the page was archived from, as fetched or where its redirects ended, written as the archive keeps it (without a `#` part);
- its file name in the research folder, `s-….txt` or `s-….md`, alone or at the end of a path, such as `sources/s-3f2a9c41d0b7.txt`.

When the address or file name names exactly one archived source, the quote is checked against that source's text, word for word, as by its id. The answer then has `resolved`, `[{"cited": "https://example.com/paper", "source": "s-3f2a9c41d0b7"}]`, and the claim's file in the research folder shows `cited as` and what was cited. Anything else leaves the claim a draft, with a problem that starts `no archived source <what was cited>:` and says what it could be:

| Cited | Problem, after the colon |
| --- | --- |
| An address no source was archived from | `no source was archived from that URL; fetch it first, then cite the s-… id that fetch returns` |
| An address two or more sources were archived from | `that URL is archived as <n> sources (<ids>); cite the id of the one the quote is from` |
| An archived address written another way: `http` for `https`, without its scheme or `www.`, with a `/` at the end, or with other capital letters | `that URL is not archived as written, but <id> is archived from <address>; cite that id if it is the same page`. With two or three near matches it names each, `<id> is archived from <address>, and <id> is archived from <address>`, and ends `cite the id of the page the quote is from if it is the same page` |
| The file name of no source | `the research folder has no sources/<id>.txt; cite the s-… id that fetch returned` |
| Anything else | `a quote's source is the s-… id that fetch returned` |

A number in `text` that is in none of the quotes leaves the claim a draft: `the number <n> is not in the claim's quotes`. When it comes from a heading or a label of the text, such as `# Claim c-005` or `Question 0:` at the start of a line, the problem goes on: `: it comes from the heading "<heading>". Give a question's number in "question", not in the claim's text, and leave headings and labels out of the text`.

The answer is `{claim, verified, problems}`, with `resolved` when an address or file name was taken, and `note` when the claim was already recorded.

It reads these settings, which the harness sets for each trial:

| Setting | Default | Meaning |
| --- | --- | --- |
| `THERMITE_HARNESS_URL` | `http://127.0.0.1:8700` | The harness's API |
| `THERMITE_TRIAL_AUTH` | none | The trial's token, as `trial.<token>` |
| `THERMITE_WORKSPACE` | The current directory | The trial's workspace |
| `THERMITE_EDITABLE_PATHS` | `[]` | The paths the trial may change, as a JSON list of globs |

Everything it prints goes to standard output.

| Message | Exit |
| --- | --- |
| `error: submit needs --hypothesis` | `2` |
| `error: there are no changes inside the editable paths (<paths>)` | `2` |
| `error: dev-run needs a command after --` | `2` |
| `error: status needs an attempt id` | `2` |
| `error: idea needs a title: what to try, in a few words` and the usage text | `2` |
| `error: "<title>" is a command word, not an idea. idea proposes an experiment: give what to try, in a few words. thermite-trial does not list the run's ideas or queue.` and the usage text, for a one-word title that names a command | `2` |
| `error: idea has no --<option>` and the usage text | `2` |
| `error: note needs --kind: observation, decision, surprise, question, lesson or note` and the usage text | `2` |
| `error: note needs its text: what you observed, decided or learned` and the usage text | `2` |
| `error: --about takes TYPE:ID, for example experiment:x-0123456789ab` and the usage text | `2` |
| `error: note has no --<option>` and the usage text | `2` |
| `error: no research tool "<name>"` and the list of tools | `2` |
| `error: <tool> takes no words; use:`, `error: <tool> has no --<flag>; use:` or `error: "-" reads a JSON object from stdin…`, with the tool's use | `2` |
| `error: --<flag> needs a number` | `2` |
| The usage text, for an unknown command | `2` |
| `error: <status>: <body>`, when the harness refuses the call, such as `error: 400: {"error":"about: no attempt a-… in run <run>"}` for a note about a record the run does not have | `1` |

## Programs inside the images

Each image starts one program under `tini`; none of them takes options.

| Image | Starts | As |
| --- | --- | --- |
| Control | `node /opt/thermite/dist/control/main.js` | User `thermite` (10001) |
| Supervisor | `node /opt/thermite/dist/supervisor/advisor-runs/main.js`. Its entry runs as root, serves the advisors' runner and starts the supervisor, `node /opt/thermite/dist/supervisor/main.js`, as its own user | root; the supervisor as user `supervisor` (10001), each advisor's program as `advisor-1` to `advisor-8` |
| Harness | `node /opt/thermite/dist/harness/broker/main.js`. The broker runs as root and starts the harness's other processes, each as its own user | root |

Their settings are environment variables: see [Settings](settings.md). The [harness image reference](harness-image.md) lists what else the harness image holds.
