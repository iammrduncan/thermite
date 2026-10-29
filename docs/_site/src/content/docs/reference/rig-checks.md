---
title: "Rig checks"
description: "The model route, isolation and smoke checks: what each tests, what it needs, its limits and every result it reports."
type: reference
sidebar:
  order: 10
---

A **rig** can check itself in three ways. Each check runs inside the rig's **harness** container and ends with one sentence that says whether it passed. [Check a rig](../how-to/operate/check-a-rig.md) shows how to run them; this page describes what each one does. The [glossary](glossary.md) explains the terms.

| Check | `check` value | On the dashboard | What it tests | Needs | Time limit | Needs an idle rig |
| --- | --- | --- | --- | --- | --- | --- |
| Model route | `model` | **Model route** | The rig's model answers with a correct tool call, through the same harness its agents use | A model route | 120 s | No |
| Isolation | `isolation` | **Isolation** | Each role's user is refused what it must not reach, and reaches what it must | The broker: the harness container running as root | 30 s for each role | Yes |
| Smoke | `smoke` | **Judge smoke** | The judge gives each change in a known set its expected verdict, on the rig's own device | A `cpu` or `cuda-gpu` target, and the smoke kits in the image | 3 hours for the whole check | Yes |

## How a check runs

- **The command.** A check starts with the signed `rig_check` command, with payload `{"check": "model" | "isolation" | "smoke", "force"?: true}`. The dashboard, the REST API, the command line and the MCP tool `issue_command` can all send it. See [Signed commands](signed-commands.md).
- **The result comes later.** The command returns as soon as the check starts. The rig records two events: `rig_check_started` (with an id, the check and `force`), then `rig_check_finished` with `ok`, the summary sentence (at most 2,000 characters), a `note` when a check passed with one (the smoke check on noisy timing, below), and details (at most 60,000 characters). Control's view of the rig keeps each check's `note`, or `null`, and the run's `id`, or `null` from a rig that sent none. The result reaches control with the rig's next report.
- **One at a time.** A rig runs one check at a time.
- **On its own.** When the harness runs under the broker, it runs the isolation check every time it starts, before its API, its judge or any agent. It uses `force`, since nothing else can be running yet. It runs the model check whenever control gives the rig a new model route, or right after the check that is running then.

### When a rig refuses

| The command fails with | Why |
| --- | --- |
| `this rig cannot run the <check> check` | The rig has no such check. The isolation check needs the broker |
| `the <check> check is still running` | Another check is running on this rig |
| `not now: <n> open trial(s) and <m> judge job(s): pause the rig's runs and let the judge finish first (each probe kills its role's processes)` | Isolation or smoke on a busy rig. A rig is busy while a trial is open or a judge job is queued or running. A paused run's queued judge jobs count too |
| `not now: a planner call is running: wait for it to end (each probe kills its role's processes)` | Isolation while the planner works in OpenCode, Claude Code or Codex, between two rounds of trials |

`"force": true` runs the isolation or smoke check on a busy rig anyway. Each isolation probe ends every process of the role it tests, so forcing it ends that work. The dashboard never forces a check.

### After a restart

When the harness restarts during a check, it records the check as finished with `ok: false` and the summary `interrupted: the controller restarted during the check (runs it paused stay paused)`. It closes a smoke run that was left open, with the reason `its smoke check was interrupted`.

### Where results show

