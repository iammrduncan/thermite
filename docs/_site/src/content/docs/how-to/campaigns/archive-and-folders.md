---
title: "Archive campaigns and sort them into folders"
description: "Take the campaigns you are done with out of the dashboard's left navigation, and group the others in folders."
type: how-to
sidebar:
  order: 16
---

The dashboard's left navigation lists every campaign that a rig has reported a run of and that is not archived, finished ones too, each with its state. A campaign saved with no run yet is only at its address, `/ui/campaigns/<name>`. Archive a campaign you are done with, and put the others in folders. Neither changes a campaign's runs, results, kits or its collection in Thermite's [knowledge base](../../reference/knowledge-base.md).

The navigation does not list the rigs. **Rigs**, in the main navigation, opens the [Rigs list](../../reference/rigs-list.md), with each rig's state; the status bar along the bottom of every page still counts them.

The button beside **Thermite**, at the top of the navigation, collapses it to a column of icons, which shows neither campaigns nor folders; press it again to open the navigation. The browser remembers which you chose, on every page.

## Before you start

- You are signed in to the dashboard.
- To archive a campaign, no run of it is at work or waits to start. Pause a run at work from its page (**Pause**), or let it finish. A paused run may stay paused.

## Archive a campaign

1. Open the campaign's page: press it in the left navigation, or open **Campaigns** and press it in the table.
2. Press **⋯** at the top right of the page, then **Archive**.

The page says `Archived sort-speed. It left the navigation, Needs you and the Overview.` Under it, a line says when and by whom the campaign was archived, with **Unarchive**. The campaign is gone from the left navigation, from **Needs you** and from the Overview's lists. It keeps its folder: the folder no longer shows or counts it, and it comes back into that folder when you unarchive it. Its page, its runs and their pages stay where they were, and a decision that waits in one of its runs still shows on that run's page.

While the campaign is archived, control starts and resumes none of its runs: **Start a run** is gone from its page, and a start or a resume over REST, MCP or the command line is refused with `sort-speed is archived. Unarchive it first.` **Copy** still works.

If a run is at work, nothing changes, and the page says why:

```text
Not archived. Pause or close its runs first. sort-speed-2 is at work on rig-1.
```

`sort-speed-3 waits to start on rig-1.` means control has sent the rig a start or a resume of that run, and the rig has not taken it yet. Wait a minute and press **refresh** in the status bar, then pause the run once it shows as at work.

## Find an archived campaign, or unarchive it

1. Open **Campaigns** and choose the filter **Archived**. The table lists each archived campaign with its runs, its best result, when and by whom it was archived, and the folder it keeps, such as `in Kernels`. The filter **All** lists them too, marked `archived`.
2. Press **Unarchive** on its row.

The campaign is back in the left navigation, in the folder it kept, or in none, and its runs may start again: `Unarchived sort-speed. It is back in the navigation, in Kernels.` **Unarchive** under **⋯** on its page does the same.

## Make a folder

1. In the left navigation, press the folder button beside **Campaigns**.
2. Under **New folder**, type a name, such as `Kernels`, and press **Create**.

The page says `Made the folder Kernels. Drag a campaign onto it, or use Move to folder on a campaign's page.`, and the folder shows in the navigation, above the campaigns in no folder. A name is one line of at most 40 characters, and two folders can't have the same name, whatever its case: `There is a folder named Kernels already.`

## Put a campaign in a folder

- **Drag it** in the navigation onto the folder. While you drag, the folder you are over is outlined, and **Drop here: no folder** shows under the list: drop a campaign there to take it out of its folder. The line under the list says `Moved sort-speed to Kernels.`
- **Or from its page**, with the keyboard or on a phone: press **⋯**, choose the folder under **Move to folder**, and press **Move**. **No folder** takes it out of its folder.

On a narrow screen, such as a phone's, the navigation shows no campaigns: use **Move to folder** there.

A campaign is in one folder at most. An archived campaign keeps its folder, though the navigation does not show it there; **Move to folder** on its page still changes the folder it comes back into.

## Fold a folder

Press the folder's name. It folds shut, or opens again. This browser remembers which folders are folded, also after a reload; another browser shows them open.

## Rename or delete a folder

Press **⋯** beside the folder's count.

- **Rename:** change the name under **Folder name** and press **Rename**. Its campaigns stay in it.
- **Delete folder:** deletes a folder with no campaign in it, archived ones included. A folder with campaigns is refused, and an archived one is marked: `Not deleted. Kernels is not empty. Move its 2 campaigns out first: sort-speed, gemv-speed (archived).` A folder that holds only archived campaigns says so in the navigation, such as `1 archived campaign, not shown.`: open the campaign from **Campaigns › Archived** and use **Move to folder** on its page.

## Over REST or MCP

The same changes work without the dashboard, with the same refusals. With the owner's token:

```sh
curl -sS -X POST -H "Authorization: Bearer $(cat ~/thermite-owner-token)" \
  "https://control.example.com/v1/campaigns/sort-speed/archive"
```

```json
{"campaign":"sort-speed","archived":true,"at":"2026-10-21T18:02:11.000Z","by":"owner:api","folder":"Kernels","changed":true}
```

[The REST API](../../reference/rest-api.md#archive-a-campaign-and-folders) lists every route, and [MCP tools](../../reference/mcp-tools.md#archive_campaign) the tools, which the owner's and an operator's tokens may call.

## Check that it worked

- The left navigation shows each folder with its campaigns and its count, and no archived campaign: an archived one neither shows nor counts in its folder.
- **Campaigns › Archived** lists the archived campaigns.
- **Audit log** has an entry for each change: `campaign_archived`, `campaign_unarchived`, `campaign_folder_created`, `campaign_folder_renamed`, `campaign_folder_deleted` and `campaign_moved`, and `refused` with why for each refusal.
