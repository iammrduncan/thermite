---
title: "Model files on a rig"
description: "How a rig's supervisor downloads a model file by URL: the import's fields, the checks, the Hugging Face token, the progress it reports, its errors and its limits."
type: reference
sidebar:
  order: 18
---

A [model file](glossary.md) is a data file your project loads that is not in its repository, such as a model's weights. The contract lists each one by name and SHA-256 under `models`. An assignment can name a URL for it: the rig's [supervisor](glossary.md) (the rig's link to the outside) downloads the file, checks it, and only then hands the assignment to the [harness](glossary.md) (the rig's container with the judge and the agents). This page describes that download. [Bring a model's weights to a run](../how-to/campaigns/model-weights.md) gives the steps.

```sh
npx thermite assign --contract contract.json --run quant-1 \
  --seed https://git.example.com/lab/engine.git \
  --model llama-8b=https://huggingface.co/example-org/llama-8b/resolve/0123abcd/model.safetensors \
  --ttl 600 --control http://127.0.0.1:8800 --token-file .dev/secrets/control-admin-token --rig rig-1
```

## The import

Each `--model NAME=URL` becomes one import in the `assign_campaign` payload ([signed commands](signed-commands.md)):

```json title="an import (part)"
{
  "kind": "model",
  "name": "llama-8b",
  "sha256": "5f0c0e8d6b1a4c7e9f2d3b4a5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d",
  "path": "models/5f0c0e8d6b1a4c7e9f2d3b4a5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d",
  "source": { "url": "https://huggingface.co/example-org/llama-8b/resolve/0123abcd/model.safetensors" }
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | `"model"` | A model file |
| `name` | text | The name the contract lists it under |
| `sha256` | 64 hexadecimal characters | The file's SHA-256. The harness refuses the assignment when the contract lists no model with it: `model <name> is not listed in the contract` |
| `path` | relative path | Where the file goes in the rig's inbox. `thermite assign` uses `models/<sha256>` |
| `source.url` | `http` or `https` URL, up to 4,000 characters | Where the supervisor downloads it from. Without `source`, the file must already be in the inbox |

A model in several files, such as a model in shards, is one entry in the contract's `models` for each file, and one import each.

## Where the file goes

1. The supervisor downloads to `<path>.part` in its inbox (`THERMITE_INBOX_DIR`, `/inbox` by default), hashing the bytes as they arrive. It keeps the rig's disk floor (`THERMITE_DISK_FLOOR_GIB`) before it starts and as it writes.
2. When the last byte is in and its SHA-256 is the signed one, the file is renamed to `<path>`. Only then does the supervisor hand the assignment to the harness.
3. The harness copies the file into its own state (`THERMITE_STATE_DIR`, under `models/`), hashing it again as it copies. The kit reads that copy as `{models:<sha256>}`, read-only. See [the kit manifest](kit-manifest.md).

The inbox copy stays. A later assignment that names the same file finds it, checks its SHA-256 and does not download it again. So a rig needs free space for the file twice: the inbox's copy and the harness's copy.

On RunPod, the rig image keeps the inbox and the harness's state on the pod's own disk, and a snapshot of both on the pod's volume, which a stop keeps ([Where the state lives](harness-image.md#where-the-state-lives)). So give the file room twice on each: the disk holds both copies, and so does the snapshot.

## The checks

- **The SHA-256.** A file whose SHA-256 is not the signed one is deleted, and the assignment fails. The harness never sees it.
- **Free space.** When the server says the file's size, the supervisor checks the free space where the file goes before it reads the first byte.
- **A file already there** is hashed. If it matches, nothing is downloaded. If not, it is downloaded again.
- **Redirects.** The supervisor follows at most 10 redirects itself. It refuses a redirect from HTTPS to plain HTTP, and one to any other kind of address.
- **The harness checks again** when it imports the file, whatever the supervisor did.

## A broken download

When the connection breaks, the bytes that arrived stay as `<path>.part`. The next download of the same file asks the server for the rest with an HTTP range, and hashes what it kept first. That happens when the supervisor restarts during the download, and when you start the run again after the assignment failed. When the server sends the whole file instead of the rest, the kept part is dropped and the download starts again.

Two assignments that name the same file at once share one download.

## Gated models on Hugging Face

Some models on Hugging Face can be downloaded only with a token from an account that accepted the model's terms. Give the supervisor a token in a file:

| Setting | Meaning |
| --- | --- |
| `THERMITE_HF_TOKEN_FILE` | A file holding a Hugging Face token. The supervisor reads it once, when it starts |

- The supervisor sends the token as `Authorization: Bearer …` only to `https://huggingface.co` and `https://hf.co`. It never sends it over plain HTTP, and never to the address a redirect leads to: Hugging Face's own file servers get a signed address instead.
- The token never goes into a command, the inbox, an event, a live line, the supervisor's report or an error message, and the harness never gets it. No agent can read it.
- A token that may only read is enough.

Without a token, a gated file fails with `HTTP 401: the model may be gated. Give the supervisor a Hugging Face token that may read it (THERMITE_HF_TOKEN_FILE)`. With a token that may not read it, the error is `HTTP 403: Hugging Face refused the supervisor's token for this file. Accept the model's terms on huggingface.co with the token's account, or give a token that may read it`. The status is whatever Hugging Face answered.

## Progress

The supervisor reports each download in four places. Its report is not signed: these say what the supervisor reports. Only the harness's import, which checks the SHA-256 again, makes a file usable.

### The supervisor's report

The newest 20 downloads, newest first, go to control with the supervisor's figures every round (`THERMITE_POLL_SECONDS`, 60 seconds by default). They are `supervisor.models` in `GET /v1/rigs/<rig>/view` ([REST API](rest-api.md#rigs-and-their-history)).

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | text | The model's name |
| `path` | text | Its place in the inbox |
| `sha256` | 64 hexadecimal characters | The signed SHA-256 |
| `from` | text | The URL's host, never its path or query. After a redirect to another host: `huggingface.co (via <host>)` |
| `state` | `downloading`, `done`, `refused` or `failed` | `done`: downloaded with the signed SHA-256. `refused`: another SHA-256, so the file was deleted. `failed`: the download stopped |
| `bytes` | number | Bytes so far, those an earlier download left included |
| `total` | number or `null` | The file's size, when the server says it |
| `resumed_from` | number | Bytes taken over from an earlier, broken download |
| `started_at`, `updated_at` | time | When it started, and when it last moved |
| `error` | text | Why it was refused or stopped |
| `run` | text | The run whose assignment brought it |

### Live

The supervisor's lines in the rig's **Live** view, with the run:

| Line | When |
| --- | --- |
| `Model <name>: download started from <host>, <size>.` | The server answered. With `, from the <size> an earlier download left` when it goes on from a broken download |
| `Model <name>: <size> of <size> (<n>%) downloaded.` | At every tenth of the file, and at least every 5 minutes. Without a size from the server, every 5 minutes, without the share |
| `Model <name>: <size> downloaded. Its SHA-256 matches the signed one.` | Done |
| `Model <name>: refused. Its SHA-256 is <sha256>, not the signed <sha256>. The file was deleted.` | Refused |
| `Model <name>: the download stopped. <why>` | Failed |

### The rig's history

Control compares each report with the one before, and records a step when a download starts and when it ends. The page of a rig that control set up shows them under its setup steps, and the MCP tool [`rig_setup`](mcp-tools.md#rig_setup) returns them.

| Step | Dashboard text | Detail |
| --- | --- | --- |
| `model_started` | Model download started | `<name> from <host>` and its size |
| `model_done` | Model downloaded, its SHA-256 checked | `<name>: <size>` |
| `model_refused` | Model refused: its SHA-256 did not match, and the file was deleted | `<name>:` and why |
| `model_failed` | Model download stopped | `<name>:` and why |

### The rig's page

In the block **The rig**, the **Models** row shows the newest 5 downloads: `llama-8b: downloading, 3.2 GB of 16.1 GB (19%)`, `llama-8b: 16.1 GB, its SHA-256 checked`, or, in red, `refused. Its SHA-256 did not match. The file was deleted.` or `stopped.` and why. The row shows only when the supervisor reported a download. Press **refresh** in the status bar to see it move.

## Errors

The assignment fails with `staging:` and one of these. Its command shows `failed` on the dashboard and over the API.

| Error | Why |
| --- | --- |
| `model <name> from <url> refused: its SHA-256 is <sha256>, not the signed <sha256>. The file was deleted` | The file is not the one the contract names |
| `not enough free space for model <name>: it needs <size> more, and <size> is free where it goes (the inbox's models)` | Too little free space where the file goes |
| `not enough free space for model <name>: the download stopped after <size>, with <size> free where it goes (the inbox's models), and the rig keeps <n> GiB free (THERMITE_DISK_FLOOR_GIB). What it had downloaded was deleted` | The download reached the rig's [disk floor](settings.md#places-and-advisors) as it wrote, which a server that gives no size can do. The supervisor looks at the free space after each MiB |
| `<url>: HTTP <status>` | The server refused the file. For Hugging Face, with what to do, as above |
| `<url>: the download broke after <size> (<why>). The next try continues from there` | The connection broke. The part is kept |
| `<url>: the download ended after <size> of <size>. The next try continues from there` | The server sent less than it said |
| `<url>: a redirect from HTTPS to plain HTTP is refused` | The server sent the download to an unencrypted address |
| `<url>: more than 10 redirects` | Too many redirects |

A URL in a message is its scheme, host and path only, so a signed address's query never shows.

## Limits

- **The assignment's time to live.** The assignment waits for its downloads, and expires like every command: after 60 minutes by default, and at most after 7 days (`thermite assign --ttl`, or `ttl_minutes` over the API). A download that takes longer goes on, and its file stays, but the harness refuses the expired assignment. Start the run again: the file is found and checked, not downloaded again. For a large model, give a longer `--ttl`.
- **Disk.** The file takes its size twice, as [Where the file goes](#where-the-file-goes) says.
- **One file per import**, as above.
- **The Hugging Face token** reaches only a supervisor whose deployment gives it the file. Control does not hand it to rigs. The rigs that control sets up take no such setting yet ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)).