- The rig's page on the dashboard, in its **Checks** block, one row for each check. The row follows the newest `rig_check` command for the check, and the check's newest run on the rig, and draws itself again when either changes, with no refresh:

  | State | The chip | The line under the check's name | Its button |
  | --- | --- | --- | --- |
  | Not run yet | **not run yet** | None | **Run it** |
  | Sent: control queued the command, and the rig has not taken it | **sent** | `Sent to the rig at 03:41 UTC. It starts when the rig takes it.` | **Sent**, off |
  | Running: the rig took the command (its answer names the run of the check it started), or reported `rig_check_started` | **running** and the time so far, such as `running · 1 m 12 s`, counted on each second | What the check pauses: `Its running runs are paused for it, and resumed after.` for the smoke check, `Nothing is paused for it.` for the others | **Running…**, off |
  | Passed or failed | **passed** or **failed**, and how long ago | The summary sentence | **Run it** |
  | Refused: the rig did not run the command | The last result | `Not run: the rig refused it at 03:41 UTC.` and the rig's reason, such as `Not now: …` | **Run it** |
  | Expired: the rig did not take the command before its signature ran out | The last result | `Not run: the rig did not take it before 04:41 UTC.` | **Run it** |

  A run of the check that started after the command, or that still runs, shows in place of the command: the rig ran it by itself, or it will refuse the command while it runs. **Providers › Harness and model for each rig** says the same of the model check in its rig's row, such as `Its model check was sent to the rig at 03:41 UTC. It starts when the rig takes it.` or `Its model check is running · 12 s.`, and its **Check** button is off meanwhile.
- The rig's history, and `checks` in `GET /v1/rigs/<rig>/view` on the [REST API](rest-api.md).
- The MCP tool `recent_events`. See [MCP tools](mcp-tools.md).

## Model route check

The check sends one short request through the rig's model route, the same way its workers and planner do. The request carries a random word such as `thermite-k3x9qa`, and the model must answer with a tool call that carries it back.

| The rig's [worker harness](glossary.md) | The model must |
| --- | --- |
| Pi (built in) | Call the `echo` tool with the word |
| OpenCode v2 | Run `echo <word>` with OpenCode's shell tool, so that the output holds the word |
| Claude Code | Run `echo <word>` with its Bash tool, the only tool it is given |
| Codex | Run `echo <word>` with the Codex CLI's shell tool, as the `model-check` user, through the harness's model proxy |

The details record the model, the time in seconds, whether a tool was called, the tokens in and out, the last error and the reply's text (first 300 characters). With Pi they also record the base URL, the reply's stop reason, whether it held thinking, the context window (the owner's [cap](../how-to/models/connect-a-provider.md#cap-the-models-context-window) when it is lower than the provider's window) and the reply limit. With OpenCode and Codex they also record the base URL, and with Claude Code the subscription's usage.

While the workers' model check fails, no trial or plan of the rig's run starts, and the run shows **Agents stopped** in **Needs you**. The rig checks the model again by itself after a pause that grows to at most 30 minutes, and at once when the model changes or you resume a paused run.

### Results

| Summary | Meaning |
| --- | --- |
| `<model> answered with a correct tool call in <s> s` | Passed (Pi). OpenCode, Claude Code and Codex add ` (OpenCode)`, ` (Claude Code)` or ` (Codex)` |
| `<model> failed the tool-call check: no answer in 120 s (is the model up?)` | No answer in time |
| `<model> failed the tool-call check: it called the tool with "<x>", not "<word>"` | A tool call with the wrong word |
| `<model> failed the tool-call check: no tool call: <error>` | The request failed with an error |
| `<model> failed the tool-call check: no tool call (stop: <reason>); it wrote: <text>` | The model answered without calling the tool. `; it wrote: <text>` appears only when it wrote some text |
| `<model> failed the tool-call check in OpenCode: <why>` | Failed in OpenCode. `<why>` is the last error, `its tool call did not print the word`, or `no tool call; it wrote: <text>` |
| `<model> failed the tool-call check in Claude Code: <why>` | Failed in Claude Code. `<why>` can also be `the subscription's usage window is full until <time>` |
| `<model> failed the tool-call check in Codex: <why>` | Failed in Codex. `<why>` is the last error, `its tool call did not print the word`, or `no tool call; it wrote: <text>` |
| `no model route: set one on control's settings page (or in the rig's settings)` | The rig has no model route. See [Connect a model provider](../how-to/models/connect-a-provider.md) |

## Isolation check

The isolation check is the harness's **isolation selftest**. For each role, the broker runs one small probe script as that role's own user. The script tries each operation in a list and reports what happened. [Isolation inside a rig](../explanation/isolation.md) explains why each role has its own user.

