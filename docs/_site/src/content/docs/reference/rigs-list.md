---
title: "The Rigs list"
description: "Every part of the dashboard's Rigs list: its columns, the states a rig can be in, needs update, the filters, the summary line and where each row leads."
type: reference
sidebar:
  order: 20
---

**Rigs**, in the dashboard's sidebar, lists every [rig](glossary.md) in one table, one row for each rig. Its address is `/ui/rigs`. It is the dashboard's one list of rigs: the sidebar itself lists campaigns, not rigs, and the status bar along the bottom counts the rigs. The table says what state each rig is in, where it runs, its version, the run at work and the rig's last report. A rig's checks, keys, history and its update are on [the rig's page](rig-page.md).

## The top

The line beside the title counts the rigs, then, when there are any, those that need an update, are stale, are offline or are stopped, then the runs at work. For example: `7 rigs · 2 need an update · 1 stale · 1 offline · 1 stopped · 4 runs at work`. The runs at work are the running runs on rigs that are live, stale or have a key to accept: such a rig may still be at work.

The buttons at the right:

- **Launch on RunPod** opens [the launch form](../how-to/install/runpod-rig.md). It shows only when **Settings › Providers** has a RunPod account.
- **Add a rig** opens the ways to add a rig.

## Filters

The chips above the table narrow it. Each shows how many rigs it holds. They are links, such as `/ui/rigs?f=update`, so they work without the page's script.

| Chip | The rigs it shows |
| --- | --- |
| **All** | Every rig that is not retired |
| **Live** | The state is **Live** |
| **Needs update** | The version is behind control's, or control refuses the rig |
| **Refused** | The state is **Refused** |
| **Stale or offline** | The state is **Stale** or **Offline**, or **Key to accept** while the rig does not report |
| **On RunPod** | The rig was launched on RunPod |
| **Stopped** | The state is **Stopped** |

With no rig, the page says `No rig has reported yet.`; a chip with no rig shows `No rig here.`

## Columns

| Column | What it shows |
| --- | --- |
| **State** | A chip: see [States](#states). Its **i** says what each one means |
| **Rig** | The rig's name, a link to its page |
| **Where it runs** | `Machine · gpu-host-1` (`gpu-host-1, removed` once the rig was removed there), `Cluster · cluster-1`, `RunPod · EU-RO-1`, `Joined · a machine` or `Joined · a namespace`, or `Set up by you` for a rig in control's rig tokens file or added with `thermite rig add`. Under it, the rig's hardware as it reported it, or a pod's GPUs before its first report |
| **Version** | The Thermite version of the rig's harness and supervisor: see [Version](#version) |
| **Run at work** | The running run, a link to its page, with its campaign and its last attempt, such as `q4-gemv · last attempt 4 min ago`, or `no attempt yet`, and `and 1 more` when more runs are running. On a rig that does not report, it is grey and says `as of its last report` (`as of 12 min ago` for a refused rig). With no run at work: `No run at work`, and why: a stopped pod's reason (see [A stopped pod](#a-stopped-pod)), `not reported yet`, how many runs are paused (`2 paused`), `no run running`, or `no campaign assigned`. When control can't read a rig's events now: `Its events can't be read now`, and why, as [the rig's page](rig-page.md#the-top) says |
| **Progress** | The run at work's progress: `+9.1%` for a hill climb, `4/8 goals` for a goal run (`goals not checked yet` before its first check), `84 verified claims` for a research run. Grey on a rig that does not report |
| **Last report** | How long ago the rig last reported, such as `12 s ago`. Orange when the rig is stale, red when it is offline or refused, with `refused since` under it. `none yet` before the first report |
| **Per hour** | Only for a rig on RunPod: what the pod costs per hour now, such as `$1.65/h`, and under it what it has cost so far, such as `$9.80 so far`. A stopped pod says `storage only`: RunPod bills only its volume, which control does not count. A pod that RunPod no longer has says `none`, with what it cost `in all`. The column shows only when a rig runs on RunPod |

## States

| Chip | When |
| --- | --- |
| **Live** | The rig reported within the stale window (`THERMITE_CONTROL_STALE_SECONDS`, 180 s by default) |
| **Stale** | No report for longer than the stale window. A stale rig may still be at work |
| **Offline** | No report for longer than the offline window (`THERMITE_CONTROL_OFFLINE_SECONDS`, 900 s by default) |
| **Refused** | Control refuses the rig's reports: their versions do not work together |
| **Stopped** | A rig on RunPod whose pod is stopped. It is not called stale, offline or not reporting: not here, in the status bar, **Overview**'s tallies (`rigs reporting, 1 stopped`), **Live**'s **Idle rigs** or a run's page. **Needs you** shows no card for it. **New campaign** and **Start a run** offer it, and a run started there starts the pod first |
| **Key to accept** | A new key from the rig waits for you: see [Accept a rig's key](../how-to/operate/accept-a-rig-key.md) |
| **Getting ready** | A pod launched on RunPod that has not reported yet. It costs money from its launch, so it is listed with its price |

## Version

| It shows | When |
| --- | --- |
| `0.1.0`, grey | The rig runs control's version |
| **needs update ›**, orange, with `0.0.9 · behind` | The rig runs an older version that works with control's |
| **needs update ›**, red, with `0.0.7 · refused` | Control refuses the rig because its version is too old |
| **update control ›**, red, with `0.3.0 · refused, newer` | Control refuses the rig because its version is too new: control needs the update |
| `0.2.0`, orange, with `newer than control` | The rig runs a newer version that works with control's |
| `not reported` | The rig sends no version: control works with it as before |
| `not reported yet` | A pod on RunPod before its first report |

**needs update** and **update control** open the rig's page at its version banner (`/ui/rigs/<rig>#version`). The update and its steps run there: see [Update to control's version](../how-to/operate/rig-lifecycle.md#update-to-controls-version).

## A stopped pod

A RunPod rig whose pod is stopped shows `No run at work` and why it stopped:

| It says | When |
| --- | --- |
| `its idle stop stopped it 2 h ago · a new run wakes it` | The [idle stop](../how-to/install/runpod-rig.md#5-watch-its-cost-and-change-its-limits) stopped the pod. Starting or resuming a run on it starts the pod first |
| `you stopped it 2 h ago · a new run wakes it` | The owner stopped it |
| `its spend limit stopped it 2 h ago · raise the limit to start it` | It cost its spend limit. Control refuses to start it until the limit is raised or cleared |
| `it is stopped · a new run wakes it` | It stopped another way, such as from RunPod's console |

Its **Last report** says `then it stopped` under the time.

## Where a row leads

Click anywhere on a row to open the rig's page; the links in a row (the rig, the run, **needs update**) go where they say. A row opens the page at the banner of its state:

| The rig | The row opens |
| --- | --- |
| Behind control or refused | `/ui/rigs/<rig>#version` |
| Stale or offline | `/ui/rigs/<rig>#reporting` |
| A stopped pod | `/ui/rigs/<rig>#pod` |
| Any other | `/ui/rigs/<rig>` |

## Retired

Under the table, **Retired** lists the rigs that were retired, with when and by whom. They are out of the table. Each name opens its page, which has **Bring it back**.
