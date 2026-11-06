---
title: "Test a GPU on RunPod"
description: "Start a short test pod on RunPod from control, and read what it found and what it cost."
type: how-to
sidebar:
  order: 9
---

:::caution[This spends money]
A test pod is a real RunPod pod. RunPod bills it by the second from the moment it starts, until control removes it. Control removes it when the test is done, but sets no time limit of its own: set **End it after (minutes)** before you start one, so the pod ends even if something goes wrong.
:::

A test pod tells you whether a [rig](../../reference/glossary.md) could run on RunPod: whether Thermite's harness gets root and the capabilities it needs there, whether the agents can be kept off the judge's GPU, and whether Thermite's isolation self-test passes. Control starts one pod of the CUDA harness image, or of the one-container rig image that a [rig on RunPod](runpod-rig.md) starts from, reads its report, and removes it.

A test pod is no rig: it runs no campaign. To run one there, see [Run a rig on RunPod](runpod-rig.md).

## Before you start

- **A RunPod API key** from RunPod's console (Settings, API Keys) that may write. A read-only key reads the account, but starting a pod fails with "RunPod refused the key for this: a read-only key can't start or stop pods".
- **Thermite's CUDA harness image, or the one-container rig image, in a registry RunPod can pull from without a login.** Each release publishes both on `ghcr.io`, such as `ghcr.io/iammrduncan/thermite-harness:0.1.0-cuda` ([Published images](../../reference/harness-image.md#published-images)). Control passes RunPod no registry credentials. To build your own, see [Push the images to your own registry](own-registry.md). RunPod places the pod only on hosts whose driver runs CUDA 12.6 or later.
- Optional: `THERMITE_RUNPOD_TEST_IMAGE` on control, which fills in the image for you. A release's `compose.yaml` sets it to the release's rig image, so the form is filled in; set it in `.env` for another image.
- Control needs no public address for a test, only a way to the internet: it reads the pod's report itself, through RunPod's HTTP proxy. The local compose stack is enough.

## 1. Add the RunPod account

1. Press the cog at the foot of the sidebar to open **Settings**, then **Machines** under **Rigs**, and press **Add a machine**.
2. Choose **A GPU cloud**, a **Name** such as `runpod`, and paste the **RunPod API key**.
3. Press **Add and read the account**.

Control reads RunPod's GPU types with their prices and stock, its data centers, your network volumes, your pods, and what your account spent, from RunPod's billing. It starts nothing and spends nothing. The page says `"runpod" is added and read: see what control found below.` A key RunPod refuses is not kept: "Not added: …". Control reads the account again every 15 minutes, and when you press **Read again** on its row.

## 2. Start a test pod

Open the account's row. Under **Test pods**, fill in:

| Field | What to choose |
| --- | --- |
| **GPU** | The cheapest in stock is enough: the test checks the platform, not speed |
| **Cloud** | **Secure** runs in RunPod's own data centers. **Community** is cheaper and less predictable. Rigs whose judge times code belong on Secure |
| **Image** | Thermite's CUDA harness image. Or the one-container rig image, to test the image a [rig on RunPod](runpod-rig.md) starts from: its isolation self-test then also checks the supervisor's places |
| **Disk (GB)** | 40 by default. The image needs about 15 GB |
| **End it after (minutes)** | Set it, for example `30`. Control removes the pod after that many minutes, whatever it is doing. The least is 5 |
| **Stop and start it again** | On by default: after the first report, control stops the pod and starts it again, to see that it gets its GPU back |

Press **Start a test pod**. The page says `Test t-1a2b3c4d started: a … pod at $…/h. Its report shows below when it comes.` Only one test runs at a time on an account, and the form is hidden while it runs.

### From the REST API or MCP

With the owner's token, start one over the REST API. The examples use the owner's token file of the local stack, `.dev/secrets/control-admin-token`. If you made an owner's token of your own, use its file instead.

```sh
curl -s -X POST http://127.0.0.1:8800/v1/gpu-clouds/runpod/tests \
  -H "authorization: Bearer $(cat .dev/secrets/control-admin-token)" \
  -H 'content-type: application/json' \
  -d '{"stop_after_minutes": 30}'
```