The selftest also runs from a shell inside the harness container, as root:

```sh
thermite selftest isolation --force
```

It prints the whole report as JSON and exits with 1 when isolation does not hold. Each probe stops every process of its role's user, so without `--force` it refuses a busy rig with `the rig is busy: <reason>; rerun with --force to probe anyway`. The rig is busy while trials or judge jobs are open (`<n> open trial(s) and <m> judge job(s): …`), or while a process of the `planner` or `model-check` user runs (`a planner call is running: wait for it to end (each probe kills its role's processes)`, and the same for `a model check`). The check from control waits the same way: control says `not now:` and the reason.

### Roles probed

| Role | Who it is |
| --- | --- |
| `builder` | The user that builds kits and candidates on the first (or only) judge device |
| `builder-<i>` | The builder of each further judge GPU, on a rig with dedicated GPUs: each card builds as its own user, at the same time as the others |
| `run` | The user that runs timed runs on the first (or only) judge device |
| `run-<i>` | The user of each further judge GPU, on a rig with dedicated GPUs |
| `planner` | The user of planner calls under OpenCode, Claude Code or Codex |
| `model-check` | The user of the model check under OpenCode, Claude Code or Codex |
| `lane-1` | A lane's plain commands |
| `lane-1+gpu` | A lane's development run on the device. On a rig with several development GPUs, once for each: `lane-1+gpu@2` and so on |
| `lane-1-dev` | The development-run user |
| `agent-1` | A lane's worker agent process |

### Probes every role must be refused

| Probe | Tries to | What |
| --- | --- | --- |
| `ledger` | Read | The ledger database |
| `state-list` | List | The harness's state directory |
| `kits` | List | The kits the harness checked out |
| `git-mirrors` | List | The harness's git mirrors |
| `models-list` | List | The model store |
| `builds-list` | List | The build store |
| `baselines-list` | List | The folders a hill climb's kit check keeps with its [baseline](contract.md#the-baseline) |
| `broker-socket` | Check for write access | The broker's socket |
| `outbox-write` | Check for write access | The outbox |
| `outbox-read` | List | The outbox |
| `inbox-list` | List | The inbox, which the supervisor fills for the controller |
| `inbox-read` | Read | A file in the inbox, such as a kit's bundle, reached by its full path. Skipped while the inbox holds none |
| `runs-list` | List | The directory of the judge's runs |
| `tmp-create`, `var-tmp-create`, `shm-create` | Create a file | `/tmp`, `/var/tmp`, `/dev/shm` |
| `kit-by-path` | Read | A checked-out `kit.json`, reached by its full path. Skipped before any kit is checked out |
| `secret:<file>` | Read | Each secret file: the supervisor token, the proposer token and the model key files. The rig check also tries the stored model route. Where the harness shares its container with a supervisor in [pull mode](../explanation/trust.md#rigs-in-pull-mode) (`THERMITE_TUNNEL_DIR` set), also the pod's own keys, `keys.json` |
| `build-overwrite` | Write | A file of a stored build. Skipped before any build exists |
| `build-work` | List | A build under way, handed to `builder` as the judge hands one over. Every role but `builder` must be refused, the other cards' builders among them |
| `baseline-by-path` | Read | A file a kit's check kept with a baseline, reached by its full path. Skipped before any baseline kept a file |
| `run-kit-write`, `run-kit-create` | Write, create a file | A run's read-only copy of kit files, made the way the judge makes it |
| `research-write`, `research-create` | Write, create a file | A claim's file in a run's [research folder](../explanation/campaign-modes.md#research), and its `claims/` folder, written the way the harness writes them |
| `controller-environ` | Read | The environment of the harness's controller process |
| `pid1-environ` | Read | The environment of the container's first process, which holds what the container was started with |
| `device:<node>` | Open | Each GPU device node, for roles that must not use the device |

One more probe must find nothing: `runpod-variables` looks for RunPod's variables (`RUNPOD_` and a name) in the role's own environment and in every process environment the role can read. Its result is `none`, or `FOUND` with each name and where it was found.

In the [one-container rig image](harness-image.md#the-one-container-rig-image), every role must also be refused these:

| Probe | Tries to | What |
| --- | --- | --- |
| `supervisor-home` | List | The supervisor's state folder |
| `supervisor-token` | Read | The supervisor's copy of its token for the harness API |
| `supervisor-environ` | Read | The environment of the supervisor's process. Skipped when no supervisor runs |
| `control-key-write` | Write | Root's copy of control's key, which the harness trusts. In pull mode only |

Where the rig keeps a sealed snapshot of its state on the host's volume (`THERMITE_STATE_SNAPSHOT_DIR`, which the one-container rig image sets; [Where the state lives](harness-image.md#where-the-state-lives)), every role also runs these two probes:

| Probe | Tries to | Passes with |
| --- | --- | --- |
| `state-snapshot` | List the snapshot folder, and create an empty file in it (removed again) | The error it met, such as `EACCES`, where the volume keeps file modes. On a volume that lets the role in, as RunPod's does: `open, sealed: lists it and writes in it; the manifest and <n> sealed files` (or `no snapshot yet`), when the folder holds only the sealed manifest, sealed files, files being sealed and empty probe files. `FOUND a file that is not sealed: <name>`, `FOUND an unsealed snapshot an older image left: snapshot`, or `FOUND` with any other name in the folder, fails |
| `snapshot-key` | Find the snapshot key (`THERMITE_STATE_SNAPSHOT_KEY`) in the role's own environment and in every process environment the role can read | `none`. `FOUND THERMITE_STATE_SNAPSHOT_KEY (own)` or `(pid <n>)` fails |

### Probes that must succeed

| Probe | Who | What |
| --- | --- | --- |
| `run-kit-read` | The timing users (`run`, `run-<i>`) | Read the run's copy of kit files |
| `research-read` | The workers' users (`lane-1`, `agent-1`) and the planner's (`planner`) | Read the claim's file in that research folder |
| `device:<own card>` and the control nodes | Each role with a GPU of its own (dedicated GPUs only) | Open its own card and the shared control nodes |
| `visible-gpus` | Each role with a GPU of its own | `nvidia-smi -L` lists exactly that role's card |

On a rig with one shared device, the `run` user and development runs are not probed for devices. See [Sharing a device](../explanation/sharing-a-device.md).

### The one-container image

In the [one-container rig image](harness-image.md#the-one-container-rig-image) (`THERMITE_ONE_CONTAINER=1`), the selftest first checks the container as a whole, from its own process. The report lists these under `container`:

| Check | Passes with | What it checks |
| --- | --- | --- |
| `supervisor-user` | `uid 10001, gid 10001, no_new_privs` | Every supervisor process runs as the `supervisor` user and group (real, effective, saved and file ids), and cannot gain privileges. It waits up to 10 seconds for a supervisor that is still starting |
| `supervisor-gpu` | `refused` or `no GPU node`, with the fence: `(fence: landlock)` or `(fence: none)` | What the supervisor's user met opening each GPU device node, started the way the supervisor is. The broker tries it when it starts, and again when it regroups the cards, and records it in `supervisor.json` in its socket's folder |
| `setid-files` | `none` | No setuid or setgid file on the container's own filesystem. Other mounts and the scratch folder are left out. `none (<n> folders not readable)` counts the folders the selftest's user could not list |
| `runpod-variables` | `none (read <n> of <m> processes)` | No `RUNPOD_` variable in the environment of PID 1 or any process started under it. A shell opened in the container from outside is left out. Without `CAP_SYS_PTRACE` a process can read only the environments of its own user's processes: as root, PID 1 and the broker; as the controller, its own. When PID 1 is not the image's own `tini` but an init the platform runs (RunPod does, with the image's entry point as its child), PID 1 is left out, because it keeps the environment the platform gave the container, and the result adds `PID 1 is the platform's own init (<program>), not the rig's, and keeps the container's first environment`. The roles' `pid1-environ` probes show that no role can read it |
| `enroll-code` | `none (read <n> of <m> processes)` | No process of the rig started with pull mode's enrollment code (`THERMITE_TUNNEL_ENROLL_CODE`), but root's and the supervisor's own first process. The supervisor takes the code out of its environment at start, so nothing it starts has it, and the controller never gets it |
| `control-key` | `root's, the key the launch named` | In pull mode only (`THERMITE_TUNNEL_CONTROL_KEY_SHA256` set): the key the harness trusts, `THERMITE_CONTROL_PUBKEY_FILE`, is a plain file, and it and every folder above it are root's and writable by no other user, so neither the supervisor nor a role can change it. Its SHA-256 is the one the launch named |
| `state-snapshot` | `sealed, closed to thermite, supervisor, agent-1 (owner <uid>:<gid>, mode 700)`; `open, sealed: <user> lists it and writes in it; … (owner <uid>:<gid>, mode 700)`; or `no snapshot: <why> (…)`. Each ends with `; holds the manifest and <n> sealed files` (or `no snapshot yet`) when the selftest's user can list the folder | With `THERMITE_STATE_SNAPSHOT_DIR` set. At start, the broker tried to list the snapshot folder and to write in it as the controller's user, the supervisor's and `agent-1`, and recorded what each met in `snapshot.json` in its socket's folder, with the owner and mode the volume shows and whether the launch gave the snapshot key. `sealed, closed`: each was refused. `open, sealed`: the volume lets them in, as RunPod's does; this is no failure, since everything there is sealed. `no snapshot`: the launch gave no key, so nothing is written there; this is no failure either. The check also looks into the folder where it can: `FOUND a file that is not sealed: <name>`, `FOUND an unsealed snapshot an older image left: snapshot`, or `FOUND` with any other name, fails. `failed: root …` means root could not make the folder |
| `snapshot-key` | `none (read <n> of <m> processes)` | With `THERMITE_STATE_SNAPSHOT_DIR` set: no process of the rig but root's holds the snapshot key (`THERMITE_STATE_SNAPSHOT_KEY`). The broker takes it out of its environment before it starts anything. `FOUND THERMITE_STATE_SNAPSHOT_KEY in pid <n> (uid <u>)` fails. It reads the environments it may, as `runpod-variables` does |

