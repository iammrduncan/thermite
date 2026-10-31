# Thermite @@VERSION@@

This bundle starts Thermite on one computer from its published images. You get the control service (the dashboard, the REST API and MCP) and one rig, `local-1`, which runs on the CPU. You build nothing.

The bundle has two files: `compose.yaml` and this readme.

**SHA-256 of `compose.yaml`:** `@@COMPOSE_SHA256@@`

## What you need

- Linux or macOS, with a few CPU cores, a few gigabytes of free memory and about 3 GB of free disk for the images, which take about 2.5 GB. With Podman on a Mac, that space must be free in Podman's virtual machine.
- Docker with Docker Compose, or Podman with `podman compose`.

## Start Thermite

The commands are for Docker. With Podman, write `podman compose` in place of `docker compose`.

1. Make an empty folder, and put `compose.yaml` in it:

   ```sh
   mkdir thermite && cd thermite
   curl -fsSLO @@REPO_URL@@/releases/download/@@TAG@@/compose.yaml
   ```

   Check that it is this release's file. On Linux:

   ```sh
   echo "@@COMPOSE_SHA256@@  compose.yaml" | sha256sum -c -
   ```

   On macOS, use `shasum -a 256 -c -` in place of `sha256sum -c -`. It prints `compose.yaml: OK`. If it prints `FAILED`, the file is not the one this release published: don't use it. Download it again, and if it fails again, report it privately, as [SECURITY.md](@@REPO_URL@@/blob/@@TAG@@/SECURITY.md) says.

2. Make your tokens. This writes them to `.dev/secrets/` in the folder:

   ```sh
   docker compose run --rm init
   ```

3. Start Thermite. The first start downloads the images. Each start enrolls the rig with control and writes its token to `.dev/secrets/` before the rig starts:

   ```sh
   docker compose up -d
   ```

4. Open <http://127.0.0.1:8800/ui>. Paste the token from `.dev/secrets/control-admin-token` into **Admin token**, then press **Sign in**.

The rig gets every CPU and all the memory that Docker or Podman has: on a Mac, its virtual machine's. On Linux with NVIDIA GPUs, step 2 also writes `compose.gpu.yaml`, which puts the rig on the CUDA harness and every GPU. It needs NVIDIA's container toolkit, which `init` can't check from its container. Start Thermite with both files: `docker compose -f compose.yaml -f compose.gpu.yaml up -d`. [What the rig gets](@@REPO_URL@@/blob/@@TAG@@/docs/_site/src/content/docs/how-to/install/one-machine.md#what-the-rig-gets) says what each kind of machine gets.

Keep the folder: it holds your tokens. To stop Thermite, run `docker compose down` in the folder. Do not add `-v`: `down -v` deletes the volumes, and all that Thermite recorded with them.

## Next steps

- [Your first run](@@REPO_URL@@/blob/@@TAG@@/docs/_site/src/content/docs/tutorials/first-run.md): the quick start. It continues from step 4.
- [Install Thermite on one machine](@@REPO_URL@@/blob/@@TAG@@/docs/_site/src/content/docs/how-to/install/one-machine.md): settings, updates and rigs on other machines.

## What is in this release

[CHANGELOG.md](@@REPO_URL@@/blob/@@TAG@@/CHANGELOG.md) lists what this release has: installs from images, rigs on your machines, clusters and RunPod, the three campaign modes, the agents' harnesses and models, MCP servers for the agents, and the dashboard, REST API and MCP that steer it all.

## Known limits

Read [Known limits](@@REPO_URL@@/blob/@@TAG@@/docs/_site/src/content/docs/reference/known-limits.md) before you give Thermite a model. Thermite's agents run code that a model writes, on your computer. Versions 0.x make no upgrade promise.

## Report a problem

Open an issue at <@@REPO_URL@@/issues>, with what you ran, what you saw and the output of `thermite doctor`. Report a security problem privately, as [SECURITY.md](@@REPO_URL@@/blob/@@TAG@@/SECURITY.md) says, never in a public issue.

## The images

The compose file pins each image by its digest. The same images also have the tags below.

| Image | Pinned as | Tag |
| --- | --- | --- |
| Control | `@@CONTROL_IMAGE@@` | `@@CONTROL_TAG@@` |
| Harness, CPU | `@@HARNESS_IMAGE@@` | `@@HARNESS_TAG@@` |
| Harness, CUDA 12 (Pascal to Hopper) | `@@HARNESS_CUDA_IMAGE@@` | `@@HARNESS_CUDA_TAG@@` |
| Harness, CUDA 13 (Turing to Blackwell, DGX Spark; amd64 and arm64). Untested: it has not yet run on a GPU | `@@HARNESS_CUDA13_IMAGE@@` | `@@HARNESS_CUDA13_TAG@@` |
| Supervisor | `@@SUPERVISOR_IMAGE@@` | `@@SUPERVISOR_TAG@@` |
| Rig for RunPod, CUDA | `@@RIG_CUDA_IMAGE@@` | `@@RIG_CUDA_TAG@@` |

The compose file runs the CPU harness, or the CUDA 12 harness with `compose.gpu.yaml`. Control sets rigs up on other machines and clusters from the CPU harness, the CUDA 12 harness (for GPU rigs) and the supervisor. For GPUs that CUDA 12.6 does not know, such as Blackwell and the DGX Spark, set `THERMITE_RIG_HARNESS_CUDA_IMAGE` to the CUDA 13 harness; CUDA 13 does not build for Pascal or Volta. The CUDA 13 harness is untested: the release builds and checks it, but it has not yet run on a GPU. It launches rigs on RunPod from the rig image: the CUDA harness and the supervisor in one container. The images do not contain Claude Code.

The compose file also runs the message bus for the rigs' reports, commands, live lines and config, where control keeps every rig's events: the NATS server, from its official image `docker.io/library/nats:2.15.1-alpine` (Apache-2.0), pinned by its digest. It takes connections over TLS only, with a certificate from control's own certificate authority, and knows only the users control writes for it: control's own, and each rig's own key. Its port, 4222, is published on `127.0.0.1` only; set `THERMITE_NATS_PUBLISH=0.0.0.0:4222` in `.env` to let rigs on other machines reach it. It keeps its messages on disk, on its volume, and has 256 MiB of memory: `THERMITE_NATS_MEMORY` and `THERMITE_NATS_STORE` in `.env` give it more memory, or a limit on its disk. Control and every rig need it: a rig reaches control only on the bus. [Run the message bus](@@REPO_URL@@/blob/@@TAG@@/docs/_site/src/content/docs/how-to/operate/message-bus.md) says more.

The source code is at <@@REPO_URL@@>, under the MIT license. The harness images also carry OpenCode (MIT) and the Codex CLI (Apache-2.0), and the control image carries kubectl (Apache-2.0), each with its license.
