---
title: "Get a rig's results from control"
description: "Ask a rig for an export, normal or full, download it from the Exports page as one archive, and check that every result has left the rig before you remove it."
type: how-to
sidebar:
  order: 10
---

A rig without a [results repository](results-repository.md), such as a rig that control set up on a machine or a cluster, or a rig on a GPU cloud, sends its exports to control. Control checks every file against the export's manifest and keeps it. This page asks a rig for an export, downloads it, and checks that a rig's results have all left it, for example before you remove the rig.

## Before you start

- A rig whose page says, on the **Results** row of **The rig** block, `N exports · sent to control … ago`, or `sent to control: none yet`. A rig with a results repository says `pushed … ago` instead: its exports are there, not on control.
- To check a download's files: `tar` and `jq`.
- For the scripted way only: the owner's token in a file (these steps use the local install's, `.dev/secrets/control-admin-token`), and `curl`.

## 1. Ask for an export

1. Open the rig's page (**Rigs** in the sidebar, then the rig), or the page of a run on it.
2. Press **Export** in the page's header. A small menu opens and names what it exports: `Export rig-1.`, or, on a run's page, `Export sort-speed-1, or rig-1, the rig that holds it.`
3. Under **What to export**, choose one:
   - **This run**, on a run's page only, and chosen there: the run alone, from its start: its events, attempts and notes, its research folder as it stands, with its paper when it has one, and the pages it fetched. No other run is in it, and no snapshot of the ledger, which holds every run.
   - **What changed**: what the rig recorded since its last export, with the research folders of the runs that finished since. On a run's page it reads **What changed (all of rig-1)**.
   - **Full export**: also a snapshot of the ledger, which holds every event, claim, source, finding, report and note; every run's research folder, finished or not; and each run's archive of the web pages it fetched. Choose it to take every run's record off the rig, even runs that still run, are paused or are broken. On a run's page it reads **Full export (all of rig-1)**.
4. Press **Export** under the choice.

The button says `Sending…`, then `Sent`. A line at the top of the page says `Sent to rig-1 at 12:00 UTC. Waiting for the rig to take it. A full export was asked for.` (or `An export of sort-speed-1 alone was asked for.`), then where the export will show: `When all its files reach control, it shows on the Exports page, ready to download. A rig with a results repository pushes it there instead.` Once the rig has made it, the line begins `Done. rig-1 took it at 12:00 UTC. It made the full export 20261020T120000-0123abcd.`

## 2. Download it from the Exports page

1. Press **Exports** in the sidebar. To see one rig's exports only, follow **its exports on control** on the rig's **Results** row, or press the rig's name above the table.
2. Find the export: the newest is first. **Kind** says `full` or `what changed`, and **Complete** says when its last file reached control.
3. Press **Download**. The browser saves `<rig>-<export>.tar.gz`, such as `rig-1-20261020T120000-0123abcd.tar.gz`.

An export whose **Complete** says `still arriving` has no **Download** yet: control has not all its files. The rig sends the rest every round, a minute by default; press **refresh** in the status bar.

The archive holds one folder, `<rig>-<export>/`, with the export's `manifest.json` and every file at its path in the export. [Set up the results repository](results-repository.md#what-gets-pushed) says what each file holds. To check the files against the manifest's SHA-256s:

```sh
tar -xzf rig-1-20261020T120000-0123abcd.tar.gz
cd rig-1-20261020T120000-0123abcd
jq -r '.files | to_entries[] | "\(.value)  \(.key)"' manifest.json | sha256sum -c --ignore-missing
```

Each file says `OK`. On a Mac, use `shasum -a 256 -c --ignore-missing` in place of `sha256sum -c --ignore-missing`. Only some exports hold `ledger.sqlite`: the rig's harness puts a copy of its ledger in the first export, then once a day, and in every full export ([What goes to control](../../reference/exports.md#what-goes-to-control)).

A run's champion is also a patch you can [download from the run's page](../campaigns/take-the-result.md).

## The scripted way

The same steps over [REST](../../reference/rest-api.md), with the owner's token:

```sh
TOKEN=$(cat .dev/secrets/control-admin-token)
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8800/v1/rigs/rig-1/exports
```

```json
{"exports":[{"name":"20261020T120000-0123abcd","full":false,"from_event":180,"through_event":245,"files":14,"files_kept":14,"bytes":5230113,"bytes_received":5230113,"created_at":"2026-10-20T12:00:03.120Z","complete_at":"2026-10-20T12:00:09.877Z"}]}
```

Newest first. An export with `complete_at` set holds every file it promised, each checked. One with `null` is still arriving.

Download one complete export as the archive the dashboard gives:

```sh
NAME=20261020T120000-0123abcd
curl -fsS -H "Authorization: Bearer $TOKEN" -o "rig-1-$NAME.tar.gz" \
  http://127.0.0.1:8800/v1/rigs/rig-1/exports/$NAME/archive
```

Or one file of it: `GET /v1/rigs/rig-1/exports/$NAME` lists each file with its size and SHA-256, and `GET /v1/rigs/rig-1/exports/$NAME/file?path=<path>` downloads one, with its SHA-256 in the header `x-thermite-sha256`. To ask for an export, send the signed command [`export_now`](../../reference/signed-commands.md#export_now) with `{"full": true}` or `{"full": false}`. Over MCP, the tool `exports` lists them; it downloads nothing.

## 3. Check that every result has left the rig

```sh
curl -fsS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:8800/v1/rigs/rig-1/results-left?export=$NAME"
```

```json
{"left":true,"why":"every export has left the rig: they are on control","to":"control","waiting":0,"champions_waiting":0,"reported_at":"2026-10-20T12:01:00.000Z"}
```

With `"left":false`, `why` says what still waits, such as `1 export waits on the rig to go to control`. Wait for the next round, a minute by default, and ask again. [Have all results left the rig?](../../reference/exports.md#have-all-results-left-the-rig) lists every answer.

With `"left":true` for the export you made in step 1, everything the rig recorded up to that export is on control. You can now [remove the rig](rig-lifecycle.md#remove) without losing its results.