### Results

Each probe's result is the error the operation met (refused, as it must be), `readable` or `reachable` (succeeded, where it must), `sees <ids>` (`visible-gpus` listed exactly the role's card), or one of these failures:

| Marker | Meaning |
| --- | --- |
| `ALLOWED` | A probe that must be refused succeeded |
| `UNREADABLE <error>`, `UNREACHABLE <error>` | A probe that must succeed was refused |
| `WRONG GPUS <ids>` | `nvidia-smi` showed other cards than the role's own |
| `FOUND <what>` | Something that must not be there: a RunPod variable, the enrollment code, the snapshot key, a set-id file, or a file in the snapshot folder that is not sealed |
| `OPENED <nodes>` | The supervisor's user opened a GPU device node |
| `WRONG USER: <ids>`, `WRONG: <why>` | The supervisor runs as another user or group, or can gain privileges; or control's key for the harness is not root's alone, or not the launch's |
| `MISSING: <what>` | No supervisor process, no record of it from the broker, or no key for the harness in pull mode |
| `failed: <error>` | The probe script itself failed, or a probe could not run |

| Summary | Meaning |
| --- | --- |
| `isolation holds: every probe of <n> roles came out as it must (devices: <devices>)` | Passed |
| `isolation does NOT hold (devices: <devices>): <role> <probe>: <result>; …` | Failed. Up to 12 failures are listed, those of the container first, as `container <check>: <result>` |
| `isolation does NOT hold (devices: <devices>): the device setup failed` | The GPU's device nodes could not be set up |

