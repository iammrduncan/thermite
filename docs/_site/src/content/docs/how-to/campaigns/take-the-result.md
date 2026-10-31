---
title: "Take the result"
description: "Download a run's best change as a patch and apply it to your project."
type: how-to
sidebar:
  order: 13
---

A run's result is its [champion](../../reference/glossary.md): the best version of your project that the judge has confirmed. Thermite never pushes to your project. You download the champion as a patch and apply it yourself, to the commit the run started from.

This is the result of a hill climb or a goal campaign. A research campaign changes no code: its result is its report, which **Latest report** on the run's **Overview** opens, and its research folder, which the rig's export after the final report carries, and any full export at any time ([Get a rig's results from control](../operate/exports-on-control.md)). A research run whose questions the review panel found answered also has its [research paper](../../explanation/campaign-modes.md#the-research-paper), which starts its final report: on the run's **Overview**, **Research paper** opens it, and the `paper.md` link in the **Research paper** line opens it as plain text, named `<run>-paper.md` when you save it. The research folder holds it as `paper.md`.

## Before you start

- The run has a champion beyond its starting point: on the run's **Overview** tab, **The run** block shows **Champion** as `#2` or higher. The starting point itself is champion #1. In a hill climb whose seed the judge could not measure, the first setup change it could measure became the run's starting point as a new champion ([Setup](../../reference/verdicts.md#setup)), and its patch holds the fix that made the project build and run.
- The rig has published that champion with an export. Exports happen every hour when there is something new, while the rig's **Exports** switch on **Edit rig** is on. To publish at once, open the rig's page, press **Export**, then **Export** under the choice.
- A minute or two after the export, the rig's supervisor has uploaded the patch to control. Control keeps it only if it matches what the rig published. This works on every rig, with or without a results repository.

## 1. Download the patch

1. Open **Campaigns**, then the campaign. A campaign with no run at work whose newest run is closed, **Completed** or **Finished**, shows only when you choose the filter **All**. Open the run: press its name on its card under **At work now**, or in its row under **Earlier runs**. The run's page opens on its **Overview** tab.
2. In the block **The run**, beside **Champion**, press the link **download champion #N as a patch**. The link shows only once the rig has exported the champion: press **refresh** after **Export**. The note beside it, such as `(applies to 0123abcd)`, names the commit the patch applies to: the run's starting commit.

The champion's own page, which you reach from its row under **Champions** or **Attempts**, has the same link. To see whether another rig's judge has confirmed the champion too, see [Run a campaign on several rigs](several-rigs.md#4-check-the-result).

The file is named `<run>-champion-<n>-on-<commit>.patch`, such as `sort-speed-1-champion-3-on-0123abcd.patch`. If you see `No patch for that champion yet.`, the rig has not exported since the promotion, or the upload has not arrived: press **Export** on the rig's page, then **Export** under the choice, wait a minute or two, and try again.

## 2. Apply it

The patch holds every change from the run's starting commit to the champion, binary files included. Apply it to a checkout of that commit, here `0123abcd`:

```sh
git clone https://git.example.com/you/project.git
cd project
git checkout 0123abcd
git apply --check ~/Downloads/sort-speed-1-champion-3-on-0123abcd.patch
git apply ~/Downloads/sort-speed-1-champion-3-on-0123abcd.patch
```

`git apply --check` prints nothing when the patch applies cleanly. Then build and test the project as you usually do, and commit the change on a branch of your own.

### A project in a folder of its repository

When the campaign's project is one folder of its repository (**Folder in the repository** on the **New campaign** page, `project.folder` in a [contract](../../reference/contract.md)), the patch's paths start at that folder. The note beside the link says so: `(applies to the folder examples/matmul-cpu/project at 0123abcd: git apply --directory=examples/matmul-cpu/project)`. `0123abcd` is the repository's commit the run started from, and the file is named after it. Apply the patch at the top of the repository, with `--directory`:

```sh
git checkout 0123abcd
git apply --check --directory=examples/matmul-cpu/project ~/Downloads/sort-speed-1-champion-3-on-0123abcd.patch
git apply --directory=examples/matmul-cpu/project ~/Downloads/sort-speed-1-champion-3-on-0123abcd.patch
```

If your branch has moved on since that commit, either commit the change on a branch made from that commit and merge it into yours, or apply it on your branch with `git apply -3`, which falls back on a three-way merge and marks any conflicts. `-3` needs that commit in your clone.

## Download it from a script

Control serves the same patch over the REST API, with the owner's token. The example uses the owner's token file of the local stack, `.dev/secrets/control-admin-token`. If you made an owner's token of your own, use its file instead.

```sh
curl -sS -D headers.txt -o champion.patch \
  -H "Authorization: Bearer $(cat .dev/secrets/control-admin-token)" \
  http://127.0.0.1:8800/v1/runs/sort-speed-1/champions/3/patch
```

The headers name the full starting commit in `x-thermite-base-commit` and the patch's SHA-256 in `x-thermite-sha256`. For a project in a folder, the starting commit is the run's own: the folder's files, with no parent, which only the rig has. Apply the patch to the repository's commit that the dashboard's note names, as above. Compare the SHA-256 with the file's own: `sha256sum champion.patch` on Linux, `shasum -a 256 champion.patch` on a Mac. Before the patch is there, control answers `404` with `{"error":"no patch for that champion"}`.

## Keep every result

When the rig pushes to a results repository, each export there also holds the champion as `champions/<run>/<n>.patch`, with `champions/<run>/<n>.json` beside it, on the branch `thermite/<rig>/attempts`. That repository is the lasting copy of a rig's results. See [Set up the results repository](../operate/results-repository.md). Rigs that control sets up have no results repository yet ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)): they send each export to control instead, champions included. See [Get a rig's results from control](../operate/exports-on-control.md).
