---
title: "Push the images to your own registry"
description: "Build Thermite's container images and push them to a registry your rigs can pull from."
type: how-to
sidebar:
  order: 6
---

Control sets [rigs](../../reference/glossary.md) up from images it does not build: a machine or a cluster pulls them from a registry. Each release publishes Thermite's images on `ghcr.io`, and a release's `compose.yaml` gives them to control already ([Published images](../../reference/harness-image.md#published-images)). Build and push images of your own when you change them, for example to [add your project's tools](extend-harness-image.md) or Claude Code, or when your rigs can't reach `ghcr.io`. Then you tell control their names.

## Before you start

- A clone of Thermite's source code (`git clone https://github.com/iammrduncan/thermite.git`), and Docker or Podman.
- A registry your rigs can pull from **without signing in**, over HTTPS. Control passes no registry credentials: none to machines, no image pull secret to clusters, none to RunPod. A private registry that needs a sign-in doesn't work yet ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)), and Podman and Kubernetes nodes refuse a registry served over plain HTTP unless their own settings allow it, which control doesn't change.
- Space for the builds. The CUDA harness image is large.

## The images

| Image | Built from | Who runs it |
| --- | --- | --- |
| Control | `containers/Containerfile`, target `control` | You, on control's computer |
| Harness | `containers/Containerfile`, target `harness` | CPU rigs |
| Harness, CUDA | The same target, with `BASE_IMAGE` set to a CUDA image | GPU rigs, and RunPod test pods |
| Supervisor | `containers/Containerfile`, target `supervisor` | Every rig |
| One-container rig | `containers/rig/Containerfile`, on the CUDA harness | Rigs on RunPod, and RunPod test pods. [Use a rig image of your own](runpod-rig.md#use-a-rig-image-of-your-own) builds it |

Name them as you like; control takes any full image reference. The examples use `registry.example.com/thermite/` and the first 12 characters of the commit as the tag.

## 1. Build them

Build from the repository's top folder: the images need its `package.json`, `src/`, `kits/`, `examples/` and `containers/`.

```sh
tag=$(git rev-parse --short=12 HEAD)
commit=$(git rev-parse HEAD)
r=registry.example.com/thermite
docker build --target control    -t $r/thermite-control:$tag    --build-arg THERMITE_COMMIT=$commit -f containers/Containerfile .
docker build --target harness    -t $r/thermite-harness:$tag    --build-arg THERMITE_COMMIT=$commit -f containers/Containerfile .
docker build --target supervisor -t $r/thermite-supervisor:$tag --build-arg THERMITE_COMMIT=$commit -f containers/Containerfile .
```

With Podman, use `podman build` the same way. `THERMITE_COMMIT` puts the commit in each image: control and the rigs report it with Thermite's version, so the rig lists show which build each part runs ([Rig versions](../../reference/rest-api.md#rig-versions)). Without it they report the version alone.

For GPU rigs, build the harness again on a CUDA base:

```sh
docker build -t $r/thermite-harness:$tag-cuda \
  --build-arg BASE_IMAGE=<a CUDA development image> \
  --build-arg THERMITE_COMMIT=$commit \
  --target harness -f containers/Containerfile .
```

The release workflow builds two published CUDA harnesses, each on a base pinned by its digest in `.github/workflows/release.yml`: `docker.io/nvidia/cuda:12.6.3-devel-ubuntu22.04` for the `-cuda` image and `docker.io/nvidia/cuda:13.0.3-devel-ubuntu24.04` for the `-cuda13` image. Use the same bases, or others that have what the Containerfile needs:

- **The CUDA your GPUs need.** CUDA 12 builds for Pascal (P100) and Volta (V100) to Hopper; CUDA 13 builds for Turing to Blackwell, the DGX Spark included, and for nothing older. RunPod test pods ask for hosts that run CUDA 12.6 or later. For a DGX Spark, build for arm64 (`--platform linux/arm64`): its CPU is Arm.
- **A development image**, with `nvcc`: the GPU smoke check compiles CUDA code on the rig.
- **Debian or Ubuntu based**, because the build installs its packages with `apt-get` from the base's own package lists: git, tini (the image's entry point), a C and C++ toolchain, CMake, Ninja, ccache, and Python 3 with numpy. Node.js, OpenCode and the Codex CLI are copied in, so the base needn't have them.

### Build arguments

| Argument | Images | Default | What it does |
| --- | --- | --- | --- |
| `BASE_IMAGE` | Harness | The Node.js image | The base of the final image: a CUDA image for GPU rigs |
| `NODE_IMAGE` | All three | Node.js 22 on Debian bookworm, pinned by digest | Where Node.js comes from |
| `OPENCODE_VERSION` | Harness, supervisor | `2.1.4` | The OpenCode release the image carries |
| `CLAUDE_CODE_VERSION` | Harness, supervisor | Empty: no Claude Code | Downloads that Claude Code release into the image, for a [Claude subscription](../models/claude-subscription.md) |
| `CODEX_VERSION` | Harness, supervisor | `0.162.1` | The Codex CLI release the image carries, for [agents in Codex](../models/chatgpt-subscription.md#run-the-agents-in-codex). Empty: no Codex CLI, and an image about 400 MB smaller |
| `KUBECTL_VERSION` | Control | `v1.37.1` | The kubectl control uses for clusters. It is checked against a pinned hash, so a different version fails the build |
| `THERMITE_COMMIT` | All three | Empty: no commit | The source commit the image is built from, which the service reports with its version |
| `THERMITE_IMAGE_ID` | Harness | Empty | A name for this build, which the harness reports as its image, for example `--build-arg THERMITE_IMAGE_ID=$tag` |

Claude Code is not open source, so Thermite's images leave it out by default. **Never push an image built with Claude Code to a public registry.** Since rigs can't sign in to a registry yet, such an image reaches a remote rig only from a registry that is not public and still needs no sign-in, such as one that only your own network reaches. Let that registry take pushes only from someone signed in.

### Architectures

The control image builds for amd64 and arm64 only. The harness and supervisor pick their downloads for arm64, or for x64 otherwise. The release workflow builds the published images for both architectures at once, with Docker Buildx. A plain `docker build` or `podman build` makes one: build each image for the architecture of the machines that run it. Docker and Podman build for another one with `--platform`: on a Mac with Apple silicon, for example, add `--platform linux/amd64` for x86-64 machines.

## 2. Push them

```sh
docker push $r/thermite-harness:$tag
docker push $r/thermite-harness:$tag-cuda      # if you built it, for GPU rigs
docker push $r/thermite-supervisor:$tag
```

With Podman, use `podman push` the same way. Podman refuses a registry served over plain HTTP (`server gave HTTP response to HTTPS client`), even one on your own computer, unless you add `--tls-verify=false`; rigs can't pull from such a registry anyway, as [Before you start](#before-you-start) says.

Push the control image too if control runs from it elsewhere. The compose stack of a checkout builds its own images and pulls none; a release's pulls the published images.

**Use a new tag for every build.** A machine pulls an image only when it does not have that tag already, and a cluster's pods use `IfNotPresent`. An image pushed again under an old tag never reaches a machine or node that has the old one. Control also offers a rig on a cluster new images only when their names differ from the ones it runs.

## 3. Tell control

Set these on control, then restart it. With the compose stack, put them in `.env` and run `docker compose up -d`, with your `-f` options if you use [override files](one-machine.md#settings-and-override-files).

| Setting | Image |
| --- | --- |
| `THERMITE_RIG_HARNESS_IMAGE` | The CPU harness |
| `THERMITE_RIG_SUPERVISOR_IMAGE` | The supervisor. Control needs both of these to set rigs up |
| `THERMITE_RIG_HARNESS_CUDA_IMAGE` | The CUDA harness, for GPU rigs |
| `THERMITE_RUNPOD_RIG_IMAGE` | The one-container rig image, for rigs on RunPod |
| `THERMITE_RUNPOD_TEST_IMAGE` | The CUDA harness or the one-container rig image, as RunPod test pods' default. A release's `compose.yaml` sets it to the release's rig image. Without it, type the image into the test form |

```sh title=".env (part)"
THERMITE_RIG_HARNESS_IMAGE=registry.example.com/thermite/thermite-harness:1a2b3c4d5e6f
THERMITE_RIG_HARNESS_CUDA_IMAGE=registry.example.com/thermite/thermite-harness:1a2b3c4d5e6f-cuda
THERMITE_RIG_SUPERVISOR_IMAGE=registry.example.com/thermite/thermite-supervisor:1a2b3c4d5e6f
```

**Rigs › Add a rig** now lists them under **Images**, and a new rig is set up from them. A GPU rig gets the CUDA harness.

A rig that control set up on a cluster keeps the images it runs until you move it: its page then offers **Update to these images**. See [Move a rig onto new images](../operate/rig-lifecycle.md#a-rig-on-a-cluster).

## What does not work yet

- **Registry sign-in.** Control gives rigs no credentials for a private registry, so a machine's Podman, or a cluster's nodes, must pull the images without signing in.
- **Moving joined rigs to new images.** A rig you joined yourself (on a machine or in a namespace) keeps the images it was set up with. Control can't move it ([goal 035](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/035-rig-upgrades.goal)): pull the new images where it runs and start it again. Rigs that control set up, on a machine or a cluster, move with **Update to** control's version on their page ([Update to control's version](../operate/rig-lifecycle.md#update-to-controls-version)).
- **Image names.** A rig's harness reports `THERMITE_IMAGE_ID` as its image, when the build set it, and the rig's page shows it. Control compares the rig's Thermite version with its own, not its image: a rig is behind only when the version it reports is older ([A rig's page](../../reference/rig-page.md#the-version-banner)). For a rig control set up, its page also shows the image names control used.

To add your own tools to the harness, see [Extend the harness image](extend-harness-image.md).
