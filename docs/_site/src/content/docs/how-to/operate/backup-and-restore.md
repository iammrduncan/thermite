---
title: "Back up and restore control"
description: "Back up control's state and every rig's events with thermite backup, restore them with thermite restore, and keep each rig's ledger, under compose, on machines, on clusters and on RunPod."
type: how-to
sidebar:
  order: 12
---

This page backs up control and puts a backup back: control's store, keys, kits and exports, and every rig's events, which control keeps on its [message bus](message-bus.md). It also says what else to keep, where, and how to keep each rig's ledger wherever the rig runs. Do it before an update, and as often as you can't afford to lose what control knows. [`thermite backup`](../../reference/command-line.md#backup) and [`thermite restore`](../../reference/command-line.md#restore) list every option.

```sh
docker compose --profile backup run --rm backup thermite backup /backups   # Docker
podman compose --profile backup run --rm backup thermite backup /backups   # Podman
```

## What to keep, and where

| What | Where it is | How it is kept |
| --- | --- | --- |
| Control's state: `control.db`, its keys, the bus's certificate authority, the backup's key on the bus, the kits control keeps and the exports rigs send it | Control's state folder, `/var/lib/thermite-control`: the `control-state` volume under compose | `thermite backup` |
| Every rig's events: the bus's `EVENTS` stream, which control's records are applied from | The bus's store, `/data` in the `nats` service: the `nats-data` volume | `thermite backup`, by the server's snapshot, after the store |
| The secrets key, when control keeps it elsewhere (`THERMITE_CONTROL_SECRETS_KEY_FILE`) | Where you mounted it | By you, with each backup: without it, the sealed keys and sign-ins in `control.db` do not open |
| The tokens | `.dev/secrets/` next to `compose.yaml`, or only their hashes in `.env` | By you: they are files you made |
| Each rig's ledger: everything the rig recorded | The rig's harness state | A full export: [Keep a rig's ledger](#keep-a-rigs-ledger) |
| The champions' code | The [results repository](results-repository.md), or control's exports | Your Git host; control's exports are in its backup |

A backup leaves out what control makes again as it starts: the bus's other streams (`REPORTS`, an inbox whose pages a rig sends again; `COMMANDS`, which control publishes again from its store; `LIVE`, the newest live lines; `CONFIG`, which control writes again), the files it writes for the bus's server (`nats-config`), and its public files (`control-pub`).

A backup holds control's signing key, its secrets key and the bus's certificate authority: whoever has it can act as control. Keep it as you keep control's state.

## Before you start

- The stack from [Install on one machine](../install/one-machine.md), started at least once with this version: control makes the backup's key on the bus, `bus-backup.seed`, as it starts.
- The folder `.dev/backups/` next to `compose.yaml`. `docker compose run --rm init` makes it, as at each update; in a checkout of the source code, `npm run dev:init`.
- Room for the backup: about the size of `control.db` and its exports, and about 65 bytes for each event on the bus (500,000 events made a snapshot of 32 MB).
- With Podman, write `podman compose` where the steps say `docker compose`.

## Back up control

1. Run the backup. Control may go on running.

   ```sh
   docker compose --profile backup run --rm backup thermite backup /backups   # Docker
   podman compose --profile backup run --rm backup thermite backup /backups   # Podman
   ```

   It prints each step, and ends with the backup's folder:

   ```text
   copied control.db: schema 13, 2539520 bytes
   copied kits/: 12 files
   copied exports/: 3 files
   took EVENTS's snapshot: 48210 messages to 48210
   backup: /backups/thermite-backup-2026-10-29T10-00-00-000Z (24 files, 1 streams)
   ```

   It copies the store first, whole while control writes to it, then takes the stream's snapshot. So control's place in the stream, which the backup's store holds, is at or before the stream's end, and control, started from the backup, applies what came between.
2. Copy the folder off this machine, for example as one file:

   ```sh
   tar -C .dev/backups -czf thermite-backup-2026-10-29.tgz thermite-backup-2026-10-29T10-00-00-000Z
   ```

To tell that it worked: the last line names the folder, and the folder's name does not end in `.partial` (a backup that stopped part way keeps that end, and no restore reads it). Its `manifest.json` lists each file with its SHA-256, and under `streams` the `EVENTS` stream's `messages` and `last_seq`; under `store.positions`, control's place in it, which is at most `last_seq`.

## Restore a backup

A restore takes control back to the backup. Rigs enrolled, campaigns made and commands issued after it are not in it. The rigs' events after it come back from the rigs: each rig's supervisor sends its ledger's events again from control's place. A restore keeps what it replaces: control's files go to `replaced-<time>/` in control's state folder, and the bus's store to `replaced-<time>/` in the bus's volume. Remove those yourself once the restore is good.

The bus keeps `EVENTS` for good, and the server's restore makes a stream only where it has none of that name. So the bus's store is set aside first, with the bus stopped, and the restore then brings the stream back into an empty store.

1. Stop control and the bus. The rigs' supervisors keep their places and send again later.

   ```sh
   docker compose stop control nats   # or: podman compose stop control nats
   ```

2. Set the bus's store aside:

   ```sh
   docker compose --profile backup run --rm backup thermite restore --bus-store /bus-store /backups/thermite-backup-2026-10-29T10-00-00-000Z
   ```

   It checks every file of the backup against its manifest first, then says `the bus's store: moved aside to /bus-store/replaced-…`.
3. Start the bus alone, with room for the restore. The server's restore holds much of the stream in memory: about 1 KiB for each event, over 128 MiB. A server with less is stopped part way. Take the stream's `messages` from the backup's `manifest.json`: 2g covers about 1.9 million events.

   ```sh
   THERMITE_NATS_MEMORY=2g docker compose up -d --no-deps nats   # or: THERMITE_NATS_MEMORY=2g podman compose up -d --no-deps nats
   ```

4. Restore the backup. `--control` makes it refuse while control answers.

   ```sh
   docker compose --profile backup run --rm backup thermite restore --control http://control:8800 /backups/thermite-backup-2026-10-29T10-00-00-000Z
   ```

   ```text
   the backup of 2026-10-29T10:00:00.000Z is whole: 24 files and 1 streams as its manifest says
   EVENTS: restoring 48,210 messages; the bus's server needs about 176 MiB of memory for it
   EVENTS: restored and checked, 48,210 messages to 48,210
   control's state: control.db, control-signing.key, control-signing.pub, secrets.key, bus-ca.pem, bus-ca.key, bus-backup.seed, kits, exports moved aside to /var/lib/thermite-control/replaced-2026-10-29T12-00-00-000Z, and the backup's put back
   restored: start control, and it applies the events from its place in the stream
   ```

5. Start the bus with its own memory again, and control, with your `-f` options:

   ```sh
   docker compose up -d nats control   # or: podman compose up -d nats control
   ```

To tell that it worked: control's log, `docker compose logs control`, says `control's records go on from the events stream's place` with the `place` the backup's manifest gives under `store.positions`, and then `control's views built from the events stream`, with no `fatal` line. `/v1/health` answers 200. The rigs' pages fill again as their supervisors report, and `GET /v1/bus` says `0` under `events.apply.behind`.

### If the restore is refused

The restore checks each stream it finds after its restore against the backup's manifest: its count, its last place and its last message. A server stopped part way through a restore, for want of memory, leaves a stream that looks whole and is not, and starts with it again; the restore refuses it, naming it, and changes no file of control's:

```text
restore refused: EVENTS on the bus is not the backup's: it holds 356,496 messages to 356,496, and the backup holds 500,000 to 500,000. …
```

Go back to step 1 and give the bus more memory at step 3. The stream that was refused is kept, set aside with the store. [Troubleshoot](troubleshoot.md#a-restore-is-refused) lists the other refusals.

## Other placements of control

Thermite ships control in the compose stack. A control you run another way needs the same for `thermite backup` and `thermite restore`: control's image, which holds `thermite`; control's state folder mounted, named by `THERMITE_CONTROL_DIR` or `--state`; the bus at `THERMITE_NATS_URL` or `--bus`, reached as control reaches it, since its certificate names control's address for it; and, for `--bus-store`, the bus's store mounted, with the bus stopped. On a machine, run a container of control's image with those volumes on control's network. On Kubernetes, run a Job or a pod of control's image with control's volume claim, in control's namespace; for a restore, scale control's and the bus's Deployments to 0 first, and mount the bus's claim for `--bus-store`.

## Keep a rig's ledger

Every rig's events are on control's bus, so a backup of control holds what each rig reported. A rig's own ledger holds the same and more, such as its research archive. To keep it, ask the rig for a **Full export** under **Export** on its page ([Get a rig's results from control](exports-on-control.md)), or send [`export_now`](../../reference/signed-commands.md#export_now) with `"full": true`. A full export holds a snapshot of the ledger, and goes to the rig's results repository, or to control, whose exports a backup of control holds. The harness also copies its ledger before every migration, and keeps the two newest copies beside it ([The harness stops at start: the ledger is newer](troubleshoot.md#the-harness-stops-at-start-the-ledger-is-newer)).

Where the ledger lives, for a copy of its files with the harness stopped:

| Where the rig runs | The ledger | A copy of its files |
| --- | --- | --- |
| The compose stack | `/var/lib/thermite/ledger/` on the `harness-state` volume (`harness2-state` for `local-2`) | Stop the harness (`docker compose stop harness`), copy the volume with your engine's tools (with Podman, `podman volume export thermite_harness-state --output harness-state.tar`), then start it again |
| A machine, set up by control | The Podman volume `thermite-<rig>-state` | **Stop** on the rig's page, then on the machine `podman volume export thermite-<rig>-state --output <rig>-state.tar`, as the rig's user, then **Start** |
| A cluster, set up by control | The volume claim `thermite-<rig>-data`, subpath `state` | **Stop** on the rig's page, then a snapshot of the claim with your cluster's storage, then **Start** |
| RunPod | The pod's container disk, with a sealed snapshot on its volume | A full export only: the pod's disk goes when it stops, and **Terminate** waits until a full export reached control |
