---
title: "Run a campaign on several rigs"
description: "Run one campaign on more than one rig, and have another rig confirm the best result."
type: how-to
sidebar:
  order: 12
---

One campaign can run on several [rigs](../../reference/glossary.md) at once, each with its own run, agents and judge. You can then send one rig's [champion](../../reference/glossary.md) to another rig, from the run's **Planner** tab, and the other rig's judge tests it again on its own hardware. If it holds up there too, the result is **cross-verified**.

:::caution[Sending champions needs a shared results repository]
Rigs send each other champions through one [results repository](../operate/results-repository.md) that they all push to. Of the rigs Thermite sets up, only the local compose stack's two rigs, on one computer, have one. Rigs that control sets up on machines and clusters, and rigs you join yourself, have none, and you can't give them one: the units and manifests that control writes for them have no setting for it ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)). They can run the same campaign side by side, but can't send each other champions, so nothing is cross-verified.
:::

## Before you start

- Two or more rigs that report to control, with the target (CPU or GPU) of the campaign's kit.
- To send champions between rigs, every rig involved pushes its results to **the same results repository**: the supervisor setting `THERMITE_RESULTS_REMOTE` is the same on each. See [Set up the results repository](../operate/results-repository.md). The local stack does this already. Start its second rig, `local-2`, with `docker compose --profile two-rigs up -d`, with the same `-f` options you start the stack with (`podman compose` with Podman).
- Each rig's **Exports** switch, on **Edit rig**, is on. It is on unless you turned it off.

## 1. Start a run on each rig

A rig runs one run at a time, so each rig gets its own run.

1. Open **Campaigns** in the sidebar, then the campaign, and press **Start a run** at the top of its page. A panel opens.
2. Under **Where it runs**, choose the next rig. A rig with other hardware than the campaign's kit is greyed out.
3. Keep **Agents** on **On**. When another run of the campaign has experiments waiting in its [queue](choose-what-runs-next.md), **Experiments to start with** copies them into the new run's queue unless you untick it. Each run then works through its own copy, so both rigs try the same experiments. Untick it for the new run to start with an empty queue, which its planner fills.
4. Press **Start the run**.

This works for a campaign made on the **New campaign** page, which runs its latest saved version, and for one started from the command line, the REST API or MCP. For those, control assigns the campaign again as it assigned its newest run: the same contract, starting commit and imports, as a new run. The new rig must get the project and the kit the same way: if you put them in the first rig's inbox as bundles, or the first rig already had them (`--seed-commit`, or no `--kit`), put them on the new rig too. You can also run `thermite assign` again for each rig, with the same contract and starting commit: see [Start a campaign from the command line](start-from-command-line.md). From a script or an agent, `thermite run start sort-speed --rig local-2`, `POST /v1/campaigns/sort-speed/runs` and MCP's `start_run` do what **Start a run** does: see [Start a run from a script or an agent](start-from-dashboard.md#start-a-run-from-a-script-or-an-agent).

Every run must start from the same commit, as **Start a run** does: a rig can take another rig's champion only when it has the commit that champion started from.

The campaign's page then shows each running run as a card under **At work now**, and paused, completed and finished runs under **Earlier runs**, with the runs of a retired rig and those from before a rig's full reset. Each run has its own page: press its name.

## 2. Publish a champion

A champion beyond the starting point can be sent once its rig has published it, with its next export. Exports happen every hour when there is something new. To publish at once, open the rig's page, press **Export**, then **Export** under the choice.

## 3. Send the champion to another rig

1. Open the page of the run that has the champion, and its **Planner** tab. Its **Other rigs** card shows once the run has published a champion.
2. Beside **Send champion #N**, choose the receiving run, shown as `<run> on <rig>`. The list holds other rigs' runs of the same campaign.
3. Press **Send champion #N**.

The dashboard opens the receiving run's page. The receiving run must be running when the champion arrives: if it is paused or finished, the command fails, and **Commands** in the sidebar shows the reason, such as `run sort-speed-1 is paused`. Resume the run, then send the champion again.

You can also send it with the owner's token over the REST API, `POST /v1/propagate` with `{"run": "sort-speed-1", "to_run": "sort-speed-2"}`, or with the MCP tool `propagate_champion` and the same two fields. `run` and `to_run` are the two runs' names, as the list beside **Send champion #N** shows them. A run's name is used once on control, on every rig: **Start a run** numbers a campaign's runs across all its rigs, so the run on `local-2` is `sort-speed-2`, and control knows the rig each run is on.

## 4. Check the result

The receiving rig rebuilds the champion from its patch, checks that it matches what the source rig published, and its own judge measures it against its own champion, like any other change. The receiving run's **History** shows `Champion #3 arrived from local-1 to be judged here.`, then `Another rig's champion held up here too.` or `Another rig's champion did not hold up here (…).` with the verdict.

A confirmed change goes on there as any other change would: it becomes the champion unless the auditor blocks it or the run asks you about it, which puts it under **Needs you** on **Overview** as **Your decision**. `Another rig's champion held up here too.` comes once it becomes the champion there, by itself or when you press **Make it the champion**. See [Decide what waits for you](decide-what-waits.md).

When it holds up and becomes the receiving run's champion, the source run is cross-verified by the receiving rig. To see it:

- On the receiving run's page, the **Attempts** tab's **Champions from other rigs** table shows each champion that arrived, with its **Result here**: `judging`, `accepted`, or `rejected` with the verdict.
- On the campaign's page, under **Earlier runs**, the **Result** of a paused or finished run whose champion held up elsewhere carries a ✓ pill, `cross-verified on local-2`. A run still at work, shown as a card under **At work now**, has no pill.
- The **Leaderboard** page lists every hill climb's runs with a **Cross-verified** column: `by local-2`, or `not yet`. A hill climb's page links it: **leaderboard**, at the end of the line under the campaign's name. Its address is `/ui/leaderboard` on control, such as `http://127.0.0.1:8800/ui/leaderboard`. The sidebar has no link to it ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)).
- `GET /v1/leaderboard` and the MCP tool `leaderboard` list the rigs under `verified_by`.

Cross-verification counts for the champion that was sent. When the source run finds a newer champion, that one is `not yet` cross-verified until it too is sent and holds up.

If the receiving run's champion is already the same code, nothing is judged, and the source is not marked cross-verified.

## If it is refused

After **Send champion #N**, the dashboard answers with a plain page that says `refused:` and the reason. Use your browser's **Back** button to go back to the run.

| Reason | What it means |
| --- | --- |
| `the source run has no champion beyond its seed` | Nothing has won yet |
| `champion seq N is not published yet (it is published with the rig's next export)` | Wait for the export, or press **Export** on the rig's page |
| `<run> runs <campaign>, not <campaign>` | The receiving run is another campaign's |
| `the target works on <repo>, the champion is in <repo>` | The two runs work on different projects |

If the receiving rig can't find the champion in the results repository, the command stays **pending** on the **Commands** page and expires after 24 hours. Check that both rigs push to the same results repository: each rig's page shows **Results** with `pushed … ago`, or `no results repository`.