`<devices>` is one of these:

- `shared (fence: <fence>)`: one device for all, with how the broker keeps the other roles off it. `groups`: the device nodes' group; `groups+landlock`: the group and the GPU fence; `landlock`: the fence alone, where the nodes keep the owner and mode they came with, as on RunPod and under rootless Podman;
- `shared`: one device, with no record from the broker of how;
- `shared, NOT SET UP: <error>`: the broker could neither give the nodes to the `gpu` group nor fence them;
- `dedicated: judge <nodes>, development <nodes>`;
- `dedicated, NOT SET UP: <error>`.

The details hold every probe's result for every role, the container's checks, and the probes that were skipped.

## Smoke check

The smoke check runs a small campaign with no agents on the rig's own target. The changes it submits, called candidates, each have a known right verdict. It passes when every candidate gets it, with one exception: [noisy timing](#noisy-timing).

1. It picks the smoke kit for the rig's target: `smoke-cpu` for `cpu`, `smoke-cuda` for `cuda-gpu`. It reads the kits and their projects from `/opt/thermite/checks` in the harness image, or from `THERMITE_CHECKS_DIR`.
2. It makes a git repository of the project and one of the kit (without its candidates), with fixed dates, so the same files always give the same commits.
3. It assigns a judge-only run named `check-smoke-` and eight hexadecimal digits, of a campaign named `rig-check-<kit>-` and the first eight digits of the kit's commit. The contract is the image's `examples/contracts/smoke-cpu.json`, with the rig's target. Assigning pauses the rig's running runs, with the reason `replaced by check-smoke-…`.
4. It submits every candidate except `good`, and waits until each is settled: `judged`, `rejected_v0`, `duplicate`, `promoted`, `awaiting_approval` or `errored`.
5. It submits `good`, and waits for it the same way.
6. It closes its run (`the smoke check is done`) and resumes the runs it paused.
7. It compares each result with the expected one. A candidate expected to be `rejected_v0` is compared by its attempt state; the others by their verdict.
8. It passes when every result is the expected one, or when the only wrong result is the `noop` candidate's `inconclusive` in place of `neutral`. It fails on any other wrong result, alone or beside that one.

