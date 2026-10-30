---
title: "Join a rig yourself"
description: "Add a rig where control cannot connect, with a one-time join command you run there."
type: how-to
sidebar:
  order: 4
---

Some places control can't connect to: a machine behind NAT, or a Kubernetes namespace whose operators give Thermite no kubeconfig. For those, control gives you one **join command**. You run it where the [rig](../../reference/glossary.md) goes; it fetches the rig's files from control and starts the rig, which then reports to control like any other.

Control holds no credential for the place, and can't reach it afterwards. Stopping, restarting and removing the rig are commands you run there yourself; the rig's page shows them. Control can't move a joined rig onto newer images yet ([goal 035](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/035-rig-upgrades.goal)).

:::note[What these rigs don't have yet]
Rigs that control sets up, on a machine, on a cluster or with a join command, get only the few settings listed in [Rigs that control sets up](../../reference/settings.md#rigs-that-control-sets-up). Compared with the local stack, they have:

- **no results repository:** their exports go to control instead ([Get a rig's results from control](../operate/exports-on-control.md)), and a [full reset](../operate/rig-lifecycle.md#fully-reset-a-rig) waits until control holds the rig's full export. Champions can't be [sent between rigs](../campaigns/several-rigs.md);
- **no advisors file:** advisors come only from [Edit rig](../operate/advisors.md#on-edit-rig);
- **no model prices,** so a contract's money budget (`budget.llm_usd`) counts nothing ([token prices](../campaigns/budget-and-stop-time.md#set-the-token-prices-for-model-spend));
- **no proposer token,** so you can't [submit changes by hand](../campaigns/test-a-kit.md).

[Goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal) lists these gaps.
:::

## Before you start

- **Control is ready for rigs elsewhere:** its address (`THERMITE_CONTROL_PUBLIC_URL`) and the rig images, plus `THERMITE_RIG_HARNESS_CUDA_IMAGE` for GPU rigs, and the message bus's port open to the rig. See [Let rigs on other machines reach control](one-machine.md#let-rigs-on-other-machines-reach-control).
- **On a machine:**
  - Linux with systemd, Podman 4.4 or later, and `curl`;
  - a user for the rig, with lingering on (`sudo loginctl enable-linger $USER`), so the rig outlives your login. Root works too, but a user with rootless Podman is safer;
  - for GPUs, NVIDIA's container toolkit with a CDI spec, the Container Device Interface file that tells Podman which GPUs there are (`sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml`);
  - network access to control's address, to the message bus's port (4222 on control's host, unless control names another: [Run the message bus](../operate/message-bus.md#let-rigs-on-other-machines-reach-it)) and to the image registry, which must let the machine pull without signing in ([Push the images to your own registry](own-registry.md)).
- **In a namespace:**
  - the namespace exists, and you have rights there to create deployments, services, secrets, persistent volume claims and network policies, and resource claim templates for DRA (Kubernetes' Dynamic Resource Allocation);
  - its pods reach control's address, the message bus's port and the image registry.

A join command works only once, so check these before you run it. On a machine, as the user the rig will run as:

```sh
podman --version                                  # 4.4 or later
systemctl --version | head -n 1                   # systemd is there
loginctl show-user "$(id -un)" -p Linger          # Linger=yes (not needed as root)
nvidia-ctk cdi list                               # GPUs only: nvidia.com/gpu=0, and one line for each GPU
curl -fsS https://control.example.com/v1/health   # {"ok":true,"loops":{…},"bus":"connected"}
nc -zv control.example.com 4222                   # the message bus's port answers
```

In a namespace, each of these must answer `yes` (add `resourceclaimtemplates.resource.k8s.io` for DRA):

```sh
for r in deployments services secrets persistentvolumeclaims networkpolicies; do
  kubectl auth can-i create $r -n <namespace>
done
```

## 1. Make the join command

1. Open **Rigs** in the sidebar, then press **Add a rig**.
2. Under **1 · Where**, after "Or run it yourself, where control can't connect:", choose **A machine you set it up on yourself** or **A Kubernetes namespace you apply it to yourself**.
3. Under **2 · GPUs and resources**:
   - for a machine, **GPUs on the machine**: the GPUs' numbers as `nvidia-smi` lists them, such as `0,1`. Empty: the rig measures on the CPU;
   - for a namespace, the **Namespace**, the number of **GPUs** (up to 8), **GPUs through** (NVIDIA's device plugin, or DRA with a **DRA device class**), the **Storage class** (empty: the cluster's default) and the **Volume size (GB)** (100 by default);
   - with two or more GPUs, **GPUs for the judge** (half by default). See [Give a rig several GPUs](several-gpus.md).
4. Under **3 · Name and start**, give a **Rig name** and press **Create the rig**.

The page shows the command once, under "Run this on the machine, as the user the rig should run as." or "Run this where kubectl reaches the cluster, with rights in the namespace …". Below it: "Shown once: copy it now. It works once, until HH:MM UTC." That is one hour after you made it.

A machine's command looks like this:

```sh
f=$(mktemp) && curl -fsS -H 'authorization: Bearer <join token>' "https://control.example.com/v1/join/rig-1/script?uid=$(id -u)" -o "$f" && sh "$f"; rm -f "$f"
```

A namespace's command pipes control's manifest into `kubectl apply -n <namespace> -f -`.

## 2. Run it

Copy the command and run it within the hour. On a machine, you can first `podman pull` the two images the rig's page lists under **Images**, as the rig's user: the script then skips the pull.

- **On a machine**, as the user the rig should run as, or as root. The script first checks what the rig needs. If something is missing, it writes nothing, stops, and says what to do:

  | It says | Do this |
  | --- | --- |
  | `thermite: Podman is missing: install Podman 4.4 or later, then make a new join command` | Install Podman |
  | `thermite: systemd is missing: a rig runs as systemd services` | Use a machine with systemd |
  | `thermite: lingering is off for <user>, …` | Run `sudo loginctl enable-linger <user>` |
  | `thermite: GPU <n> has no CDI device: …` | Install NVIDIA's container toolkit and generate its CDI spec |

  Then it writes the rig's files and services, pulls the images, starts the rig and prints `started`. It sets the rig up the same way control does over SSH, with the message bus's address and the certificate of control's authority for the bus among the files; [What control writes on the machine](rig-on-a-machine.md#what-control-writes-on-the-machine) lists them.

- **In a namespace**, where `kubectl` reaches the cluster, with your own rights. `kubectl` lists the objects it creates: the same as control applies on a cluster, with the same network rules: the harness reaches only DNS and addresses outside the private, shared and link-local ranges, and only its supervisor reaches the harness. The supervisor's deployment carries the message bus's address and the certificate of control's authority in its environment.

  | You see | Do this |
  | --- | --- |
  | `kubectl` says `forbidden` for an object | Get that right in the namespace. Run the page's **Remove** command (below) to delete what was made, then make a new join command |
  | The pods stay `Pending`, or show `ImagePullBackOff` | See [If it doesn't report](rig-on-a-cluster.md#if-it-doesnt-report), with your namespace |

The command works once, whether the run succeeds or not. After a failed check on a machine, the script wrote nothing, so there is nothing to remove: fix what it said, press **Make a new join command** on the rig's page ([step 4](#4-make-a-new-one-or-revoke-it)), and run the new command. The rig's page can't tell that the check failed: it says "fetched its files; waiting for its first report", and its card asks you to remove the rig first. There is nothing to remove, so skip that.

To read the script before it runs, split the command in two, as the same user. Fetching it uses the command up; the file holds the rig's tokens, so delete it once it has run:

```sh
f=$(mktemp) && curl -fsS -H 'authorization: Bearer <join token>' "https://control.example.com/v1/join/rig-1/script?uid=$(id -u)" -o "$f"
less "$f"
sh "$f"; rm -f "$f"
```

## 3. Watch it report

The rig's page shows **You run it yourself**, with its status:

- "waiting for you to run the join command";
- "fetched its files; waiting for its first report";
- "running", once it reports. The page then fills in: "rig-1 is live; it reported … ago."

Once the command is used, control waits up to an hour for the first report, since pulling the images can take a while on a new machine. (This is a second hour: the first was how long the command worked.) After that the status says "no first report yet"; it still changes to running when the rig reports. If it doesn't report, look at the rig's logs: see [Where the logs are](../operate/troubleshoot.md#where-the-logs-are).

## 4. Make a new one, or revoke it

The command's card on the rig's page says what state it is in:

- **A join command waits**, until a time: **Make a new join command** shows a new one (the earlier one stops working), and **Revoke it** ends it unused. The page says "The join command no longer works."
- **The join command expired unused**: press **Make a new join command**.
- **The join command was used**: to set the rig up again, remove it there first (below), then make a new one. When the new one is used, the rig gets a new token and the old one stops working.

Control keeps only a hash of each command, so it can never show one again. If you lose it, make a new one.

## Stop, start, restart and remove it

Under **Stop, start, restart or remove it: you run these there**, the rig's page shows the four commands for this rig. On a machine, as the user the rig runs as, they are these (the page starts each with a line that sets `XDG_RUNTIME_DIR` when the shell has none):

```sh
# Stop
systemctl --user stop thermite-rig-1-supervisor.service thermite-rig-1-harness.service
# Start
systemctl --user start thermite-rig-1-harness.service thermite-rig-1-supervisor.service
# Restart
systemctl --user restart thermite-rig-1-harness.service thermite-rig-1-supervisor.service
# Remove
systemctl --user stop thermite-rig-1-supervisor.service thermite-rig-1-harness.service || true
rm -f "$HOME/.config/containers/systemd/thermite-rig-1-harness.container" \
  "$HOME/.config/containers/systemd/thermite-rig-1-supervisor.container" \
  "$HOME/.config/containers/systemd/thermite-rig-1.network" \
  "$HOME/.config/containers/systemd/thermite-rig-1-egress.network"
systemctl --user daemon-reload
podman volume rm -f thermite-rig-1-state thermite-rig-1-scratch thermite-rig-1-inbox \
  thermite-rig-1-outbox thermite-rig-1-supervisor >/dev/null 2>&1 || true
podman network rm -f thermite-rig-1 thermite-rig-1-egress >/dev/null 2>&1 || true
rm -rf "$HOME/.local/share/thermite/rigs/rig-1"
```

As root, the page shows `systemctl` without `--user`, and the root paths from [What control writes on the machine](rig-on-a-machine.md#what-control-writes-on-the-machine). In a namespace:

```sh
kubectl scale deployment -n <namespace> -l app.kubernetes.io/instance=rig-1 --replicas=0   # stop
kubectl scale deployment -n <namespace> -l app.kubernetes.io/instance=rig-1 --replicas=1   # start
kubectl rollout restart deployment -n <namespace> -l app.kubernetes.io/instance=rig-1      # restart
kubectl delete deployment,service,persistentvolumeclaim,secret,networkpolicy,resourceclaimtemplate \
  -n <namespace> -l app.kubernetes.io/instance=rig-1 --ignore-not-found                    # remove
```

**Remove** deletes the rig's units, files and volumes, or its objects in the namespace, and with them the results it has not exported yet; control keeps the rig's exports, its events, its champions' patches and what its runs added to Thermite's [knowledge base](../../explanation/journals-and-knowledge.md), so [export](../operate/exports-on-control.md) or [take the result](../campaigns/take-the-result.md) you need first.

**Retire it** (type `retire rig-1`, then **Retire the rig**) ends the rig's token at once, so it can't report or take commands, and ends any join command. Its files stay where they are until you run **Remove** there. The rig stays in **Rigs**, **Stale** and then **Offline**. To take it off the rig lists too, use the other **Retire it**, at the top of the rig's page: type `retire rig-1` and press **Retire it**.

Next, [check the rig](../operate/check-a-rig.md).
