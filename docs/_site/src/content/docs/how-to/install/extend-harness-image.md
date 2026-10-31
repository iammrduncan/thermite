---
title: "Extend the harness image"
description: "Add the compilers and tools your project needs to the image the agents and the judge run in."
type: how-to
sidebar:
  order: 7
---

The harness image is where your project is built, timed and changed: the judge's builds and timed runs and the agents' commands all run inside it. If your project needs a tool the image lacks, such as another compiler or a library, build your own image `FROM` Thermite's harness image and add it.

The image already has a C and C++ toolchain (`gcc`, `g++`, `make`), CMake, Ninja, ccache, Python 3 with numpy, git, Node.js, OpenCode and the Codex CLI. A CUDA image also has what its base carries, such as `nvcc`. The CPU image is Debian bookworm; a CUDA image has its base's system. The [harness image reference](../../reference/harness-image.md) lists it in full.

## Before you start

- Thermite's harness image: a published one, such as `ghcr.io/iammrduncan/thermite-harness:0.1.0` for CPU rigs or `ghcr.io/iammrduncan/thermite-harness:0.1.0-cuda` for GPU rigs ([Published images](../../reference/harness-image.md#published-images)), or one you built ([Push the images to your own registry](own-registry.md)). Extend the CPU image for CPU rigs and the CUDA image for GPU rigs.
- A registry your rigs can pull from without signing in, for your image.

## 1. Write a Containerfile

Start from the harness image and install with `apt-get`. This example adds a Fortran compiler and OpenBLAS:

```dockerfile title="Containerfile"
FROM ghcr.io/iammrduncan/thermite-harness:0.1.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends gfortran libopenblas-dev \
 && rm -rf /var/lib/apt/lists/*
ENV THERMITE_IMAGE_ID=0.1.0-fortran-1
```

The last line gives your image a name of its own, which the rig's page shows as its image. The harness keys every build it makes on the image's installed packages and compilers ([Build cache](../../reference/kit-manifest.md#build-cache)), so a rig on your image builds afresh, and never reuses a build made without your tools. A tool you install without `apt-get`, such as a compiler unpacked into `/opt`, isn't in that list: set `THERMITE_TOOLCHAIN_ID` too, and change it with each new version of the tool.

Keep these as they are, or the rig won't start or won't be safe to judge on:

| Keep | Why |
| --- | --- |
| **Root.** Add no `USER` line | The harness starts as root and runs each kind of work as its own user. As another user it stops with `fatal: not root, so roles cannot be separated` |
| **`ENTRYPOINT` and `CMD`.** Don't set them | They start the harness |
| **Thermite's users and groups.** Don't remove, renumber or reuse them | Their ids are fixed in Thermite's code. The [harness image reference](../../reference/harness-image.md) lists them |
| **`/outbox`**, owned by user 10010 and group 10001, mode 2750 | The harness writes exports there and the supervisor reads them |
| **`/opt/thermite`** | Thermite itself, and in `/opt/thermite/checks` the kits and projects of the smoke check. Keep that folder root's, with group `thermite` (10010) and nothing in it open to other users: only the harness may read a kit, and the [isolation check](../../reference/rig-checks.md#isolation-check) fails when a role can |

## 2. Put tools where every user finds them

Builds, timed runs and the agents' commands run as Thermite's own users, not as root. They don't get the image's environment: only `PATH` (the image's, or a fixed one for agents in OpenCode v2, Claude Code and Codex), `LANG`, their own `HOME`, `TMPDIR` and `USER`, and a few settings Thermite gives them itself.

- Install tools where every user can run them, such as `/usr/bin` or `/usr/local/bin`, not under `/root`.
- `ENV PATH=…` in your Containerfile reaches builds, timed runs and the commands of agents in Pi. Agents in OpenCode v2, Claude Code and Codex run their commands with a fixed `PATH`, `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, with `/usr/local/cuda/bin` first where the image has it: for them, install your tools in `/usr/local/bin` or `/usr/bin`, or link them there. Other `ENV` lines, such as `LD_LIBRARY_PATH`, reach none of them: register library folders with the system's linker (`ldconfig`) instead.
- Don't rely on files in a home folder: each process's home is its own working folder.

## 3. Build and push it

Give it a name and a tag of its own, and use a new tag for every build: a machine never pulls a tag it already has.

```sh
docker build -t registry.example.com/thermite/thermite-harness-fortran:1a2b3c4d5e6f-1 -f Containerfile .
docker push registry.example.com/thermite/thermite-harness-fortran:1a2b3c4d5e6f-1
```

With Podman, use `podman build` and `podman push`.

## 4. Use it for new rigs

Set control's harness image to yours, then restart control (with the compose stack: in `.env`, then `docker compose up -d` with your `-f` options):

- `THERMITE_RIG_HARNESS_IMAGE` for CPU rigs;
- `THERMITE_RIG_HARNESS_CUDA_IMAGE` for GPU rigs.

**Rigs › Add a rig** shows it under **Images**, and every rig you add from then on runs it.

A rig you already have keeps the image it runs:

- **A rig that control set up on a cluster** can move onto your image. Its page then offers **Update to these images** ([Move a rig onto new images](../operate/rig-lifecycle.md#a-rig-on-a-cluster)). Every such rig whose image differs from control's offers it, so press it only on the rigs that should have your tools.
- **A rig you joined yourself** can't move to a new image from control yet ([goal 035](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/035-rig-upgrades.goal)), so add a new rig. A rig control set up on a machine moves with **Update to** control's version on its page only when its Thermite version is behind control's.

Thermite doesn't know which rigs carry your tools. A kit names only its target (`cpu` or `cuda-gpu`), and on a rig without the tools the judge's builds of your project fail. Start campaigns that need them only on rigs added from your image; a name that says so, such as `rig-fortran-1`, helps.

### On the local stack

A release's `compose.yaml` names the harness image itself and has no setting for another one ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)). Give its rig your image with an [override file](one-machine.md#settings-and-override-files) next to `compose.yaml`:

```yaml title="compose.harness.yaml"
services:
  harness:
    image: registry.example.com/thermite/thermite-harness-fortran:1a2b3c4d5e6f-1
```

Then start the stack with it, and name it in every later `up`, with your other `-f` options:

```sh
docker compose -f compose.yaml -f compose.harness.yaml up -d   # or: podman compose -f … -f … up -d
```

In a checkout of the source code, the stack builds its harness from your clone instead. Add the packages to the first `apt-get install` line in your clone's `containers/harness/Containerfile` (the one that lists `gcc`), then rebuild with `docker compose up -d --build harness`. The change stays in your clone, so a later `git pull` may ask you to merge it.

## Check that it worked

On the new rig's page (on the local stack, the page of `local-1`, from step 2 on):

1. The **Set up by control** block's **Images** names your image. (A rig you joined yourself shows it under **You run it yourself**.)
2. Run **Isolation** and **Judge smoke** ([Check a rig](../operate/check-a-rig.md)). Both must pass, as on Thermite's own image.
3. Run your kit with no agents, so the judge builds your project with the new tools: see [Test a kit with known candidates](../campaigns/test-a-kit.md).
