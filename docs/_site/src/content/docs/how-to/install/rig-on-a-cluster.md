---
title: "Add a rig on a Kubernetes cluster"
description: "Let control set a rig up on a Kubernetes cluster, in a namespace it creates or in a slot made for Thermite."
type: how-to
sidebar:
  order: 3
---

Control can set [rigs](../../reference/glossary.md) up on a Kubernetes cluster with a kubeconfig you give it once. Each rig is two pods, its harness and its supervisor, which share one volume on one node. Control applies them, waits for the rig's first report, and later stops, starts and removes it, moves it onto new images, or changes its GPUs, CPUs and memory.

Control places each rig in one of two ways:

- **A namespace control creates for each rig**, with the rig's own network rules. The kubeconfig needs rights to create namespaces.
- **Slots**: namespaces the cluster's operators made for Thermite in advance, with their own quotas and network rules. Control only deploys into a free one.

:::note[What these rigs don't have yet]
Rigs that control sets up, on a machine, on a cluster or with a join command, get only the few settings listed in [Rigs that control sets up](../../reference/settings.md#rigs-that-control-sets-up). Compared with the local stack, they have:

- **no results repository:** their exports go to control instead ([Get a rig's results from control](../operate/exports-on-control.md)), and a [full reset](../operate/rig-lifecycle.md#fully-reset-a-rig) waits until control holds the rig's full export. Champions can't be [sent between rigs](../campaigns/several-rigs.md);
- **no advisors file:** advisors come only from [Edit rig](../operate/advisors.md#on-edit-rig);
- **no model prices,** so a contract's money budget (`budget.llm_usd`) counts nothing ([token prices](../campaigns/budget-and-stop-time.md#set-the-token-prices-for-model-spend));
- **no proposer token,** so you can't [submit changes by hand](../campaigns/test-a-kit.md).

[Goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal) lists these gaps.
:::

## Before you start

- **Control is ready for rigs elsewhere:** its address (`THERMITE_CONTROL_PUBLIC_URL`), from which it takes its message bus's address for rigs unless `THERMITE_NATS_PUBLIC_URL` names one, and the rig images, plus `THERMITE_RIG_HARNESS_CUDA_IMAGE` for GPU rigs. Without an address for rigs on its bus, control sets up no rig: a rig talks to control only on the bus. See [Let rigs on other machines reach control](one-machine.md#let-rigs-on-other-machines-reach-control).
- **The cluster's pods can reach control's address and the message bus's port** (4222 on control's host, unless control names another: [Run the message bus](../operate/message-bus.md#let-rigs-on-other-machines-reach-it)), and pull the images. Control adds no image pull secret, so the nodes must be able to pull the images without one ([Push the images to your own registry](own-registry.md)).
- **A kubeconfig** with everything written inside it: a `token`, or `client-certificate-data` and `client-key-data`, and `certificate-authority-data`. Control refuses a kubeconfig that runs a command to log in (`exec` or an auth-provider), reads files, or goes through a proxy (`proxy-url`). It also refuses one that skips TLS checks (`insecure-skip-tls-verify`) or reaches its API server over plain `http://`, unless you accept that its connection isn't checked (below).
- **Rights for the kubeconfig:** for namespaces control creates, see [below](#what-created-namespaces-need); for slots, a role in each slot ([below](#what-a-slot-needs)).
- **For GPUs:** NVIDIA's device plugin (`nvidia.com/gpu`), or a device class for DRA (Kubernetes' Dynamic Resource Allocation).

### What created namespaces need

Rights across the cluster, since the namespaces don't exist yet: to create and delete namespaces, and in them to create, change and delete deployments, services, secrets, persistent volume claims and network policies (and resource claim templates for DRA). Control also scales and restarts the deployments to stop, start and restart the rig. To move the rig onto new images, or to change its GPUs, CPUs or memory, it applies the deployments again; with DRA and a new number of GPUs, it also deletes the rig's resource claim template and makes it again, since a template can't change. After a start, a restart or a change, it reads the deployments' status (`get`) until the new pods run. With rights to read nodes, storage classes and device classes, its check of the cluster shows them; without them it shows less. Control never reads pods.

Thermite's own cluster test uses the cluster's admin kubeconfig for this placement, so there is no tested narrower role to copy. If the cluster's operators won't give control rights across the cluster, use slots.

### What a slot needs

The cluster's operators make each slot. Thermite's own cluster test gives control a service account in the slot, with these roles:

```sh
kubectl create serviceaccount thermite-control -n thermite-slot-1
kubectl create role thermite-control -n thermite-slot-1 \
  --verb=get,list,watch,create,update,patch,delete \
  --resource=deployments.apps,services,persistentvolumeclaims,secrets,pods,resourceclaimtemplates.resource.k8s.io
kubectl create rolebinding thermite-control -n thermite-slot-1 \
  --role=thermite-control --serviceaccount=thermite-slot-1:thermite-control
kubectl create role thermite-control-read -n thermite-slot-1 \
  --verb=get,list --resource=networkpolicies.networking.k8s.io,resourcequotas
kubectl create rolebinding thermite-control-read -n thermite-slot-1 \
  --role=thermite-control-read --serviceaccount=thermite-slot-1:thermite-control
```

For a user rather than a service account, give `--user=<the kubeconfig's user>` to the two `rolebinding` commands. With rights to read the slot's resource quota (`resourcequotas` in the second role), control also fills in the rig's CPUs, memory and volume from it, and keeps the rig within it when it adds the rig and when it [changes its GPUs, CPUs and memory](#change-the-rigs-gpus-cpus-and-memory): its CPUs (`limits.cpu`, else `requests.cpu`), its memory (`limits.memory`, else `requests.memory`), its GPUs through the device plugin (`requests.nvidia.com/gpu`), and, with DRA, the devices of its class (`gpu.nvidia.com.deviceclass.resource.k8s.io/devices` for the class `gpu.nvidia.com`).

Control writes no network rules in a slot, but it reads them. It refuses a slot unless some network rule selects the rig's harness pods (label `app.kubernetes.io/component: harness`), and every such rule lets them reach only DNS (port 53), addresses outside the private, shared and link-local ranges ([the list](../../reference/ports-volumes-secrets.md#kubernetes)), or exactly an address of **Settings › Addresses cluster rigs may reach** on its listed TCP ports ([below](#reach-a-model-server-on-a-private-or-tailscale-address)). Thermite's cluster test uses this rule. Its egress part is the same as the rule control writes in a namespace it creates, and its ingress part lets only the rig's supervisor connect to the harness:

```yaml title="thermite-harness-net.yaml"
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: thermite-harness
  namespace: thermite-slot-1
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/component: harness
  policyTypes: [Egress, Ingress]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app.kubernetes.io/component: supervisor
      ports:
        - { port: 8700, protocol: TCP }
  egress:
    - ports:
        - { port: 53, protocol: UDP }
        - { port: 53, protocol: TCP }
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:   # the private, shared, link-local and this-network ranges
              - 10.0.0.0/8       # public-check: allow (a reserved range)
              - 172.16.0.0/12    # public-check: allow (a reserved range)
              - 192.168.0.0/16   # public-check: allow (a reserved range)
              - 100.64.0.0/10    # public-check: allow (a reserved range)
              - 169.254.0.0/16   # public-check: allow (a reserved range)
              - 0.0.0.0/8
```

Control also reads who may connect to the harness, but it takes the slot either way: the harness asks for a token on every route but its health. When no rule limits the harness's ingress, or a rule lets in pods other than the rig's supervisor (a rule with no `from`, another pod selector, a namespace selector or an address range), the rig's **Set up by control** block warns `Other pods can connect to this rig's harness.`, says which rule in words, such as `no network rule in the slot limits who may connect to the harness, so every pod in the cluster can reach its port 8700`, and shows the NetworkPolicy that lets only the rig's supervisor in, `thermite-<rig>-harness-in`, for the operators to apply. Rules add up, so the rule the warning names must go or be narrowed too. **Check again** on the cluster in **Settings** reads the slot again, and the warning goes once only the supervisor may connect. A supervisor's rule counts when it selects pods by `app.kubernetes.io/component: supervisor` in the slot itself.

If the slot has other rules, such as one that denies all traffic, they must still let the supervisor pod (label `app.kubernetes.io/component: supervisor`) reach control's address, the internet, the harness on port 8700, and any [MCP server](../campaigns/give-agents-mcp-tools.md) its runs' kits give the advisors. The harness pod calls the MCP servers of the workers and the planner, so it too must reach them, outside these ranges.

A helper that writes a slot's objects out for the operators is planned ([goal 033](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/033-slot-helper.goal)).

## 1. Add the cluster

1. Press the cog at the foot of the sidebar to open **Settings › Providers**.
2. Under **Add a provider**, fill in:
   - **Type:** A Kubernetes cluster
   - **Name:** the name Thermite shows for it, such as `cluster-1`
   - **Kubeconfig:** paste it
   - **Context:** which context to use. Empty: its current context
   - **Placement:** **A namespace control creates for each rig**, or **Slots the cluster's operators made**
   - **Namespace for each rig** (created namespaces): `thermite-{rig}` by default. `{rig}` becomes the rig's name
   - **Slots** (slots): the slot namespaces, separated by commas, such as `thermite-slot-1, thermite-slot-2`
   - **Unchecked connection:** leave **I accept that this cluster's connection isn't checked** clear, unless the kubeconfig skips TLS checks or uses plain `http://` and you accept that control can't tell the real API server from another one on the way, which would see every rig's tokens and the secrets control applies there
3. Press **Add and check the cluster**.

Control reads the cluster and changes nothing. The page says `"cluster-1" is added and checked: see what control found below.` The cluster's row shows:

- **Version** and **Nodes**, with each node's GPUs;
- **GPUs**: NVIDIA's device plugin, DRA device classes, or neither;
- **Storage**: the storage classes, with the default one marked;
- **Placement**: "control may create namespaces", or each slot with "free", "used by rig …", "refused: …" or "control may not deploy here".

A refused kubeconfig gives "Not added: …" with the reason. One that skips TLS checks or uses plain http, without the tick, gives `Not added: cluster "<name>" skips TLS checks (insecure-skip-tls-verify), so control can't tell the real API server from another on the way. …` (or `… reaches its API server over plain http, …`), and control keeps nothing of it. With the tick, control adds it, the page adds `You accepted that its connection isn't checked: …`, the cluster's row shows the chip `connection not checked: you accepted it … ago`, and the audit log's `cluster_added` has `unchecked_accepted`, with what is unchecked. To make it checked, delete the cluster and add it again with a kubeconfig that has its `certificate-authority-data` over https.

To change the slots later, edit **Slots** on the cluster's row and press **Save the slots**. Control reads each one again.

## 2. Add the rig

1. Open **Rigs** in the sidebar, then press **Add a rig**.
2. Under **1 · Where**, choose **cluster-1 · Kubernetes**. A cluster that is not ready says why, for example "control may not create namespaces there" or "it has no free slot".
3. Under **2 · GPUs and resources**:
   - **GPUs**: how many the harness pod asks for. **none: the CPU**, one shared by the judge and the agents, or several. With several, **GPUs for the judge** sets the judge's share (half by default). See [Give a rig several GPUs](several-gpus.md).
   - **GPUs through**: **NVIDIA's device plugin**, or **DRA:** and a device class. Where control can't read the cluster's nodes, as is common in a slot, choose **DRA: a device class you name** and name it in **DRA device class**, such as `gpu.nvidia.com`.
   - **Node**: **any node with room**, or one node. A fixed node keeps timings comparable between runs.
   - **Storage class** and **Volume size (GB)**: the rig's one volume, 100 GB by default. It holds the rig's state, builds, inbox and outbox.
   - **CPUs** and **Memory (GiB)**: both or neither. At least 1.5 CPUs and 6 GiB; the supervisor takes half a CPU and 2 GiB of that, the harness the rest. Empty: the namespace's defaults apply.
   - **Slot** (slots): one of the free slots. For created namespaces, **Namespace** shows the pattern control names it by, such as `thermite-{rig}`.
4. Under **3 · Name and start**, give a **Rig name**: 2 to 40 lowercase letters, digits and dashes, starting and ending with a letter or digit. It can't change later.
5. Press **Create the rig**.

In a slot whose network rules don't keep the harness off the cluster, control refuses with "Refused: in the slot thermite-slot-1, …" and says why. Ask the cluster's operators for a rule like the [example above](#what-a-slot-needs).

## 3. Watch it start

You land on the rig's page: "Control is setting rig-1 up on cluster-1. Its page fills in once the rig reports for the first time." Its **Set up by control** block lists each step, and shows each one as it comes, with no refresh:

- ✓ Enrolled with control: a token of its own
- ✓ Its objects applied in the cluster: namespace, secret, volume, deployments
- ✓ Its key on the message bus registered
- ✓ First report reached control

Control waits up to 10 minutes for the first report, and the nodes pull the images in that time. The report comes over the message bus: pods that can't reach the bus's port never report, and 5 minutes after the rig registered its keys, its page shows it **Broken** ([A rig off the bus](../operate/message-bus.md#a-rig-off-the-bus)). If a large image takes longer, the step shows ✕ "no report after 10 minutes: it may not have started", and the block's status says `failed`. When the rig reports later, its page still fills in, the status says `running` again, and a ✓ step follows the ✕: "First report reached control · it reported after the wait ended".

What control applies, all labelled `app.kubernetes.io/instance: rig-1`:

| Object | Name |
| --- | --- |
| Namespace (created namespaces only) | `thermite-rig-1` |
| Secret: the rig's tokens and control's public key | `thermite-rig-1` |
| Persistent volume claim | `thermite-rig-1-data` |
| Service for the harness | `thermite-rig-1-harness` |
| Resource claim template (DRA only) | `thermite-rig-1-gpus` |
| Deployments | `thermite-rig-1-harness` and `thermite-rig-1-supervisor` |
| Network rules (created namespaces only) | `thermite-rig-1-harness-net` and `thermite-rig-1-supervisor-net` |

Both deployments' pods run without a service-account token, without the namespace's services as variables (`enableServiceLinks: false`), and under the container runtime's default seccomp profile (`RuntimeDefault`).

In a namespace it creates, control's network rules let the harness reach only DNS, addresses outside the private, shared and link-local ranges, and each address in **Settings › Addresses cluster rigs may reach** on its listed TCP ports, and let only its supervisor reach the harness. At every start, the harness's isolation check tries to reach the cluster's API server from a lane. Where the cluster's network plugin doesn't enforce network rules, or a slot's rules let the harness reach the cluster, the check fails with `the cluster does not hold the rig's network rules: lane-1 reached the cluster's API server (…)`, and the rig's page shows it ([The isolation check](../../reference/rig-checks.md#isolation-check)). The supervisor's deployment carries the message bus's address (`THERMITE_NATS_URL`, from control's `THERMITE_NATS_PUBLIC_URL`) and the certificate of control's authority for the bus (`THERMITE_NATS_CA`), which is no secret, in its environment: each update and each change of size applies the deployments again with the ones control has then, so a rig set up before the bus, which is broken until then, gets them at its next update. Control refuses the update while it has no address for rigs on its bus. Control's rules limit only what reaches the supervisor, never where it goes; the cluster's network, and in a slot the operators' rules, must let it reach the bus's port.

Each deployment checks its part's health: startup, readiness and liveness probes on the part's `/v1/health`, which answers 503 while one of its loops is late. The startup probe gives the harness 10 minutes to start (its isolation check runs before it listens) and the supervisor 5; then the kubelet looks every 30 seconds and restarts a part that fails three times running. The harness is asked on its port, 8700; the supervisor inside its container, with `node -e`, since it takes no connection. Each pod has 30 seconds to stop (`terminationGracePeriodSeconds`): the harness ends its trials as interrupted and waits at most 5 seconds for the judge's job, whose lease is taken back at its next start. See [A part that is unhealthy](../operate/troubleshoot.md#a-part-that-is-unhealthy).

### If it doesn't report

Look at the rig's pods, with the rig's namespace (in a slot, the slot's):

```sh
kubectl get pods -n thermite-rig-1 -l app.kubernetes.io/instance=rig-1
kubectl describe pods -n thermite-rig-1 -l app.kubernetes.io/instance=rig-1
kubectl logs -n thermite-rig-1 deployment/thermite-rig-1-supervisor
```

| The pods show | Why | Do |
| --- | --- | --- |
| `Pending` | No node has room for the GPUs, CPUs or memory, or the volume claim is not bound. The events at the end of `describe` say which | Free room, or ask the operators. If the rig needs other choices, see below |
| `ErrImagePull` or `ImagePullBackOff` | The nodes can't pull an image | Make the image pullable without signing in: [Push the images to your own registry](own-registry.md) |
| `Running`, and still no report | The supervisor's log says why. `following failed; trying again` with a refused or timed-out connection: the pods don't reach the message bus's port | [A rig is quiet](../operate/troubleshoot.md#a-rig-is-quiet); open the bus's port to the cluster: [Run the message bus](../operate/message-bus.md#let-rigs-on-other-machines-reach-it) |

Once the cause is fixed, the pods start and the rig reports by itself, and its status goes back to `running`. If the rig needs another storage class or node, remove it (below) and add a new one under a new name: a removed rig's name can't be used again. New images need no new rig, and neither do another number of GPUs, other CPUs or other memory: see [Update the rig's images](#update-the-rigs-images) and [Change the rig's GPUs, CPUs and memory](#change-the-rigs-gpus-cpus-and-memory).

## Afterwards

The rig's page keeps the **Set up by control** block: the cluster, the namespace ("made by control" or "a slot"), the GPUs, the CPUs and memory (`16 CPUs, 52 GiB`, or "the namespace's defaults", with a link to change them on **Edit rig**), the storage, what its harness reaches beside DNS and the internet ([below](#reach-a-model-server-on-a-private-or-tailscale-address)), the images and each step so far. Its heading shows the rig's status there, such as `running`, `stopped`, `starting`, `draining`, `updating` or `failed`. Its buttons:

- **Stop its pods** or **Start its pods** (the deployments scale to 0 or 1), and **Restart them**. After a start or a restart, the page says `Started.` or `Restarted.`, and the status says `starting`. As after an update, control waits up to 15 minutes for the pods and then up to 10 minutes for a report. The steps "Its pods run again" and "A report reached control after the start" get a ✓, and the status says `running`. If a wait runs out, its step gets ✕ and the status says `failed`.
- **Update to these images**, when control deploys other images than the rig runs; **Try the update again**, when the last change to its pods failed; **Give it control's new address**, when only control's address changed. See [Update the rig's images](#update-the-rigs-images).
- **Change now, without waiting** and **Call the change off**, while the rig drains before a new number of GPUs, CPUs or memory. See [Change the rig's GPUs, CPUs and memory](#change-the-rigs-gpus-cpus-and-memory).
- **Remove it from cluster-1**: type `remove rig-1` and press **Remove the rig**. Control deletes the namespace it created, or the rig's objects in the slot, and retires the rig's token. Control removes it only once every result has left it, so [export](../operate/exports-on-control.md) first; until then it refuses with `rig-1 still holds results:` and what waits on the rig. If its results can't leave, such as when its supervisor is broken, type `discard rig-1` instead: what the rig held goes with its volume, and the audit log records it. Control keeps the rig's exports, its events, its champions' patches and what its runs added to Thermite's [knowledge base](../../explanation/journals-and-knowledge.md). The page says `Removed from the cluster.`, and the rig stays in **Rigs**, **Stale** and then **Offline**. To take it off the rig lists too, use **Retire it** at the top of its page: type `retire rig-1` and press **Retire it**.

Control makes one change at a time. While the status says `starting` or `updating`, it refuses a start, a restart or an update, and the page shows a card that starts with **Not done.**, such as `rig-1 is starting: wait until its page shows it running, or failed.` It refuses an update before it compares any images, even for a rig that already runs control's images. **Stop its pods** and **Remove the rig** are never refused for this, and they end control's wait: a rig you stopped or removed meanwhile doesn't turn `failed` later.

Next, [check the rig](../operate/check-a-rig.md), then [give it a model](../models/connect-a-provider.md).

## Reach a model server on a private or Tailscale address

The rig's harness calls its model and reaches its measurement target from the harness pod, which reaches no address in the private, shared or link-local ranges. A model server or a target on such an address, such as a server on your own network or a Tailscale address (in RFC 6598's shared range), must be in control's list of addresses cluster rigs may reach. Each address in it opens one host to every cluster rig's harness, on its TCP ports only. Code that a lane runs reaches it too, so list only what the rigs need.

1. Open **Settings**, and go to **Addresses cluster rigs may reach**.
2. Fill in the form:
   - **Address**: one IPv4 or IPv6 address, such as `fd7a:115c:a1e0::7`. A range, a name or an address outside the private, shared and link-local ranges is refused: the harness reaches those already.
   - **TCP ports**: the ports the harness reaches it on, such as `8000`, separated by commas or spaces; at most 16.
   - **What it is**: a note, such as `the model server`.
3. Press **Save the address**. The block says `The list holds 1 address. Control applies it to the network rules of rig-1 now.`, and the address shows in the list with its ports, its note and who set it when. An address already in the list takes the new ports and note in place of its own; **Remove** takes it out.

Where each rig takes the list:

- **In a namespace control created**, control applies the rig's two network rules again at once, with one more egress rule for each address: to it alone (`/32`, or `/128` for IPv6) on its ports. The pods don't restart. The rig's history gets the step "Its network rules applied with the list of addresses rigs may reach", and the **Set up by control** block says what its harness reaches. A rig added later gets the list as it is then.
- **A rig you joined** got the list as it was when its join command ran. To change it, the namespace's operator adds a NetworkPolicy beside control's, such as the one below.
- **In a slot**, the operators write the rules. Control's check of the slot accepts a rule that opens exactly a listed address on some of its listed TCP ports, and refuses one that opens it on every port, on another port, over UDP or as a range of ports, or opens a wider block. **Add a rig** says why, such as `the rule "thermite-rig-1-model" opens 100.64.0.7 on more than its listed TCP ports (8000)`. The rig's page lists each address its slot's rules opened when control added it, with the rule's name. <!-- public-check: allow (an example in a reserved range) -->

A rule that opens one address on one port, for a slot's operators or a joined namespace, for a model server on port 8000:

```yaml title="thermite-rig-1-model.yaml"
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: thermite-rig-1-model
  namespace: thermite-rig-1
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/instance: rig-1
      app.kubernetes.io/component: harness
  policyTypes: [Egress]
  egress:
    - to:
        - ipBlock: { cidr: 100.64.0.7/32 }   # the server's address (public-check: allow)
      ports:
        - { port: 8000, protocol: TCP }
```

Network rules add up, so control's own rule stays as it is. Over REST the owner reads and sets the whole list with [`GET` and `PUT /v1/reachable-addresses`](../../reference/rest-api.md#addresses-cluster-rigs-may-reach); over MCP, [`reachable_addresses`](../../reference/mcp-tools.md#reachable_addresses) reads it with the owner's or the operator's token, and [`set_reachable_addresses`](../../reference/mcp-tools.md#set_reachable_addresses) sets it with the owner's.

## Update the rig's images

After you update Thermite, push the new images and restart control with them ([Push the images to your own registry](own-registry.md)). The rig keeps running its old images until you move it: its **Set up by control** block then says "Control now deploys other images:" and offers **Update to these images**. A rig at work drains first: it starts nothing new, and its pods restart once its running trials and the judge's job under way end; **Update now, without waiting** skips the wait, and **Call the update off** ends the drain. The drain waits 60 minutes at most, by default: then it asks you under **Needs you** to update it now or to end the drain ([At its deadline](../../reference/rig-page.md#at-its-deadline)). Control then applies the rig's two deployments again with the new images, waits for the new pods and a report from them, and lists each step in the block. The rig's volume, tokens, runs and results stay, and so does each lane's build cache.

- **Control's address for rigs must be set** (`THERMITE_CONTROL_PUBLIC_URL`). The update writes it into the rig's supervisor again, so a changed address reaches the rig too. Without it, control refuses: `Control's address for rigs is not set (THERMITE_CONTROL_PUBLIC_URL): the rig would no longer know where to report.`
- **One change at a time:** wait until the status says `running` or `failed` before you update again.
- **A failed change can be tried again:** while the status says `failed`, the block says "The last change to its pods failed (see the steps above)." and offers **Try the update again**, which applies control's images again and waits once more.
- **When only control's address changed,** the block says "Control's address for rigs changed: …" and offers **Give it control's new address**. A rig set up by an older version of control shows this button only after its next update; until then, use `update_rig_images` over MCP ([below](#from-an-agent-or-a-script)).

For the steps, what changes and what to check afterwards, see [Move a rig onto new images](../operate/rig-lifecycle.md#a-rig-on-a-cluster), [Try again after a failure](../operate/rig-lifecycle.md#try-again-after-a-failure) and [When only control's address changed](../operate/rig-lifecycle.md#when-only-controls-address-changed).

## Change the rig's GPUs, CPUs and memory

When the rig's place gains room, such as a fourth GPU and a larger quota in its slot, the rig can take it as it is: its volume, tokens, runs and results stay. Control applies the rig's two deployments again with the new size, on the images the rig runs, as an image update does.

Before you start:

- **The place allows the new size.** In a slot, control reads the slot's quota again when you save, if its role may read it ([What a slot needs](#what-a-slot-needs)), and refuses a size above it. Through the device plugin, a node must offer that many GPUs, as control last read the nodes. Where control can read neither, the cluster's own rules decide: the pods then wait as `Pending` (see [If it doesn't report](#if-it-doesnt-report)).
- **The rig keeps its kind.** A rig on GPUs keeps at least one, and a rig on the CPU takes none: its harness image and its target would change, and its runs' timings would no longer compare. Add a new rig for that.
- **Control's address for rigs is set** (`THERMITE_CONTROL_PUBLIC_URL`), as for an image update.
- **The rig is not starting, being updated or draining for an image update.**

Steps:

1. On the rig's page, press **Edit rig**. Under **4 · Where it runs**, a rig control set up on a cluster has these fields, each with an "i" that says what it means:
   - **GPUs** (a rig on GPUs only): how many GPUs the harness pod asks for, 1 to 16, through the rig's own way: NVIDIA's device plugin or its DRA device class.
   - **CPUs** and **Memory (GiB)**: both, with at least 1.5 CPUs and 6 GiB, or both empty for the namespace's defaults. The supervisor takes half a CPU and 2 GiB, and the harness the rest.

   Under them, a line says what the place allows, as control last read it, such as `The slot's quota allows 16 CPUs, 52 GiB of memory and 4 GPUs, as control last read it. Save reads it again first.`
2. Change the values. With a new number of GPUs, **GPUs for the judge** (on a rig with two or more GPUs) is the judge's share of the new ones. The box **What changes when you save** lists each change, the new split, such as `The judge gets 2 of the 4 GPUs, the agents 2.`, and that the rig's pods restart.
3. Press **Save changes**. The rig's page says, for example, `rig-1's pods restart with 4 GPUs (2 for the judge, 2 for the agents), 16 CPUs and 52 GiB of memory.` The block's status says `updating`, and a new step reads "Its deployments applied with new GPUs, CPUs or memory", with what changed: `GPUs 3 → 4 (2 for the judge, 2 for the agents); CPUs and memory: namespace defaults → 16 CPUs, 52 GiB`.
4. Wait on the page: the block shows each step as it comes. Control waits up to 15 minutes for the new pods, then up to 10 minutes for a report from them. The steps "Its pods run with the new GPUs, CPUs or memory" and "A report reached control after the change" get a ✓, and the status says `running`.

A rig at work drains first, as for new images: the page says `rig-1 drains first: it starts nothing new, and its pods restart with 4 GPUs (2 for the judge, 2 for the agents), 16 CPUs and 52 GiB of memory once 1 trial finishes. …`, the status says `draining`, and the block says "Draining before its pods restart with …" and what it waits for. **Change now, without waiting** restarts its pods at once; **Call the change off** ends the drain, and the rig goes back to work as it was. Control makes the change once the rig reports that nothing runs. While the rig drains for a new size, an image update is refused, and the other way round.

What changes and what stays:

| Changes | Stays |
| --- | --- |
| The GPUs, CPUs and memory of the rig's pods, and the split of its GPUs | Its secret, so its tokens and control's public key |
| With DRA and a new number of GPUs, its resource claim template: deleted, then made again with the new number | Its volume, so its ledger, runs, results and signing key |
| The supervisor's address for control, written again from `THERMITE_CONTROL_PUBLIC_URL` | Its images, its service, its network rules, its node and its storage |

- **The judge's share.** With a new number of GPUs and no share given, the judge gets half of them, rounded up, as when a rig is added. A share the rig kept from **GPUs for the judge** would come first in its harness, so control also sends the rig the new share ([`rig_settings`](../../reference/signed-commands.md#rig_settings)), and the step ends with, for example, `the judge's share it kept, 1, → 2`. With the same number of GPUs, the split stays as it is: change it with **GPUs for the judge** alone, which restarts only the harness ([Give a rig several GPUs](several-gpus.md#change-the-split-later)).
- **A stopped rig stays stopped.** The page says `rig-1 has 4 GPUs (2 for the judge, 2 for the agents), 16 CPUs and 52 GiB of memory when it starts again.`, the step ends with "at its next start", and **Start its pods** starts it with the new size.
- **A refusal changes nothing.** The page shows a card that starts with **Not done.**, such as `Not saved: The slot thermite-slot-1 allows 4 GPUs.`, `Not saved: The slot thermite-slot-1 allows 16 CPUs.`, `Not saved: a rig needs at least 1.5 CPUs and 6 GiB of memory`, `Not saved: No node of cluster-1 offers 9 GPUs through the device plugin.`, `Not saved: rig-1 measures on GPUs, and can't move to none: …` or `Not saved: rig-1 is being updated: wait until its page shows it running, or failed.`
- **The same values change nothing:** the page says `Nothing changed.`

After a new number of GPUs, run the rig's **Isolation** and **Judge smoke** checks ([Check a rig](../operate/check-a-rig.md)).

## From an agent or a script

Over MCP, the owner's and the operator's tokens have five tools for clusters (see [MCP tools](../../reference/mcp-tools.md)):

- `add_cluster_rig` adds a rig on a cluster in Providers, with the same checks as **Add a rig**. Its fields are `rig`, `cluster`, `slot`, `gpus`, `judge_gpus`, `gpu_mode` (`device-plugin` or `dra:<device class>`), `node`, `storage_class`, `storage_gb`, `cpus` and `memory_gib`. It answers with the rig's name and `"status": "deploying"`; follow the rig with `rig_setup` and `list_rigs`.
- `set_cluster_slots` replaces the list of slots of a cluster that uses slots. A slot that holds a rig must stay in the list.
- `cluster_rig` stops, starts or restarts a rig, as the buttons on its page do. Its fields are `rig` and `action`: `stop`, `start` or `restart`. Its answer's `said` is `Stopped.`, `Started.` or `Restarted.` After a start or a restart, follow the rig with `rig_setup`: it says `starting`, then `running` once the pods run and the rig reports, or `failed`. Removing a rig is done on the dashboard.
- `update_rig_images` moves a rig onto control's images, as **Update to these images**, **Try the update again** and **Give it control's new address** do. Its fields are `rig` and `wait`: by default it drains a rig at work first; `"wait": false` restarts its pods now, also during a drain. Its answer's `said` is one of:
  - `rig-1 drains first: it starts nothing new, and its pods restart on the new images once 2 trials and the judge's job finish. …`;
  - `rig-1 is draining: …`, while a drain is under way;
  - `rig-1's pods restart on the new images.`;
  - `rig-1 runs the new images when it starts again.` (a stopped rig);
  - `rig-1's pods restart with control's new address.`, when only control's address for rigs changed;
  - `rig-1 gets control's new address when it starts again.` (a stopped rig);
  - `rig-1's pods restart on control's images again (a retry).`, when it tries a failed change again on the same images;
  - `rig-1 already runs control's images.`: the images and control's address are the same as the rig's.

  An update while the rig is `updating` or `starting` is refused, and so is one without control's address for rigs, with the same reasons as on the page. When control can't read the rig's supervisor deployment to compare the address, the tool answers with an error: `Control could not read rig-1's deployment to compare control's address:` and kubectl's error, or `kubectl's answer is not a deployment` when kubectl printed something else.
- `set_cluster_rig_resources` changes a rig's GPUs, CPUs and memory, as **Edit rig** does ([above](#change-the-rigs-gpus-cpus-and-memory)). Its fields are `rig`, `gpus`, `judge_gpus`, `cpus`, `memory_gib` and `wait`; give only what changes, and `null` for both `cpus` and `memory_gib` for the namespace's defaults. For example `{"rig": "rig-1", "gpus": 4, "cpus": 16, "memory_gib": 52}` answers `rig-1's pods restart with 4 GPUs (2 for the judge, 2 for the agents), 16 CPUs and 52 GiB of memory.` It drains a rig at work first, as `update_rig_images` does; `"wait": false` restarts its pods now. An operator's token may change the GPUs, CPUs and memory; `judge_gpus` is the owner's alone, and a call with it from another token is refused, with nothing changed: `Only the owner's token changes a rig's GPU split: leave out judge_gpus. …`

`rig_setup` (field `rig`) shows a rig that control set up: the cluster, the namespace, the placement, the rig's status there, its images, its `gpus`, `judge_gpus`, `cpus` and `memory_gib` (`null` for the namespace's defaults), the change it drains for in `pending` (`null` when none), and each step, oldest first. A step is `{at, step, ok, detail}`, with the step's id rather than the page's words, such as `applied`, `first_report`, `drain` (while an update or a change of size waits for the rig's work), `images`, `images_running` and `report_after_images` for an update, `resources`, `resources_running` and `report_after_resources` for a change of GPUs, CPUs or memory, or `pods_running` and `report_after_start` for a start or a restart. A failed step has `"ok": false` and the reason in `detail`. Use it to follow a new rig, a start or an update. It is for those who run control: the agent token doesn't have it, and a reader's token gets each step with `detail` set to `null`.

Once the rig shows on **Rigs**, `set_rig_model` gives its agents a model from **Providers**, and `set_rig_settings` sets the rest of **Edit rig** (with the owner's token, also its promotion rule and GPU split), as the page does. Adding the cluster itself is done on the dashboard.