The body's fields are all optional: `gpu`, `cloud_type` (`"SECURE"` or `"COMMUNITY"`), `image`, `disk_gb`, `restart` and `stop_after_minutes`. The answer is the test, with its `id`. A refusal comes back as status 409 with the reason. `GET /v1/gpu-cloud-tests/<id>` follows a test, `POST /v1/gpu-cloud-tests/<id>/end` ends it, and `GET /v1/gpu-clouds/<name>/tests` lists them.

Over MCP, the owner's and the operator's tokens have `runpod_test_start` (with `cloud`, the account's name in **Settings › Machines**, such as `runpod`, and the same fields), `runpod_tests` to follow, and `runpod_test_end`. A reader's token can follow with `runpod_tests`. See [MCP tools](../../reference/mcp-tools.md).

## 3. Watch it

The test's card shows the GPU, the cloud and the price per hour, with **running**, **passed**, **failed** or **ended**. Its line says where the test is, the cost so far, when it started, the data center and the pod's id. Press **refresh** in the status bar (the line along the bottom of the page) to follow it through these steps:

1. starting the pod
2. the pod runs: waiting for its report
3. stopping the pod, to see that it gets its GPU back when started again
4. starting the pod again
5. waiting for its report after the restart
6. removing the pod
7. done: the pod is removed

Without **Stop and start it again**, steps 3 to 5 are left out.

## What it found

The card lists the findings in words. A good test reads like this:

- Runs as root.
- Has every capability the broker needs (chown, dac_override, fowner, kill, setgid, setuid).
- GPU: its name, driver, memory and id, as `nvidia-smi` gives them.
- The GPU device nodes can be given to a group, mode 0660.
- Landlock ABI *n*: a fenced role's open of a card was refused.
- /tmp and /dev/shm can be set to 1770.
- RunPod sets *n* variables: *their names*. With the [one-container rig image](runpod-rig.md) instead: RunPod's variables reach no process: the image's entry point took them out.
- A role's user reads none of RunPod's variables.
- Outbound HTTPS reached all 6 addresses tried.
- The isolation self-test passed.
- The pod ran *n* s after it was asked for, and reported *n* s later.
- After a stop and a start it ran again with 1 GPU(s) and reported again.

**The whole report (JSON)** has everything the pod reported.

| Outcome | Meaning |
| --- | --- |
| **passed** | The isolation self-test passed, no finding shows a problem, and with **Stop and start it again** on, the pod reported again after its restart |
| **failed** | The pod reported, but the isolation self-test failed or a finding shows a problem (missing capabilities, no Landlock, a role that reads RunPod's variables), or it did not report again after the restart |
| **ended** | The test stopped on an error, shown in red, or before the pod's first report |
| **running** | The pod is still there |

## How it ends, and what it costs

- Control removes the pod at the end of every path: after the last report, on an error, at your limit, or when you press **End it now: remove the pod**. The page then says `Test t-1a2b3c4d ended: the pod is removed.`
- If removing it fails, the card says "control could not remove pod …: …. It tries again.", and control keeps trying.
- Without a limit, a pod that never reports keeps running, and keeps costing, until you end it.
- The card's cost is control's count: RunPod's price per hour times the time the pod ran. RunPod's own bill is the final word; RunPod bills a pod while it runs, and storage while it exists.
- The account's row shows that bill too. **Spend** gives what the account spent today, this month and in the last 30 days, what its running pods cost per hour, and the last 7 days one by one, all from RunPod's billing. **Thermite's test pods** adds up the cards' costs. It leaves out the rigs control launched on RunPod: each one's page has its own **Spent so far** ([goal 095](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/095-runpod-spend-on-providers.goal) adds them to this row). The month's total is also on the account's line in the **Settings › Machines** list, such as `$12.40 spent this month`. If the key may not read billing, **Spend** says `RunPod refused this key for billing: give the key read access to billing to see spend`, and the rest of the row still shows.

To be sure nothing is left, press **Read again** on the account's row: **Pods** should no longer list `thermite-test-t-1a2b3c4d`.

You can't delete the account from **Settings › Machines** while a test runs: "A test pod is running there: end it first, so its pod is removed."
