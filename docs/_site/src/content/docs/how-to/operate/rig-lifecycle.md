---
title: "Stop, restart, remove or reset a rig"
description: "Stop, start, restart, update, remove, retire, bring back or fully reset a rig, and know what each one keeps."
type: how-to
sidebar:
  order: 6
---

What you can do to a [rig](../../reference/glossary.md), and where, depends on how the rig was set up. This page lists each action for each kind of rig, then gives the steps.

| Action | The local compose stack | Set up by control on a machine | Set up by control on a cluster | Joined yourself | Launched on RunPod |
| --- | --- | --- | --- | --- | --- |
| Stop and start | Your compose tool | **Stop its services**, **Start its services** | **Stop its pods**, **Start its pods**, or MCP's `cluster_rig` | Commands on its page, which you run there | **Stop the pod**, **Start the pod**, `thermite runpod stop`, `start`, or MCP's `runpod_rig` |
| Restart | Your compose tool | **Restart them** | **Restart them**, or MCP's `cluster_rig` | A command on its page | **Restart the pod**, `thermite runpod restart`, or MCP's `runpod_rig` |
| Move to new images | Your compose tool | **Update to** control's version | **Update to** control's version, or **Update to these images** | Not yet | Not yet: launch a new rig |
| Change its GPUs, CPUs and memory | Your compose tool | Not yet: add a new rig | **GPUs**, **CPUs** and **Memory (GiB)** on **Edit rig**, or MCP's `set_cluster_rig_resources` ([how](../install/rig-on-a-cluster.md#change-the-rigs-gpus-cpus-and-memory)) | Not yet: add a new rig | Not yet: launch a new rig |
| Remove | Your compose tool | **Remove the rig** | **Remove the rig** | A command on its page, then **Retire the rig** | **Terminate**, or `thermite runpod terminate`, which also retires it |
| Retire, bring back | Yes | Yes | Yes | Yes | Yes |
| Full reset | Yes | Yes | Yes | Yes | Yes, with the pod running; the pod and its GPU stay |

A full reset needs the rig's full export off the rig first: in its [results repository](results-repository.md), or, for a rig without one, on control. Of the rigs Thermite sets up, only the compose stack has a results repository; the others send their exports to control ([Exports](../../reference/exports.md#where-exports-go)).