Every candidate is judged against the seed, the project as it is. The run is a hill climb, so the judge's first job measures the seed alone on every cell, the run's [baseline](contract.md#the-baseline), and the candidates wait for it.

### The CPU candidates

| Candidate | The change | Expected |
| --- | --- | --- |
| `good` | Loops in i-k-j order, so the inner loop reads memory in order | `win_confirmed` |
| `noop` | The same algorithm with a renamed variable | `neutral` |
| `broken` | Skips half of the sum | `invalid` |
| `nobuild` | Does not compile | `invalid` |
| `timer` | Calls `clock_gettime`, a forbidden pattern | `rejected_v0` |
| `ref-edit` | Edits the reference code, outside the editable paths | `rejected_v0` |
| `fallback` | Calls the reference code instead of computing | `invalid` |
| `nan` | Returns NaN | `invalid` |
| `oom` | Touches 1 GiB of memory, over the run's 256 MiB limit | `crash_candidate` |
| `diskfill` | Writes 512 MiB, over the run's 32 MiB disk limit | `crash_candidate` |
| `overwrite` | Tries to overwrite the stored builds, then computes correctly | `neutral`, `inconclusive` or `regress` |
| `linger` | Leaves a process running in the background | `neutral`, `inconclusive` or `regress` |

### The CUDA candidates

| Candidate | The change | Expected |
| --- | --- | --- |
| `good` | Register tiling: shared-memory tiles of 64 × 8 and 8 × 64, and a 4 × 4 block of outputs for each thread | `win_confirmed` |
| `noop` | A renamed variable | `neutral` |
| `broken` | Skips half of the sum | `invalid` |
| `fallback` | Calls the reference code | `invalid` |

### The smoke kits and contract

Both kits multiply two square matrices of floats, many times over (`reps`), so that the work takes much longer than starting the process. The build links the candidate's kernel with the kit's driver and wraps the reference function, so the kit can see whether the candidate called it. The kit's check computes the product again in double precision (the CUDA kit checks 64 evenly spaced rows, since its matrices are larger), allows an error of at most 0.002, and fails a run with values that are not numbers or that called the reference.

| | `smoke-cpu` | `smoke-cuda` |
| --- | --- | --- |
| Cases (`n`) | `small` 128, `large` 256, `held` 192 | `small` 512, `large` 1024, `held` 768 |
| Metric | `flops_per_s` (FLOP/s) | `flops_per_s` (FLOP/s) |
| Build limits | 120 s, 1024 MiB memory, 256 MiB disk | 300 s, 2048 MiB memory, 512 MiB disk |
| Run limits | 60 s, 256 MiB memory, 32 MiB disk | 120 s, 2048 MiB memory, 64 MiB disk |
| Check time limit | 60 s | 300 s |
| Compiler | `cc` | `nvcc`, with native code for each GPU generation its CUDA builds for, and PTX for newer GPUs, so a run on one of those generations does not compile the kernel at start: with CUDA 12, `sm_60`, `sm_70`, `sm_75`, `sm_80`, `sm_86`, `sm_89` and `sm_90`; with CUDA 13, `sm_75`, `sm_80`, `sm_86`, `sm_89`, `sm_90`, `sm_100` and `sm_120`, whose code also runs on the DGX Spark's `sm_121`. Its build script, run by hand with `CUDA_ARCH` set, such as `sm_86`, builds for that architecture only; the judge's builds don't set it |

The contract measures `small` and `large`, keeps `held` for confirmation, and lets changes touch only `src/kernel/**`. It sets `min_effect` 0.1, `equivalence_band` 0.05 and `runs_per_cell` 3, because timing on a shared CPU is noisy. Its audit triggers are set to 1000, so no smoke candidate is audited. It forbids added lines that match `clock_gettime`, `gettimeofday`, `\brdtsc`, `\btimes\s*\(`, `__real_`, `__wrap_` and `thermite_ref_calls`.

### Results

| Summary | Meaning |
| --- | --- |
| `smoke on <kit>: all <n> candidates were judged as expected (run <run>)` | Passed |
| `smoke on <kit>: <n-1> of <n> candidates were judged as expected; the no-op came out inconclusive, not neutral (run <run>). Note: The timing on this machine is noisy. Results here need more repeats.` | Passed, with a note: see [Noisy timing](#noisy-timing) |
| `smoke on <kit>: <k> of <n> candidates were judged otherwise: <name> expected <x>, got <y>; …` | Failed. Each wrong candidate is listed |
| `there is no smoke kit for a <type> target` | The rig's target is neither `cpu` nor `cuda-gpu` |
| `the smoke kit is not in this image (<dir>)` | The image has no smoke kit at that path |
| `the judge did not settle <names> within 180 min` | The 3-hour limit passed |

The details list each candidate with its expected result, its actual result and its attempt id. A pass with the note also has `noisy_timing: true` and the `note`. The check's run stays on the dashboard, so its attempts can be read afterwards. While it runs, it shows under **At work now** on **Campaigns**. After it, its campaign shows on **Campaigns** under the **Rig checks** and **All** filters (the default filter hides rig checks), and the run is under **Earlier runs** on the campaign's page, as **Finished**. [Your first run](../tutorials/first-run.md) walks through one.

### Noisy timing

The `noop` candidate changes nothing that runs, so the judge should find no difference: `neutral`. On a machine whose timing varies a lot from run to run, such as a virtual machine that shares its host, the judge can't tell "no difference" from the noise in the contract's three runs per case, and says `inconclusive`. That is the judge working as it must: it doesn't call a result when its measurements can't support one.

So when the no-op's `inconclusive` is the only wrong result, the check passes, and its summary ends with the note `The timing on this machine is noisy. Results here need more repeats.` The note means that campaigns on this rig need more measurement to tell small effects apart. Raise `acceptance.runs_per_cell` in their contracts (**Runs per case** on the **New campaign** page), or run them on a quieter machine. Any other wrong result still fails the check: a no-op judged `regress` or `win_confirmed`, a known win that is not confirmed, or a broken change that is not caught.
