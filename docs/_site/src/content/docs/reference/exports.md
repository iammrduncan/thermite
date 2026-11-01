---
title: "Exports"
description: "When a rig exports, what a normal, a full and a run's export hold, where a rig's exports go, what control keeps of them, how it gives them back as one archive and how you delete them, the supervisor's export figures, and how control tells that a rig's results have left it."
type: reference
sidebar:
  order: 19
---

An [export](glossary.md) is what a rig's harness writes for its supervisor to send off the rig: a run's whole record when the run ends, or what you ask for with **Export**. Nothing is exported on a timer. This page says when a rig exports, what an export holds, where it goes, what control keeps of it, how control gives it back and how you delete it, how the supervisor reports it, and how control tells that a rig's results have left it. [Get a rig's results from control](../how-to/operate/exports-on-control.md) gives the steps.

```sh
curl -fsS -H "Authorization: Bearer $(cat .dev/secrets/control-admin-token)" \
  http://127.0.0.1:8800/v1/rigs/rig-1/results-left
```

```json
{"left":true,"why":"every export has left the rig: they are on control","to":"control","waiting":0,"champions_waiting":0,"reported_at":"2026-10-20T12:01:00.000Z"}
```

## When a rig exports

| Export | When | What it is |
| --- | --- | --- |
| [A run's export at its end](#a-runs-export-at-its-end) | Each run, once, when it ends, while the rig's **Exports** switch on **Edit rig** is on | A run's export with the run's champion, made by the rig on its own |
| [A run's export](#a-runs-export) | When you choose **This run** under **Export** on a run's page | The run alone |
| [A normal export](#normal-and-full-exports) | When you choose **What changed** under **Export**, and when a RunPod pod's stop sends its results out | What the rig recorded since its last normal or full export |
| [A full export](#normal-and-full-exports) | When you choose **Full export** under **Export**, and in a full reset and a RunPod pod's terminate | A normal export, with every run's research folder and a copy of the ledger |

The command `export_now` asks for the last three ([`export_now`](signed-commands.md#export_now)). Nothing else exports: there are no exports on a timer.

## Normal and full exports

A normal export is made when you choose **What changed** under **Export**, or send `export_now` with `{}`. A full export is made when you choose **Full export** under **Export**, and by a full reset, a RunPod pod's terminate and the command `export_now` with `{"full": true}`. Its manifest says `"full": true`.

| Part | A normal export | A full export |
| --- | --- | --- |
| Events, attempts, champion patches, field notes, source notes, briefings, knowledge items and the prompts the agents were sent (`prompts.jsonl.gz`) since the last export | Yes | Yes |
| `research/<run>/folder/…`: the [research folder](../explanation/campaign-modes.md#research) of each run that finished in this export (a research run whose final report it holds, with its research paper as `paper.md` when it has one, or a hill-climb or goal run that was closed and recorded sources, claims or notes, or compacted a conversation) | Yes | Yes |
| `research/<run>/folder-<export>/…`: the research folder of every other research run, and of every other hill-climb or goal run that recorded sources, claims or notes, or compacted a conversation, as it stands now: running, paused, closed or broken | No | Yes |
| `research/<run>/…`, other files: each run's archive of the web pages it fetched | No | Yes |
| `ledger.sqlite`: a snapshot of the ledger, which holds every event, claim, source, finding, report and note, without the table of held-out results | No | Always, and it always leaves the rig |

A run's folder in a full export goes beside the place a normal export puts a finished run's folder, under the export's name, because a results repository never replaces a file it already has: the folder a normal export takes when the run finishes still reaches `research/<run>/folder/`. A folder leaves out the working areas, and a `knowledge/` folder an older build left in it: other runs' records are in their own runs' exports. [Set up the results repository](../how-to/operate/results-repository.md#what-gets-pushed) lists every file.

## A run's export

**This run** under **Export** on a run's page, and the command `export_now` with `{"run": "<run>"}`, export one run alone. Its manifest says `"run"` with the run's id.

| Part | A run's export |
| --- | --- |
| Events, attempts, field notes, source notes, briefing and knowledge items | The run's alone, from its start: the events whose `run` is the run, which include those about its attempts (each `verdict`, its lifecycle, audits) and about the judge's jobs for it |
| `research/<run>/folder-<export>/…` | The run's research folder as it stands, with its paper as `paper.md` when it has one |
| `research/<run>/…`, other files | The run's archive of the web pages it fetched |
| `ledger.sqlite` | No: the ledger holds every run |
| Champion patches | Only in [a run's export at its end](#a-runs-export-at-its-end): the run's champion, when no export published it yet. A run's export you ask for publishes none |

A run's export stays outside the rig's chain of exports: the next normal or full export starts where the last export of the chain ended, so it still holds everything the run's export also held. A full reset never takes a run's export as its full export. A supervisor pushes it to the results repository with its research folder and pages, or sends it to control, as it does the rig's exports. Once it is pushed or sent, it leaves the outbox, as they do.

## A run's export at its end

When a run ends, the rig writes that run's export on its own, once: the same parts as [a run's export](#a-runs-export), with the run's champion, and its manifest also says `"end": true`. On the **Exports** page its **Kind** is `run <id>` followed by `at its end`.

- **When.** Once the run is closed and its closing work is done: every trial of it has ended, the judge's job under way for it has ended, and, for a research run, its final report is written (or writing it failed). The rig looks every 5 seconds.
- **Once.** The ledger records the export as a `run_end_exported` event, with the export's name and its last event. A run that has one is never exported at its end again, and a rig that restarts between a run's end and its export exports it then. An export written just before a crash, before its event, is recorded at the next start, not written again.
- **The Exports switch.** Off on **Edit rig**: a run that ends is not exported, and its results stay on the rig only. Turned on again, each run that ended meanwhile is exported then.
- **The disk.** At the rig's [disk floor](limits-and-pacing.md#the-rig-and-control) it waits, as every export does, and the rig's history says why, once.
- **A failure.** An export that fails, such as when git can't read a patch, is tried again 10 minutes later; the harness's log says why each time (`the run's export at its end failed: it is tried again in 10 minutes`).
- **Its champion.** A hill climb's or a goal run's champion beyond its starting point, when no export published it yet, goes as a patch from the run's starting commit, `champions/<run>/<n>.patch` with its `.json`, as a normal export publishes one. So, with no one asking, it reaches the results repository, or control for a rig without one, ready to [take](../how-to/campaigns/take-the-result.md) or to [send to another rig](../how-to/campaigns/several-rigs.md). A champion of a run that still runs is published by an export of what changed.
- **What it leaves out.** The rig's own checks are runs too, and export nothing at their end. A run that closed before the rig ran this version is not exported at its end.

## Where exports go

| The rig's supervisor has | Its exports go to | The rig's **Results** row says |
| --- | --- | --- |
| A results repository (`THERMITE_RESULTS_REMOTE`) | The results repository, pushed with git. See [Set up the results repository](../how-to/operate/results-repository.md) | `N exports · pushed … ago` |
| No results repository, and a control | Control, sent over control's API with the rig's token | `N exports · sent to control … ago`, or `sent to control: none yet` |
| Neither | Nowhere: they stay in the supervisor's own repository, in its volume | `no results repository` |

The rigs that control sets up on machines and clusters, and the rigs you join yourself, have no results repository, so their exports go to control. The local compose stack has one. Champion patches go to control in every case, so you can [download a run's champion](../how-to/campaigns/take-the-result.md).

An export leaves the harness's outbox only once it is safe: pushed to the results repository, or kept in full on control. Until then the supervisor tries again every round (`THERMITE_POLL_SECONDS`, 60 seconds by default).

## What goes to control

Every file the export's manifest lists, each with the SHA-256 the manifest gives it. The copy of the ledger (`ledger.sqlite`) goes with each full export, as the results repository's ledger branch gets it. A ledger copy never holds the table of held-out results. Its events, like `events.jsonl`, hold the judge's `held_out_checked` events: each held-out case's name, kind and value, never its inputs or output ([Held-out failures](verdicts.md#held-out-failures)).

## How an export is sent

1. The supervisor starts the export on control with its manifest and the size of each file it sends. Control refuses a list that leaves out a file of the manifest (the ledger copy aside), or names one the manifest does not list.
2. It sends each file in pieces of up to 8 MiB, each at the place control says it has. When a send breaks, the next round goes on from there.
3. When a file's last byte arrives, control checks its SHA-256 against the manifest. It keeps the file only if they match; otherwise it deletes it, and the supervisor sends it again.
4. The export is complete when every file it promised is kept. Then the supervisor tells the harness, and the export leaves the outbox. An export the harness was writing when it stopped (a folder named `.tmp-` and the export's name) is removed at the harness's next start; so is a build the judge was storing.

The routes are in the [REST API reference](rest-api.md#routes-used-by-rigs). A rig whose control reaches it through a proxy (a RunPod pod) sends the same requests through its tunnel.

## Where control keeps them

| Place | What |
| --- | --- |
| `THERMITE_CONTROL_DIR`, under `exports/<rig>/<export>/manifest.json` | The export's manifest, as the harness wrote it |
| `THERMITE_CONTROL_DIR`, under `exports/<rig>/<export>/files/` | Each file, at its path in the export. A file still arriving ends in `.part` |
| Control's database | Each export: its manifest, the files it promised with their sizes and SHA-256, which arrived, and when the last one did |

Control never deletes an export by itself. They take room in control's state volume until you [delete them](#delete-exports).

## Download an export

The dashboard's **Exports** page, in the sidebar, lists the exports control keeps, for every rig, newest first: the newest 1,000. To see one rig's, press the rig's name above the table (each name says how many exports it has; **All rigs** shows them all again), follow **its exports on control** on the rig's **Results** row or the **Exports page** link under **Export**, or add `?rig=<rig>`. Only the owner reads it: the dashboard signs in with the owner's token.

| Column | Meaning |
| --- | --- |
| (a box) | Tick it to delete the export ([Delete exports](#delete-exports)). The box in the heading ticks every export shown. An export control is still receiving has no box to tick |
| **Rig** | The rig that sent it |
| **Export** | Its name: the time the harness made it, and 8 hexadecimal characters |
| **Kind** | `full`, `what changed` for a normal export, or `run <id>` for [a run's export](#a-runs-export), followed by `at its end` for [one the rig made at the run's end](#a-runs-export-at-its-end) |
| **Made** | When control received its start |
| **Complete** | When its last file reached control and passed its check, or `still arriving` |
| **Events** | The rig's ledger events it holds, such as `181–245`, or `none new (through 245)`; for a run's export, `the run's, through 245` |
| **Files** | How many files it holds, or `k of n` while they arrive |
| **Size** | The size of all its files |
| **Download** | One `.tar.gz` of the export, for a complete one only. One that is not says `still arriving`; on a control with no folder for exports, a complete one says `not kept` |

With no export yet, the page says `No export on control yet.` (`No export from rig-1 on control.` for one rig). A control started without its folder for exports says `Control keeps no exports: it has no folder for them, so rigs send none here.` above the table.

The download is `<rig>-<export>.tar.gz`. It holds one folder, `<rig>-<export>/`, with the export's `manifest.json` and every file at its path in the export, each as control checked it against the manifest's SHA-256. Control builds the archive from what it keeps as it sends it, so it never holds a second copy. A tar archive in the POSIX format, compressed with gzip, which `tar -xzf` unpacks on Linux and macOS. Each download is in the audit log as `export_downloaded`.

Over REST, `GET /v1/rigs/<rig>/exports/<name>/archive` gives the same file with the owner's token ([REST API](rest-api.md)). It answers 404 with `{"error": …}` for an export control does not have (`no such export`), one still arriving (`the export is still arriving: not every file reached control`), a control with no exports folder, and a file gone from control's folder or not of the size the rig gave for it. Over MCP, the tool [`exports`](mcp-tools.md) lists them, for the owner's and an operator's token; it downloads nothing.

## Delete exports

Control deletes an export only when you tell it to. Deleting one removes its files and its record from control. It can't be undone: a rig lets an export go once control holds it, so control's copy is the only one off the rig.

On the **Exports** page, tick the exports to delete and press **Delete**. The top of the page then asks you to confirm: `Delete these 2 exports from control?`, with each export's rig, name, kind and size, the size in all, and that this can't be undone. Press **Delete 2 exports** to delete them, or **Cancel**. The page then says what went, such as `Deleted 2 exports from control: rig-1 · 20261101T010000Z-0123abcd (4.2 KiB) and rig-1 · 20261101T020000Z-89abcdef (1.0 KiB).`

| Way | How | Who |
| --- | --- | --- |
| The dashboard | **Exports**, tick, **Delete**, then **Delete N exports** | The owner (the dashboard signs in with the owner's token) |
| REST | `POST /v1/exports/delete` with `{"exports": [{"rig": "rig-1", "name": "…"}]}` ([REST API](rest-api.md#rigs-and-their-history)) | The owner's token |
| MCP | [`delete_exports`](mcp-tools.md) | The owner's token. An operator's token lists exports but deletes none |
| The command line | `thermite exports delete rig-1 NAME… --control URL --token-file F` ([command line](command-line.md)) | The owner's token |

- **All or none.** When one of the exports is still arriving, nothing is deleted, and the refusal says why: `rig-1 · 20261101T030000Z-feedface (1 of 3 files) is still arriving: control is receiving its files. Delete it once complete. Nothing was deleted.` An export counts as still arriving until it is complete, or until control has received nothing of it for 15 minutes, such as one whose rig was removed while it was sent; then it can be deleted too.
- **One control does not have** is said, and deletes nothing: `Control did not have rig-1 · …: it was deleted already, or never sent.`
- **The audit log** has each one deleted as `export_deleted`, with its rig, its name, its size in bytes, how many files it had and whether it was complete.
- **What stays.** Deleting an export on control changes nothing on the rig or in its results repository, and nothing in control's events or knowledge base.

## The supervisor's export figures

The supervisor reports these every round, unsigned. They are `supervisor.export` in `GET /v1/rigs/<rig>/view`.

| Field | Meaning |
| --- | --- |
| `remote` | Whether it has a results repository |
| `to` | Where its exports go: `repository`, `control` or `none` |
| `exports` | Exports it has taken from the outbox |
| `pushed`, `pushed_commit`, `last_push_at` | The newest 50 exports in the results repository, the commit the last push left there, and when |
| `uploaded`, `last_upload_at` | The newest 50 exports control holds in full, and when the last one was complete |
| `waiting` | Exports still on the rig: not yet taken from the outbox, or taken and not yet pushed or kept on control |
| `champions_waiting` | Champion patches not yet on control |
| `last_error` | The last push's or send's error, or an export that failed its check |

## Have all results left the rig?

Control answers this from the rig's latest supervisor report and, for exports on control, from its own copy. A RunPod pod's terminate waits for it, and so does its stop, for 15 minutes at most ([Stop, start, restart and terminate](rest-api.md#stop-start-restart-and-terminate)). `GET /v1/rigs/<rig>/results-left` asks it, with the owner's token; `?export=<name>` also asks about that export.

The answer is yes only when all of these hold:

- the supervisor has reported, and its report says where its exports go and how many wait;
- no export waits on the rig (`waiting` is 0);
- for a rig that sends to control, no champion patch waits either;
- with `export`: for a results repository, the supervisor reports that export pushed; for control, control holds every file of it.

Results recorded after the rig's last export are in no export yet. To include them, export first (**Export** on the rig's page, or the `export_now` command) and ask about that export by name.

| Field | Meaning |
| --- | --- |
| `left` | The answer |
| `why` | Why not, or where they are, in plain words |
| `to` | `repository`, `control`, or `null` when the report does not say |
| `waiting`, `champions_waiting` | The report's counts, or `null` |
| `reported_at` | When control received the report it read |

| `why` | Meaning |
| --- | --- |
| `the rig's supervisor has not reported yet` | No report |
| `the rig's supervisor has not reported its exports yet` | A report without its exports |
| `the rig has no results repository, and its supervisor does not send exports to control (an older version)` | A supervisor from before exports went to control |
| `the rig's supervisor does not say what waits to leave (an older version)` | The report has no `waiting` |
| `<n> exports wait on the rig to go to control` | Not yet sent. Also for the results repository |
| `<n> champion patches wait on the rig to go to control` | Not yet uploaded |
| `export <name> is not in the results repository yet` | Not yet pushed |
| `export <name> has not reached control yet` | Not started on control |
| `export <name> is on its way to control: <k> of <n> files arrived` | Partly sent |
| `every export has left the rig: they are on control` | Yes. Or `in the results repository` |

## A full reset

A [full reset](../how-to/operate/rig-lifecycle.md#fully-reset-a-rig) waits at `verifying` until its full export has left the rig in the same way: reported pushed to the results repository, or held in full on control. For a rig without either, the reset fails with `the rig has no results repository, and its supervisor does not send exports to control (an older version): its export cannot be verified`.

## Errors

The supervisor's `last_error`, in red on the rig's **Results** row:

| Error | Meaning |
| --- | --- |
| `upload failed: …` | A send to control failed: control could not be reached, or answered with an error. The export waits and goes again next round |
| `upload failed: export <name>: control answered 503: control keeps no exports: it has no folder for them` | A control started without its exports folder. The export waits |
| `export <name> refused: …` | The export does not match its own manifest. It is never sent, and stays in the outbox |
| `export <name>: control has another export named <name> from this rig` | Control already holds a different export by that name. It is not sent again, and stays in the outbox |
| `export <name> is no longer in the outbox` | The export went before it was sent, for example in a wipe. It is not sent |

The **Results** row also says `· N waiting to leave the rig` while exports wait.