A rig launched on RunPod has its buttons under **The pod** on its page: **Stop the pod**, **Start the pod**, **Restart the pod**, **Start the full reset** and **Terminate**. [Run a rig on RunPod](../install/runpod-rig.md#6-stop-and-start-it) gives the steps and the commands, which the REST API and MCP have too. Its stop sends its results out before the pod stops, and its terminate removes the pod only once every result has left it. RunPod empties a stopped pod's own disk, where the rig works: the rig keeps a snapshot of its state on the pod's volume, taken every few minutes, after each export and as the pod stops, and restores it when the pod starts again, keys and enrollment with it ([What a stop keeps](../install/runpod-rig.md#6-stop-and-start-it)).

The buttons below are on the rig's page: open **Rigs** in the dashboard's sidebar, then the rig.

## Stop and start

**A rig set up by control** has a **Set up by control** block on its page. Press **Stop its services** (a machine) or **Stop its pods** (a cluster). The block shows `stopped`, and the button becomes **Start its services** or **Start its pods**. Its runs keep their status and their records. A stop ends the trials at work, as a [restart](#restart) does: the harness records them as interrupted as it stops, with the counters their workers last reported (after a crash, at its next start), their experiments go back to the top of the queue, and the judge's jobs start again. After three minutes without a report, the rig shows **Stale** on **Rigs**, and **Offline** after 15 minutes, until you start it again.

**On a cluster, a start takes a few minutes.** After **Start its pods**, a line at the top of the page says `Started.`, and the block's status, at the right of its heading, says `starting`. Control waits up to 15 minutes for the rig's pods to run, then up to 10 minutes for a report from the rig. Stay on the page: the block shows each step as it comes, with no refresh:

- Two steps get a ✓, "Its pods run again" and "A report reached control after the start", and the status says `running`.
- If a step gets ✕ instead, the status says `failed`: see [A rig on a cluster never reports](troubleshoot.md#a-rig-on-a-cluster-never-reports). When the rig reports later, its status says `running`, and a ✓ step follows the ✕: "A report reached control after the start · it reported after the wait ended". The block also offers **Try the update again** while the status says `failed`, after a start too: it applies the same images again and waits once more. See [Try again after a failure](#try-again-after-a-failure).

**One change at a time on a cluster.** While the status says `starting` or `updating`, control refuses a start, a restart and an image update. The page shows a card that starts with **Not done.** and the reason, such as `rig-1 is starting: wait until its page shows it running, or failed.` **Stop its pods** and **Remove the rig** are never refused for this. They also end control's wait for the pods and the report, so a rig you stopped or removed during a start or an update doesn't turn `failed` later. While it says `draining`, **Restart them** and **Stop its pods** still work, without the update: the rig comes back on its old images.

**A rig you joined yourself** has a **You run it yourself** block. Open "Stop, start, restart or remove it: you run these there", and run the **Stop** or **Start** command where the rig runs. Control can't reach that place, so it can't do it for you.

**The compose stack** is stopped and started with your compose tool, for example `docker compose stop supervisor harness` and `docker compose start harness supervisor`.

## Restart

A restart stops and starts the rig's two containers: its harness, which holds the judge and the agents, and its supervisor. It does not export first. Restarting the harness ends its running [trials](../../reference/glossary.md), and its judge jobs start again.

- **Set up by control:** press **Restart them** in the **Set up by control** block. The page says `Restarted.` On a cluster, the status then says `starting` until the pods run and the rig reports, as after **Start its pods**.
- **Joined:** run the **Restart** command from the rig's page, there.
- **The compose stack:** restart its containers with your compose tool, for example `docker compose restart harness supervisor` (`harness-2 supervisor-2` for `local-2`).

### Give control a deployment driver

You don't need a deployment driver for the steps on this page. With one, control also restarts a rig's containers itself: with **Restart the rig's containers** in the **⋯** menu of the rig's page, over the REST API, and at the end of a full reset. A rig launched on RunPod needs none: its restart, with **Restart the pod** on its page or over the REST API, goes to RunPod, which stops its pod and starts it again, and a full reset leaves its pod running. Without one, the menu says `No deployment driver: restarts are not available.` The setting is `THERMITE_LIFECYCLE` on control: `compose` or `kubernetes` (the [settings reference](../../reference/settings.md#restarts-and-full-resets) has the others).

On the compose stack, the file `compose.lifecycle.yaml` sets `compose` and mounts the container engine's socket into control. It is meant for development, because the socket gives control power over every container on the computer. With Docker, add it to your `-f` options. With rootless Podman, also give the socket's path, as `podman info --format '{{.Host.RemoteSocket.Path}}'` prints it, without `unix://` (on a Mac, use the path as it is):

```sh
THERMITE_ENGINE_SOCKET_HOST=/run/user/1000/podman/podman.sock \
  podman compose -f compose.yaml -f compose.lifecycle.yaml up -d
```

Use the file from the stack's first start. Added to a stack that has already run, control stops at start, with `EPERM` on `control-signing.key` in its log ([Troubleshoot](troubleshoot.md#control-stops-at-start-eperm-on-control-signingkey)). Thermite can't add the driver to such a stack yet. Start again without the file, and control comes back as it was.

The `kubernetes` driver is for a control that you run inside a cluster yourself; Thermite ships no manifest for that yet ([goal 058](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/058-helm-and-npm.goal)). Rigs that control sets up on a cluster don't need it: they have **Restart them**.

With a driver, you can also restart over the REST API with the owner's token. The examples use the owner's token file of the local stack, `.dev/secrets/control-admin-token`. If you made an owner's token of your own, use its file instead. The body is optional; without it, both parts restart:

```sh
curl -sS -X POST -H "Authorization: Bearer $(cat .dev/secrets/control-admin-token)" \
  -H 'content-type: application/json' -d '{"components":["supervisor"]}' \
  http://127.0.0.1:8800/v1/rigs/local-1/restart
```

It answers `{"restarted":["supervisor"]}`, or `409 {"error":"no deployment driver is configured"}`.

## Move a rig onto new images

A rig keeps the images it was set up with until you move it. Before you move it, keep its ledger: a **Full export** takes it off the rig, to its results repository or to control ([Keep a rig's ledger](backup-and-restore.md#keep-a-rigs-ledger)). The new harness also copies the ledger before it migrates it. What you can do depends on the kind of rig:

- **The compose stack:** rebuild its images and start it again with your compose tool, as [Stop, start and update](../install/one-machine.md#stop-start-and-update) says.
- **Set up by control on a machine or a cluster:** when its version is behind control's, **Update to** control's version on its page moves it onto the images control deploys now, with its runs paused, then checked and resumed: see [Update to control's version](#update-to-controls-version).
- **Set up by control on a cluster:** **Update to these images** also moves it onto the images control deploys now, whatever its version, as [A rig on a cluster](#a-rig-on-a-cluster) says.
- **Joined yourself:** not yet ([goal 035](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/035-rig-upgrades.goal)). Pull the new images where it runs, and start it again.
- **Launched on RunPod:** terminate it and launch a new rig on control's image.

### Update to control's version

When a rig runs an older Thermite than control, **Rigs** shows **needs update** in its **Version**, and its page shows a banner: "rig-1 runs Thermite 0.1.0. Control runs 0.2.0." For a rig control set up on a machine or a cluster, the banner has **Update to 0.2.0**. When control refuses a rig because its version is too old, that banner has the button too.

Before you start:

- **Control runs with the new images**, as for [a rig on a cluster](#a-rig-on-a-cluster): `THERMITE_RIG_HARNESS_IMAGE` (`THERMITE_RIG_HARNESS_CUDA_IMAGE` for a rig with GPUs) and `THERMITE_RIG_SUPERVISOR_IMAGE`, those of control's own version.
- **Control's address for rigs is set** (`THERMITE_CONTROL_PUBLIC_URL`).
- **The machine or the cluster is still in Settings › Providers.**

Steps:

1. Open the rig's page (on **Rigs**, **needs update** opens it at the banner), and press **Update to 0.2.0** in the banner. The button turns into **Sending…**, then **Updating…**, and a line at the top of the page says `The update of rig-1 to 0.2.0 began. Its steps show below as they happen.`
2. Stay on the page: the banner shows each step as it happens, with no refresh:
   - "Its runs paused at a safe point": control pauses the running runs, and waits up to 5 minutes for the rig to take the pause.
   - "Its containers moved onto control's images": on a machine, over SSH, control pulls both images while the rig still runs, writes its two container units again, and restarts both services. On a cluster, it applies the rig's two deployments again, at once: the runs are paused already, so the rig does not drain first as **Update to these images** does. A judge's job under way starts over: its lease is taken back at the next start, and that counts as one of the three lost leases after which a job is `blocked`.
   - "A report reached control from control's version", within 20 minutes.
   - "The isolation check after the update", within 30 minutes.
   - "Its runs resumed".
3. When every step has its ✓, the banner says "Updated. It runs Thermite 0.2.0, as control does."

If a step fails, it gets ✕ with the reason, the banner shows "The update stopped", and the runs it paused resume. Control keeps an update's step and the runs it paused in its store: if control restarts in the middle of an update, it ends the update when it starts again, resumes those runs, and the history says `control restarted while it was` and the step. Press **Update to** again to finish it. When the images could not move, the rig keeps the images it had. The rig's volumes, tokens, key, ledger, runs and results stay in every case. [A rig's page](../../reference/rig-page.md#update-to-controls-version) describes each step and its limits.

### A rig on a cluster

Control moves the rig's two deployments, its harness and its supervisor, onto the images it now deploys. The rig's volume, tokens, runs and results stay.

Before you start:

- **Control runs with the new images,** and was restarted after you set them: `THERMITE_RIG_HARNESS_IMAGE` (`THERMITE_RIG_HARNESS_CUDA_IMAGE` for a rig with GPUs) and `THERMITE_RIG_SUPERVISOR_IMAGE` ([settings](../../reference/settings.md#rigs-that-control-sets-up)). [Push the images to your own registry](../install/own-registry.md) says how. Give each new build a new tag: control compares the images' names, not their contents, and offers the update only when a name differs.
- **Control's address for rigs is set** (`THERMITE_CONTROL_PUBLIC_URL`): the update writes it into the rig's supervisor again. Without it, control refuses the update with `Control's address for rigs is not set (THERMITE_CONTROL_PUBLIC_URL): the rig would no longer know where to report.`
- **The cluster is still in Settings › Providers.**
- **The rig is not starting or being updated.** Its status says `running`, `stopped` or `failed`.

Steps:

1. Open **Rigs** and choose the rig. Its **Set up by control** block says "Control now deploys other images:" with the two image names, then:

   > Its pods restart on these images. Its volume, tokens, runs and results stay. Running trials and the judge's job under way finish first: the rig starts nothing new meanwhile. Update now skips the wait: a trial in progress then stops, and its experiment goes back to the queue. After a newer harness has opened its ledger, an older image may not open it.

2. Press **Update to these images**. The button turns into **Sending…**.

   When the rig is at work (its last report shows trials running or a job under the judge's lease), it **drains** first: the page says `rig-1 drains first: it starts nothing new, and its pods restart on the new images once 2 trials and the judge's job finish. …`, and the block's status says `draining`. The block says "Draining before its pods restart on control's images:", what it waits for, such as `It waits for 2 trials and the judge's job to finish, and starts nothing new.`, and offers two buttons:

   - **Update now, without waiting** restarts its pods at once: a trial in progress stops, and its experiment goes back to the queue.
   - **Call the update off** ends the drain: the rig goes back to work on its images, and its status says `running`.

   A card at the top of the page says since when the rig drains, who asked and what it waits for, and, under **At work**, each trial it waits for has a row under its lane: how long it has run, what it last did, a page it keeps asking for that the run refused, and its work so far. A trial stuck on such a page has `repeats a refused request` beside it. To stop one and let the drain go on, press **Stop this trial…**, then **Stop the trial**: it ends as interrupted, and its experiment goes back to the top of the queue, for after the update ([The trials it waits for](../../reference/rig-page.md#the-trials-it-waits-for)). The other trials keep running.

   The drain waits at most 60 minutes by default: the rig's [`THERMITE_DRAIN_MINUTES`](../../reference/settings.md#places-exports-and-the-broker), or the `drain_minutes` an update over MCP or REST gives. The card says when, such as `Its deadline is 05:10 UTC, in 46 min.` At the deadline it stops waiting by itself: a step reads "its deadline passed after 60 min, with 1 trial and the judge's job still at work: it starts nothing new until you choose, under Needs you or on its page", and **Needs you** asks you to choose **Update it now**, which stops what still runs, or **End the drain**, which sends the rig back to work on its images and calls the update off. Nothing is chosen for you: until you choose, the rig still starts nothing new ([At its deadline](../../reference/rig-page.md#at-its-deadline)).

   Once the rig reports that nothing runs, within a minute or two of its last trial's end, control restarts its pods: a step reads "nothing runs any more: its pods restart now". A rig with nothing at work, or whose harness is too old to report its work, restarts at once. A harness keeps the drain in memory only: if it starts again during the drain, its reports have no drain, and after two such reports control sends the drain again, with a step that reads "its harness started again and was not draining: asked again". As it starts, the harness records that the restart ended the drain (the event `rig_drain`, with `drain: false` and the reason `the harness started again`). A research run's clock stops while the rig drains, so its durations and its progress rule leave the drain out.

   Then a line at the top of the page says `rig-1's pods restart on the new images.` The block's status, at the right of its heading, says `updating`, and **Images** names the new images. A new step reads "Its deployments applied with new images", with the old and the new name of each image that changed.

3. Wait on the page: the block shows each step as it comes, with no refresh. Control waits up to 15 minutes for the new pods to run, then up to 10 minutes for a report from them. Two more steps get a ✓, "Its pods run the new images" and "A report reached control from the new images", and the status is `running` again.

If control refuses the update, the page shows a card that starts with **Not done.** and the reason, such as `The cluster cluster-1 is no longer in Providers.`, `rig-1 is being updated: wait until its page shows it running, or failed.`, the refusal for a missing address above, or kubectl's error.

If a step gets ✕ instead, with "not running after 15 minutes" or "no report after 10 minutes: it may not have started", the status says `failed`: see [A rig on a cluster never reports](troubleshoot.md#a-rig-on-a-cluster-never-reports). Fix the cause; the pods keep trying by themselves. When the rig reports again, its status says `running`, and a ✓ step follows the ✕: "A report reached control from the new images · it reported after the wait ended". To have control apply the images again and wait once more, see [Try again after a failure](#try-again-after-a-failure).

After the update, run the rig's **Isolation** and **Judge smoke** checks: control doesn't run them for you ([Check a rig](check-a-rig.md)).

What changes and what stays:

| Changes | Stays |
| --- | --- |
| The images of the rig's two deployments | Its secret, so its tokens and control's public key |
| Anything else that control now writes into the deployments, such as the address the supervisor reports to | Its volume, so its [ledger](../../reference/glossary.md) (the rig's record), runs, results and signing key |
| | Its service, its network rules and, with DRA, its resource claim template |
| | Its place: the cluster, the namespace or slot, the node, the GPUs and the storage |

- **A stopped rig stays stopped.** The page says `rig-1 runs the new images when it starts again.`, the step ends with "at its next start", and control waits for nothing. **Start its pods** then starts it on the new images: the status says `starting`, then `running` once the pods run and the rig reports.
- **A trial in progress finishes first**, unless you press **Update now, without waiting**. A trial that a restart stops is recorded as interrupted as the harness stops (after a crash, when it starts again), with the turns and tokens its worker last reported, and the lane goes on with a new one. Its experiment goes back to the top of the run's [experiment queue](../campaigns/choose-what-runs-next.md), unless the trial had already submitted its change: then the experiment is done with that change, which the judge goes on with.
- **The judge's job under way finishes first**, unless you skip the wait. A job a restart ends starts over: its lease is taken back at the next start, and that counts as one of the three lost leases after which a job is `blocked`. The drain waits only for a job whose lease is still in force: a job whose holder is gone (its lease ran out) is no work, and the draining rig takes it back to its queue, which starts nothing.
- **A plan under way when the drain begins** is recorded as its round, and starts no trial: the rig asks again whether it drains after each plan and before each trial.
- **Each lane's cache folder stays**: the next trials build from it, not from nothing ([Ports, volumes and secrets](../../reference/ports-volumes-secrets.md)).

:::caution[Going back to older images]
Thermite has no rollback ([goal 035](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/035-rig-upgrades.goal)). To go back, set control's image settings to the old images, restart control, and press **Update to these images**. This works when the new harness never opened the rig's ledger, for example when the new pods never ran. A newer harness that ran may have upgraded the ledger, and an older harness refuses such a ledger before it changes anything: it stops at start, as [The harness stops at start: the ledger is newer](troubleshoot.md#the-harness-stops-at-start-the-ledger-is-newer) says. Nothing is lost then: move the rig onto the newer images again.
:::

Over MCP, the owner's and an operator's tokens do the same with `update_rig_images`, which drains first unless it is given `"wait": false`. They stop, start and restart the rig with `cluster_rig`, for example `{"rig": "rig-1", "action": "start"}`; it has no `remove`. `rig_setup` shows the rig's status and each step: see [From an agent or a script](../install/rig-on-a-cluster.md#from-an-agent-or-a-script). The REST API has no route for these.

### Try again after a failure

When a change to the rig's pods failed, its status says `failed`. This happens after a new rig's first wait, a start, a restart or an update. It also happens when control's own work on the rig stopped with an error, such as kubectl that could not be reached: the rig's steps then show the step that failed, with the error, and control's log has `background work failed` with the rig's name. A rig never stays `deploying`, `starting`, `updating` or `draining` because of such an error. When the rig already has control's images, the block offers to apply them again; when control deploys other images, it offers **Update to these images** instead.

1. Fix the cause first: see [A rig on a cluster never reports](troubleshoot.md#a-rig-on-a-cluster-never-reports).
2. On the rig's page, the block says "The last change to its pods failed (see the steps above). Try it again on control's images:", with the two image names. Press **Try the update again**.

   Control applies the rig's two deployments again, as for an update. The page says `rig-1's pods restart on control's images again (a retry).` The status says `updating`, and a new step reads "Its deployments applied with new images", with the detail `the same images again, after a failed change`.
3. Wait on the page. As after an update, the status says `running` once the pods run and the rig reports, or `failed` again with the step that failed.

Over MCP, `update_rig_images` does the same for a rig whose status is `failed`, with the same answer.

### When only control's address changed

When you move control to a new address, set `THERMITE_CONTROL_PUBLIC_URL` to it and restart control. A rig keeps reporting to the old address until its supervisor gets the new one. When control's images changed too, **Update to these images** gives the rig the new address as well. When only the address changed:

1. Open the rig's page. Its **Set up by control** block says "Control's address for rigs changed: the rig reports to `https://control-old.example.com`, control is now at `https://control.example.com`."
2. Press **Give it control's new address**. The rig's pods restart with the new address, on the same images. A rig at work drains first, as for an update. Its volume, tokens, runs and results stay.

   The page says `rig-1's pods restart with control's new address.`, and the status says `updating`. Control waits for the pods and a report, as after an update. For a stopped rig, the page says `rig-1 gets control's new address when it starts again.` The new step "Its deployments applied with new images" has the detail `control's address for rigs →` and the new address.

Before it restarts anything, control reads the address in the rig's supervisor deployment. When it is already the new one, the answer is `rig-1 already runs control's images.` and nothing changes. When control can't read the deployment, it refuses with `Control could not read rig-1's deployment to compare control's address:` and kubectl's error, or `kubectl's answer is not a deployment` when kubectl printed something else, never taking it for an unchanged rig: check that the cluster is reachable and that the deployment is still there.

Control records the address it gives each rig. A rig set up by a control too old to record it shows no button. On the dashboard, it gets the new address with its next **Update to these images**. To give it the address now, call `update_rig_images` over MCP: control reads the deployment in the same way and applies it again with the new address.

## Remove

**Set up by control:** removing the rig deletes everything on it. These rigs have no results repository: they send their exports to control, which keeps them with the rig's events and the patch of each champion the rig has exported. So, before you remove it:

1. On the rig's page, press **Export**, choose **Full export**, press **Export** under the choice, and wait a minute or two: the rig sends that export, and its champions' patches, to control.
2. Check that every result has left the rig: see [Get a rig's results from control](exports-on-control.md#3-check-that-every-result-has-left-the-rig).

Then, in the **Set up by control** block, open "Remove it from …", type `remove rig-1`, and press **Remove the rig**. On a machine, control stops the services and deletes the rig's units, files and volumes. On a cluster, it deletes the namespace it made, or the rig's objects in its slot. Either way it retires the rig, so its token stops working.

Control refuses the remove while any result waits on the rig: the page says `rig-1 still holds results:`, what waits, and to export first. A rig whose results can't leave, such as one whose supervisor is broken, is removed with `discard rig-1` typed instead of `remove rig-1`: what it held is lost, and the audit log's `machine_rig_remove` or `cluster_rig_remove` entry says what had not left (`discarded`).

**Joined:** run the **Remove** command from the rig's page, there. Then retire it.

**The compose stack:** `docker compose down` stops it. `docker compose down -v` also deletes its volumes, with control's state and every result not pushed elsewhere.

## Retire and bring back

Retire a rig that is gone. It leaves the rig lists and **Needs you** (on **Overview**, the first page in the sidebar), and control refuses its reports. Its records stay: its runs stay on their campaigns' pages, under **Earlier runs**, marked `on <rig>, retired`, and each opens like any run. **Retiring stops nothing on the machine.**

1. On the rig's page, open the **⋯** menu. A rig control refuses, or one that is offline, also has **Retire it** in its banner.
2. Under **Retire it**, type `retire rig-1` and press **Retire it**.

The page says `rig-1 is retired.` The rig is listed under **Retired** on **Rigs**. A token control made for the rig, with **Add a rig**, a join command or `thermite rig add`, stops working.

A rig whose token is in control's rig tokens file (`THERMITE_CONTROL_RIG_TOKENS_FILE`), such as the compose stack's `local-1` and `local-2`, keeps its token: the page adds "If its token is in control's settings, take it out there too." Do so only to end the rig for good: take its line out of that file (`.dev/secrets/control-rig-tokens.json` on the local stack) and restart control. Leave it in if you may bring the rig back.

You can also retire a rig with `thermite rig retire`, `POST /v1/rigs/<rig>/retire`, or the MCP tool `retire_rig` with `confirm: "retire rig-1"`. Only the owner's token can.

To **bring it back**, open its page and press **Bring it back**, or use `POST /v1/rigs/<rig>/bring-back` or the MCP tool `bring_back_rig`. It shows again, and its reports are taken again:

- A rig with its token still in the rig tokens file reports again at once.
- **A token control made for it stays ended.** To let such a rig report again, enroll it again with `thermite rig add`, which also brings it back, and give the rig the new token. See [Make and change tokens](tokens.md).

## Fully reset a rig

A full reset gives a rig a clean start: it exports everything, checks that the export left the rig, and wipes the rig's state only after you confirm.

### Before you start

- The rig's exports leave it: to its results repository (the compose stack has one), or to control (every other rig). See [Exports](../../reference/exports.md#where-exports-go).
- No commands wait for the rig. A pending command holds the reset at its `quiescing` step. [Cancel](cancel-a-command.md) those you don't need.
- During the reset, `issue_command` and `propagate_champion` refuse an agent's token for the rig, with `rig-1 is being reset by the owner`.
- A rig launched on RunPod: its pod runs, and no stop, start, restart or terminate is under way. Otherwise the reset fails at once, for example with `rp-1a2b3c4d's pod is stopped: start it first, so its results can leave it before the wipe`. Its reset also waits until no other export or champion's patch waits on the pod, and its pod and GPU stay: the harness and the supervisor restart themselves in it.

### Steps

1. On the rig's page, open the **⋯** menu. Under **Full reset**, type `reset rig-1` and press **Start the full reset**. For a rig launched on RunPod, the **Full reset** box is under **The pod**.

   You land on **Reports**, a page in the sidebar. The **Full resets** table shows the rig and its state. Press **refresh** in the status bar, the line along the bottom of the page, to follow it.

2. Control goes through these states. Each must finish within its time limit, or the reset fails:

   | State | What happens | Limit |
   | --- | --- | --- |
   | `start` | Control pauses the rig's running runs, with the reason "full reset" | |
   | `quiescing` | Control waits until the rig reports its runs paused, the judge has no job under way and none queued for a run that still runs, and no command waits for the rig. A paused run's queued jobs stay in the queue, and the export carries them | 1 hour |
   | `exporting` | The rig takes a [full export](../../reference/exports.md#normal-and-full-exports): what is new since its last export, plus its research archive, every run's research folder and a copy of its ledger | 30 minutes |
   | `verifying` | Control waits until the supervisor reports that export pushed to the results repository, or, for a rig without one, until control holds every file of it | 1 hour |
   | `awaiting_owner` | Control waits for you | 24 hours |
   | `confirmed` | You confirmed; control sends the wipe | |
   | `wiping` | After you confirm, the rig checks the export again and wipes its state. Its harness and supervisor start again, and control restarts their containers if it has a deployment driver | 30 minutes |
   | `done` | The **Detail** says `wiped; restarted …`, or `wiped; the rig restarted itself (no deployment driver configured)` | |

3. At `awaiting_owner`, the **Detail** says `export <name> reported pushed (results repository commit <commit>); check it there, then confirm the wipe`. Check that commit in the results repository. On the compose stack:

   ```sh
   docker compose exec supervisor git -C /results/results.git log -1 --oneline refs/heads/thermite/local-1/attempts
   ```

   It prints the start of the commit and its message, `local-1: export <name>, …`. Both must match the **Detail**.

   For a rig that sends its exports to control, the **Detail** says `export <name> is on control, every file checked against its manifest; check it there (GET /v1/rigs/<rig>/exports/<name>), then confirm the wipe`. Find that export on the **Exports** page, or read its listing as in [Get a rig's results from control](exports-on-control.md#the-scripted-way): it is complete (`complete_at` is set), and its kind is `full` (`full` is `true`).

4. Press **Confirm the wipe**, on **Reports** or in the **Wipe** item of **Needs you**. To stop instead, press **Cancel** on **Reports** or **Cancel the reset** in **Needs you**. You can cancel until the wipe starts.

5. When the reset is `done`, the rig starts again with an empty ledger. Its old runs no longer show on its page or on the leaderboard. They stay on their campaigns' pages, under **Earlier runs**, marked `before <rig>'s full reset`: each opens like any run, with its attempts, its history and its champions' patches, from the events control keeps. They take no more commands. Start new campaigns on it as usual, and check **Edit rig**: the choices made there are wiped, and the rig is back to its defaults.

If the reset fails or is cancelled, nothing is wiped and the runs stay paused. The **Detail** says why, for example `the rig has no results repository, and its supervisor does not send exports to control (an older version): its export cannot be verified` or `timed out while quiescing`.

Over the REST API, with the owner's token: `POST /v1/rigs/<rig>/reset` with `{"confirm":"reset <rig>"}` starts a reset and answers `{"reset":<id>}`. `GET /v1/resets` lists them, and `POST /v1/resets/<id>/confirm` or `/cancel` confirms or cancels one. For a rig launched on RunPod, the owner's MCP tool `runpod_rig` (`reset`, `confirm_wipe`, `cancel_reset`) and `thermite runpod reset`, `confirm-wipe` and `cancel-reset` do the same. There is no MCP tool for other rigs' resets.

### What a full reset keeps

| Wiped | Kept |
| --- | --- |
| The harness's state: its ledger, git mirrors, kits, imports, models, builds, research archive and research folders with their copies of past research (`knowledge/`), the **Edit rig** settings and the model route it was handed | The rig's signing key, so control still trusts it (no key to accept) |
| Its scratch space and outbox | Everything in the results repository or on control, with the full export |
| The supervisor's state: its copy of the results, its fetch caches, its known hosts for Git access, its advisors' records, the day's spending and where each run's past research sync had got to | Control's records: the rig's past events, its commands, champion patches and daily reports. The rig's page shows only what the rig records after the reset; its earlier runs are under their campaigns' **Earlier runs** |
| | Control's [knowledge base](../../reference/knowledge-base.md): the items of the rig's earlier runs stay in their campaigns' collections |
| | Files outside the rig's state: the advisors file, its tokens, and its environment settings |

After the wipe, the rig refuses commands issued before it. Its model route comes back from control within about half a minute, or at once with the message bus.
