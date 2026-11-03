---
title: "Getting help"
description: "Where to ask a question or report a problem, and what to include."
type: project
sidebar:
  order: 2
---

Stuck, or found something wrong? This page says where to ask, and what to put in a report so that someone can help you quickly.

## Where to ask

| You want to | Go to |
| --- | --- |
| Ask a question, share an idea or a result | The [Hackers in the Loop Discord](https://discord.gg/3Qs2uejUf9), where Thermite's community meets |
| Report a bug, or ask for a feature | [GitHub issues](https://github.com/iammrduncan/thermite/issues). Search the open issues first: someone may have reported it already. The bug report form asks for what is [below](#what-to-put-in-a-report) |
| Report a security problem | Privately, through GitHub's private vulnerability reporting, as the [security policy](https://github.com/iammrduncan/thermite/blob/main/SECURITY.md) says. Not a public issue, and not a public Discord channel. First check [Known limits](../reference/known-limits.md): it lists what the design does not cover yet |
| Report a problem with someone's conduct | Privately to the maintainers, as the [code of conduct](https://github.com/iammrduncan/thermite/blob/main/CODE_OF_CONDUCT.md) says |

Before you report a problem, try [Troubleshoot](../how-to/operate/troubleshoot.md). It starts with `thermite doctor`, which checks your machine, and covers failed checks, port clashes, the Podman virtual machine's disk and memory, and slow builds.

## What to put in a report

1. **What you did, what you expected, and what happened.** Copy messages exactly, such as the text of a card that starts with **Not done.** or **Not started.** on the dashboard, a line that starts with **Not sent.** in a run's **Live** view, or a failed command's **Detail** among the **Audit log**'s commands.
2. **Which Thermite you run.** Thermite has no version command yet. If you installed a release, give its version: the release's readme names it (`Thermite 0.1.1`), and so does the **Version** column on **Rigs** ([Version](../reference/rigs-list.md#version)). If you built Thermite from its source, give the commit you built from:

   ```sh
   git log -1 --oneline
   ```

3. **Your system.** Run `npx thermite doctor` on the machine with the problem, in your `thermite-source` folder ([the command line](../how-to/install/one-machine.md#the-command-line)), and copy all of its output: it names the container engine, the compose tool, the free disk and the GPU driver. Add:
   - the operating system and its version;
   - the container engine and its version, for example `docker --version` or `podman --version`;
   - the compose tool: `docker compose`, `podman compose` or podman-compose, and its version;
   - the Node.js version, from `node --version`.
4. **Where the rig runs:** the local compose stack, a machine that control set up over SSH, a Kubernetes cluster, or a rig you joined yourself. Say whether it has GPUs.
5. **The rig's check results.** Run the rig's three checks and copy the sentence each one shows. See [Check a rig](../how-to/operate/check-a-rig.md).
6. **The logs** from around the time of the problem (see below).

:::caution[Check before you post]
Logs and screenshots can hold your host names, addresses, repository names and paths. Read them, and remove anything private, before you post them in public.
:::

## Get the logs

Each part of Thermite writes its log to its container's output, one JSON object per line.

| Where it runs | Command |
| --- | --- |
| The local compose stack | `docker compose logs control harness supervisor`, or `podman compose logs control harness supervisor` |
| A rig on a machine, set up by control | On the machine: `journalctl --user -u thermite-rig-1-harness.service`, and the same for `thermite-rig-1-supervisor.service`. Without `--user` if the rig runs as root |
| A rig on a Kubernetes cluster | `kubectl logs -n <namespace> deployment/thermite-rig-1-harness`, and the same for `thermite-rig-1-supervisor` |

Replace `rig-1` with your rig's name. Control's own record of what it refused or failed, and why, is on the dashboard's **Audit log** page, in the sidebar. [Troubleshoot](../how-to/operate/troubleshoot.md) says more about where the logs are.
