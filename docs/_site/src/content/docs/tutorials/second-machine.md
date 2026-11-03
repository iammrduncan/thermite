---
title: "Add a second machine"
description: "Give your Thermite a second machine to work on: let it reach control, add it over SSH, and start a run there."
type: tutorial
sidebar:
  order: 3
---

In this tutorial you add a second machine to the Thermite you started in [Install on one machine](first-run.md). Control sets a rig up there over SSH, and you start a run of your campaign on it, beside the first.

It takes about thirty minutes, most of it the second machine downloading the images.

## What you need

- **Thermite on your first machine**, from [Install on one machine](first-run.md), and a campaign from [Run your first campaign](agents-with-a-free-model.md).
- **A second machine:** Linux with systemd, which you reach over SSH. It must reach your first machine, and pull the release's images from `ghcr.io`.
- **An account on it for control.** Make one with `sudo useradd -m thermite`. For control to install Podman there, give it sudo without a password: add the line `thermite ALL=(ALL) NOPASSWD: ALL` with `sudo visudo -f /etc/sudoers.d/thermite`. You can remove that file once the installs are done.
- **A name for your first machine** that the second one reaches, and a reverse proxy on the first machine that serves HTTPS under it, such as Caddy or nginx. Compose shows control only to the first machine itself, at `127.0.0.1:8800`.

## 1. Let the second machine reach control

1. Point your reverse proxy at `127.0.0.1:8800`, under the name, such as `control.example.com`. Have it send `X-Forwarded-Proto: https` and take request bodies of up to 90 MB.
2. In `.env`, next to `compose.yaml` on your first machine, add the address and open the message bus's port to other machines:

   ```sh title=".env (part)"
   THERMITE_CONTROL_PUBLIC_URL=https://control.example.com
   THERMITE_NATS_PUBLISH=0.0.0.0:4222
   ```

3. Start Thermite again with them:

   ```sh
   docker compose up -d   # or: podman compose up -d
   ```

4. On the second machine, check that it reaches both:

   ```sh
   curl https://control.example.com/v1/health
   nc -zv control.example.com 4222
   ```

   `curl` answers `{"ok":true,"bus":"connected","degraded":false}`, and `nc` connects. If your firewall blocks port 4222, open it to the second machine: a rig talks to control on that port.

## 2. Add the machine

1. Open the dashboard and press the cog at the foot of the sidebar: **Settings › Providers** opens.
2. Under **Add a provider**, set **Type** to **A machine over SSH**, and fill in a **Name** such as `machine-2`, its **Address**, the **SSH port** (usually 22) and the **User**, `thermite`. Leave **Private key** empty: control makes one.
3. Press **Add and read its host key**.

The machine's row opens, with a line that starts with `restrict`: the public half of control's key.

## 3. Let control in

1. On the second machine, as `thermite`, add that line to `~/.ssh/authorized_keys`. Make the folder and the file first if they are new: `~/.ssh` with mode 700, the file with mode 600.
2. Back in the row, compare its fingerprint with the machine's own: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the machine. If they match, press **It matches: trust it**.

Control logs in and reads the machine: its system, GPUs, Podman and whether it reaches control. Under **Missing for a rig**, it asks about each thing the machine still needs, such as **May control install Podman?**, with the exact script it would run. Press **Install it** for each, then **refresh** in the status bar along the bottom of the page until the row has nothing missing.

## 4. Add the rig

1. Open **Rigs** in the sidebar, then press **Add a rig**.
2. Under **1 · Where**, choose **machine-2 · a machine over SSH**.
3. Under **2 · GPUs and resources**, tick its GPUs, if it has any. With none, the rig measures on the CPU.
4. Under **3 · Name and start**, give a **Rig name**, such as `rig-2`. **Message bus** shows the address the rig will reach, such as `nats://control.example.com:4222`.
5. Press **Create the rig**.

You land on the rig's page. Its **Set up by control** block ticks off each step as it comes: enrolled, files and services written and started, its key on the message bus registered, first report. The first download of the images takes most of the time. When the last step is ticked, press **refresh**: the page says `rig-2 is live`.

## 5. Start a run there

1. Open **Campaigns** in the sidebar, then your campaign, and press **Start a run** at the top of its page.
2. Under **Where it runs**, choose `rig-2`.
3. Press **Start the run**.

The campaign's page now has two runs at work, one on each machine. Each rig's judge measures only its own run, and every result reaches the same control.

## What you did

You gave control a way in from other machines, let it set a rig up on a second one over SSH, and ran your campaign on both at once.

## Next

- [Run one campaign on several rigs](../how-to/campaigns/several-rigs.md): share experiments between the runs, and move a champion from one rig to another.
- [Add a rig on a machine over SSH](../how-to/install/rig-on-a-machine.md): every option of this tutorial's steps, what control writes on the machine, and how to stop, update or remove the rig.
- Other places for a rig: [a Kubernetes cluster](../how-to/install/rig-on-a-cluster.md), [a machine control can't reach, with a join command](../how-to/install/join-a-rig.md), or [a GPU on RunPod](../how-to/install/runpod-rig.md).
- [Give a rig several GPUs](../how-to/install/several-gpus.md): split them between the judge and the agents.
