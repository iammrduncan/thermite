---
title: "Run the message bus"
description: "Check the message bus beside control, follow control's events to it and back, see an older store's events table moved there, open its port to rigs on other machines and clusters, give it more memory or disk, and turn the rigs off it."
type: how-to
sidebar:
  order: 11
---

The message bus carries the rigs' reports and live lines to control, and control's commands and each rig's config to the rigs, as soon as each is there, and it keeps every rig's events for control, which writes its records from them. It is a NATS server with JetStream, and it runs beside control: the compose stack's `nats` service. Control needs it, and does not start without it. This page says how to tell that it works, what you see while control keeps its events there and applies them, while it moves an older store's events there, and while it makes an older reports stream again, what to open so that rigs on other machines and clusters reach it, what control keeps for its certificate, how to give it more memory or disk, and how to keep the rigs off it. [How the parts talk](../../explanation/how-the-parts-talk.md#reports-over-the-message-bus) explains what travels on it and why.

```sh
docker compose ps nats                      # or: podman compose ps nats
curl -fsS http://127.0.0.1:8800/v1/health   # {"ok":true,"loops":{…},"bus":"connected"}
```

## Before you start

- Thermite runs from the compose file of a release, or of the source code: [Install Thermite on one machine](../install/one-machine.md).
- Your owner's token, for `GET /v1/bus`.

## Check it

1. List the `nats` container:

   ```sh
   docker compose ps nats     # or: podman compose ps nats
   ```

   Its status starts with `Up` and ends with `(healthy)`: its health check asks the server, on the container's own loopback, whether it answers with JetStream on. While control has not yet written the server's users and certificate, the server waits, its log says `waiting for control to write the bus's users and certificate`, and the check fails.
2. Ask control:

   ```sh
   curl -fsS http://127.0.0.1:8800/v1/health
   ```

   `"bus":"connected"` says control holds a connection to the server now; `"away"` says it holds none and tries again every 5 seconds. Once control serves, the answer is 200 in both: control's own pages and routes serve whatever the bus does, though what control writes from the rigs' new events waits for the bus. While control starts, it builds its views from the bus's events first: its health then answers 503 with `"starting":true`, and every other route 503, until its log says `control's views built from the events stream`.
3. For the bus's streams and what each consumer still has to take, ask `GET /v1/bus` with the owner's token, or call the MCP tool `bus_state`: [The message bus](../../reference/rest-api.md#the-message-bus).

A rig on the bus has the step "Its key on the message bus registered" in its history, on its page. A rig that never got that step reports over HTTP.

## Follow control's events to the bus and back

Control keeps every rig's events on the bus's `EVENTS` stream, and nowhere else. It publishes each report's new events there, whether its rig reported over the bus or over HTTP, and answers the rig once it has applied them: from that stream, in its order, control writes what it derives from the events (a run a rig created in its run registry, a command's outcome as the harness gave it, each model call's usage, and the knowledge base's items), and its pages, REST and MCP read the rigs' events from there ([Control's events on the message bus](../../explanation/how-the-parts-talk.md#controls-events-on-the-message-bus)). When control starts, it applies the stream from the place its store applied through and builds its views from the stream's first event; only then does it serve its pages and take reports. 100,000 events took about a second to build the views from when measured.

1. Read control's log as it starts:

   ```sh
   docker compose logs control | grep "events"     # or: podman compose logs control | grep "events"
   ```

   `control's records go on from the events stream's place` says where control applies from (`place`), the stream's last place (`last`) and how many messages it has to apply (`behind`). `control's views built from the events stream` says that control's pages are ready, with the stream's place they hold (`place`), how many rigs they show (`rigs`) and how long it took (`ms`); `listening` follows.
2. Or ask the bus's state, with the owner's token:

   ```sh
   curl -fsS -H "Authorization: Bearer $(cat .dev/secrets/control-admin-token)" http://127.0.0.1:8800/v1/bus
   ```

   Under `events`, `published` counts the events of the reports control took since it started; under `events.apply`, `behind` falls to 0 while `place` climbs to `last_place`. `/metrics` has the same figures, `thermite_events_published_total` and `thermite_events_unapplied` among them.

To tell that it works: `events.apply.behind` is 0, `events.waiting` and `events.apply.stopped` are `null`, and each rig's page shows its newest events.

If `events.waiting` names a reason, such as `the bus's store is full: …`, control refused the last report for now: it took none of it but what the bus had, and the rig sends it again at its next round, as it does after any refusal for now. `events.later` counts them. Give the bus more disk (below), or bring its server back; the next report goes through, and `waiting` is `null` again.

If control stops as it starts, with `control's store is past the events stream's end` in its log and the reason `control's store has applied the EVENTS stream to place …, past its last, …`, its store holds records of events the stream no longer has, as when the bus's volume was restored from a backup older than control's store, or removed. Control does not go on with such a store: the stream's next events would be skipped. Restore the stream from a backup at least as new as the store, or the store from one no newer than the stream, and start control again.

### The first start of a store from before: its events table moved

A store from v0.1.0, or from a control that kept its events in a table and copied them to the bus, holds its events in its events table. At the first start of this version, control moves the table to the stream, checks that the stream holds it whole, and drops it, keeping a copy of the store from just before. It takes no report and serves no page until then: control's routes answer 503, `control is starting: …`. When measured against the bus at 256 MiB, 100,000 events took about 4 seconds to move, check and drop, and the whole first start, with the apply and the views, about 9 seconds.

1. Read control's log as it starts:

   ```sh
   docker compose logs control | grep "events table"     # or: podman compose logs control | grep "events table"
   ```

   `moving control's events table to the events stream` says how many rows it has to move (`behind`), and every 100,000 how far it got (`moved`) and how many are `left`. `control's events table moved to the events stream` says when it is done, in how many `seconds`; `the events stream holds control's events table whole` that the check passed; then `control's events table dropped: the events stream keeps every event`, with the copy's path (`copy`).
2. Find the copy beside the store, in control's state folder, the `control-state` volume:

   ```sh
   docker compose exec control ls -l /var/lib/thermite-control     # or: podman compose exec control ls -l /var/lib/thermite-control
   ```

   It is `control.db.v11.<time>.kept`, as large as the store was. Control keeps it until you remove it: it is the last copy of the events table, and the copies a migration makes otherwise (`control.db.v<version>.<time>.copy`, the two newest kept) never remove it. Keep it until you are sure of the stream, as after a backup of the bus's volume, then remove it.

To tell that it worked: control serves its pages, each rig shows the events it showed before, and under `streams` in `GET /v1/bus` the `EVENTS` stream holds at least as many messages as the table had rows. A second start moves nothing: its log has none of the lines above.

If the move can't end with the stream holding the table whole, control stops at start, says why in a `fatal` line, and the table stays: [Troubleshooting](troubleshoot.md#control-stops-at-start-its-events-table-cant-go-to-the-events-stream) says what to do. While the bus is away or its store is full, the move waits and tries again every 5 seconds: its log says `control's events table not moved yet; trying again`.

### The first start on an older reports stream: made again as an inbox

The `REPORTS` stream keeps a rig's report only until control has taken it or refused it for good ([Reports over the message bus](../../explanation/how-the-parts-talk.md#reports-over-the-message-bus)). A bus that a control from before used holds a `REPORTS` stream that keeps every report for good, which the server can't change in place. The first time control starts with this version, it makes that stream again, once: it takes the stream's subjects off it, its consumer takes every report the stream still holds, as before, and then control removes the stream and makes it again as an inbox. No report is lost. When measured, with three reports left in the stream, it took about 30 milliseconds; a report a control stopped part way had in hand is handed again only after 30 seconds.

1. Read control's log as it starts:

   ```sh
   docker compose logs control | grep "work queue"     # or: podman compose logs control | grep "work queue"
   ```

   `the stream becomes a work queue: its consumer takes what it holds first` names the stream (`REPORTS`) and how many reports it held (`held`), the ones control took already among them; `the stream emptied and removed, to be made again as a work queue` says that control has taken the last of them. `stream made` follows.
2. A supervisor that publishes a report meanwhile finds no stream for it. Its log says so, and it keeps its cursor:

   ```sh
   docker compose logs supervisor | grep "relay error"     # or: podman compose logs supervisor | grep "relay error"
   ```

   The line's `error` is `no stream on the bus takes thermite.rig.<rig>.report yet: control makes it`. At its next round after the stream is made, the supervisor publishes the same reports again, and control takes them.

To tell that it worked: under `streams` in `GET /v1/bus`, `REPORTS` holds few messages or none, and its count falls back after each round; each rig's page shows its newest events. A second start makes nothing again: its log has none of the lines above.

## Let rigs on other machines reach it

A rig that control sets up on a machine or a cluster, or that you join yourself, reaches the bus from outside the compose stack, on NATS's own port, 4222, over TLS. Compose publishes the port on this computer's `127.0.0.1` only. To open it:

1. Publish it on the computer's addresses. In `.env`:

   ```sh title=".env (part)"
   THERMITE_NATS_PUBLISH=0.0.0.0:4222
   ```

   Or give one address of the computer in place of `0.0.0.0`.
2. Let the rigs' machines and clusters reach TCP port 4222 on this computer, in its firewall and in any firewall between them. Unlike control's port, the bus needs no reverse proxy: its TLS is its own.
3. If the rigs reach the bus at another name or port than control's address for rigs (`THERMITE_CONTROL_PUBLIC_URL`) and 4222, name it in `.env`:

   ```sh title=".env (part)"
   THERMITE_NATS_PUBLIC_URL=nats://bus.example.com:4222
   ```

   Control gives this address to every rig it sets up, and names its host in the server's certificate.
4. Start the stack again, with your `-f` options:

   ```sh
   docker compose up -d     # or: podman compose up -d
   ```

Each rig set up from then on gets the bus's address and the certificate of control's authority with its other files. A rig set up before gets them when it moves onto new images (**Update to** control's version, or **Update to these images** on a cluster): until then, it reports over HTTP as before.

To tell that it worked: from a rig's machine, `nc -zv control.example.com 4222` connects, and the rig's page shows "Its key on the message bus registered". A rig that can't reach the port never reports: its setup ends with "no report after 10 minutes", and its supervisor's log says `following failed; trying again` or `making the stream failed; trying again`.

## The certificate

Every connection to the bus is over TLS. Control keeps its own certificate authority for it, beside its signing key in its state folder (the `control-state` volume): `bus-ca.pem` and `bus-ca.key`. It makes them at its first start with the bus, valid for 10 years, and signs the server's certificate with them:

- **The server's certificate** names the hosts control and the rigs reach the bus by: `nats`, and the host of `THERMITE_NATS_PUBLIC_URL` or of control's address for rigs. It is valid for 397 days. Control makes a new one when the names change, and when the certificate ends within 30 days; the server takes it without a restart, and the rigs' connections stay. Control's log says `the bus's server certificate made`.
- **The rigs** trust the server through the authority's certificate alone, which control gives each rig it sets up: as a file on a machine and in the compose stack, in the supervisor's environment on a cluster. A connection that does not come from such a rig, or that trusts another authority, is refused, and so is one without TLS.

Keep `bus-ca.key` with control's other state: a backup of the `control-state` volume holds it. If it is lost, delete `bus-ca.pem` too and start control again: it makes a new authority, and every rig on the bus needs its certificate again, by moving onto new images. Until then those rigs can't connect.

## Give it more memory or disk

The bus keeps its messages on disk, on the `nats-data` volume. The `EVENTS` stream keeps every rig's events for good, so the store grows with the rigs' history. Its memory holds the index of each stream's subjects and the blocks a read loads. Compose gives it 256 MiB, and tells the server's Go runtime 78% of that, so that it frees what a read loaded before the limit is reached. Its disk is 75% of the volume's free space when it starts.

1. In `.env`, set either or both:

   ```sh title=".env (part)"
   THERMITE_NATS_MEMORY=512m
   THERMITE_NATS_STORE=20G
   ```

   Keep `THERMITE_NATS_STORE` under what the disk has free: at the limit, the bus refuses new messages and keeps the old, but a server whose disk itself is full turns JetStream off.
2. Start the stack again, with your `-f` options:

   ```sh
   docker compose up -d     # or: podman compose up -d
   ```

To tell that it worked: the server's log as it starts, `docker compose logs nats`, says `Max Memory` at 75% of what Go is told (149.76 MB for 256 MiB), and `Max Storage` at the store's size (`20G` shows as 18.63 GB).

Control keeps 5 GiB of the store free, `THERMITE_DISK_FLOOR_GIB`: with less left under its limit, it starts no new run until there is room ([Control's disk is at its floor](troubleshoot.md#controls-disk-is-at-its-floor)). A [restore](backup-and-restore.md#restore-a-backup) needs more memory than the bus's own for its run: about 1 KiB for each event, over 128 MiB.

## Keep the rigs off it

Control always uses its bus: it keeps every rig's events there. A rig may still report over HTTP, and take its commands and config from control's API, as Thermite did before the bus: control keeps its events on the bus all the same. To keep the compose stack's own rigs off the bus, set `THERMITE_NATS_URL` to nothing in `.env`, then start the stack again:

```sh title=".env (part)"
THERMITE_NATS_URL=
```

Both of the stack's supervisors then report over HTTP. Control stays on the bus, and `/v1/health` still says `"bus":"connected"`. The line never reaches control: its own `THERMITE_NATS_URL` is fixed in the compose file. Take the line out of `.env` and start the stack again to put the rigs back on the bus.

Set it before the rigs' first start. A rig whose supervisor has registered its keys on the bus gets its model routes, MCP servers and advisors' routes only there, sealed to its key: control refuses them over HTTP with `<rig> is on the message bus: control gives it its model routes, MCP servers and advisors' routes only in its config there, …`, which the supervisor's log shows as `model route error`.

A rig that control sets up on a machine or a cluster gets the bus's address with its other files, and reports over the bus: open the bus's port to it ([Let rigs on other machines reach it](#let-rigs-on-other-machines-reach-it)). A rig whose supervisor has no `THERMITE_NATS_URL`, such as one you join yourself without it, reports over HTTP.

A rig on RunPod never uses the bus: control reaches it in [pull mode](../../explanation/trust.md#rigs-in-pull-mode), and keeps its events on the bus as it keeps any rig's.

A control without `THERMITE_NATS_URL` stops at start, with `control needs its message bus: set THERMITE_NATS_URL to its NATS server, such as nats://nats:4222. …` in its log.
