---
title: "Accept a rig's key"
description: "Compare a rig's key fingerprint with the rig's own and accept it, so control takes the rig's reports again."
type: how-to
sidebar:
  order: 2
---

Every report a [rig](../../reference/glossary.md) sends is signed with the rig's own key. Control **pins** that key: it remembers it and refuses reports signed with any other. When a key needs your word, control holds it, and refuses the rig's reports until you accept it. This page shows how to check a held key and accept it.

## When control holds a key

- **A rig's key changed.** Control always holds a new key for you. A rig keeps its key through restarts and through a [full reset](rig-lifecycle.md#fully-reset-a-rig), so a new key means that the rig's harness lost its state volume, or that something else reports under the rig's name.
- **A new rig's first key, if you ask for it.** By default, control pins the key of a rig's first report without asking. Set `THERMITE_CONTROL_REQUIRE_KEY_ACCEPT=1` on control to hold every new rig's first key for you instead. On the local stack, put `THERMITE_CONTROL_REQUIRE_KEY_ACCEPT=1` in a `.env` file next to `compose.yaml`, then run `docker compose up -d` (or `podman compose up -d`), with your `-f` options if you start the stack with override files.

While a key waits, you see it in three places:

- **Rigs**, in the dashboard's sidebar on the left: the rig has the chip **Key to accept**.
- **Needs you**, on **Overview**, the first page in the sidebar: a **New key** item asks "Accept a new rig's report key?" or "Accept this rig's new report key?".
- **The rig's page**: a card titled "This rig's first report key waits for your acceptance" or "This rig now signs its reports with a different key", with the fingerprint and an **Accept this key** button.

Meanwhile control takes none of the rig's reports, so it shows nothing new from the rig. A new rig says `none yet` under **Last report** on **Rigs**. A rig that reported before also shows in **Needs you** under **Not reporting**. The rig's supervisor logs `relay error` with `the rig's key waits for the owner's acceptance` or `rig key changed: the owner must accept the new key`.

## 1. Read the fingerprint that control shows

Open the rig's page, or the **New key** item. The fingerprint is 16 hexadecimal characters, for example `1a2b3c4d5e6f7a8b`.

## 2. Read the rig's own fingerprint

The card asks you to check the fingerprint "with the rig's deployment". The rig's harness logs its fingerprint each time it starts, in a line with the message `the rig's report key`, for example `{"at":"2026-10-30T05:10:00.000Z","level":"info","component":"harness","msg":"the rig's report key","rig":"rig-1","fingerprint":"1a2b3c4d5e6f7a8b"}`. Read it from the harness's log:

```sh
# The local compose stack, from the repository folder (harness-2 for the second rig)
docker compose logs harness | grep "the rig's report key" | tail -n 1

# A rig on a machine: log in over SSH as the user the rig runs as (with sudo for a rig that runs as root)
podman logs thermite-rig-1-harness 2>&1 | grep "the rig's report key" | tail -n 1

# A rig on a Kubernetes cluster
kubectl logs -n <namespace> deployment/thermite-rig-1-harness | grep "the rig's report key" | tail -n 1
```

A harness that has run a long time may have rotated its start's line out of its log. Then work the fingerprint out from the key itself. It is the first 16 hexadecimal characters of the SHA-256 of the rig's public key, which the rig's harness container keeps in `/var/lib/thermite/ledger/rig-signing.key.pub`:

```sh
# The local compose stack
docker compose exec harness sh -c 'printf %s "$(cat /var/lib/thermite/ledger/rig-signing.key.pub)" | sha256sum | cut -c1-16'

# A rig on a machine
podman exec thermite-rig-1-harness sh -c 'printf %s "$(cat /var/lib/thermite/ledger/rig-signing.key.pub)" | sha256sum | cut -c1-16'

# A rig on a Kubernetes cluster
kubectl exec -n <namespace> deployment/thermite-rig-1-harness -- sh -c 'printf %s "$(cat /var/lib/thermite/ledger/rig-signing.key.pub)" | sha256sum | cut -c1-16'
```

With Podman's compose, use `podman compose logs` and `podman compose exec`. On a machine, log in as the rig's user itself, not with `sudo -u`: rootless Podman needs that user's own session. If `podman` then complains about its runtime directory, run `export XDG_RUNTIME_DIR=/run/user/$(id -u)` first. On a cluster, the rig's page shows its namespace: under **Namespace** in the **Set up by control** block, or under **Where** in the **You run it yourself** block.

Either way you have 16 characters. They must be the same as the ones control shows.

:::caution[If they differ]
Don't accept the key. Its reports then stay refused, which is safe. Something other than your rig may be reporting under its name: find out what before you go on.
:::

## 3. Accept the key

On the dashboard, press **Accept this key** on the rig's page or in the **New key** item. You land on the rig's page, and the card is gone.

Control accepts only the key whose fingerprint the page showed you. If the rig sent yet another key in the meantime, nothing changes and the card is still there: check the new fingerprint.

With the REST API and the owner's token. The examples use the owner's token file of the local stack, `.dev/secrets/control-admin-token`. If you made an owner's token of your own, use its file instead.

```sh
curl -sS -X POST -H "Authorization: Bearer $(cat .dev/secrets/control-admin-token)" \
  "http://127.0.0.1:8800/v1/rigs/rig-1/key/accept?fingerprint=1a2b3c4d5e6f7a8b"
```

It answers `{"accepted":true}`. A fingerprint that doesn't match, or a rig with no key waiting, gets `404 {"error":"no pending key"}`. Accepting a key is the owner's alone: there is no MCP tool or `thermite` command for it.

## Check that it worked

- Within a minute, at the rig's next report, the rig's chip on **Rigs** says **Live**, and its runs come back.
- On the rig's page, the **Key** row of the **The rig** block shows the fingerprint you accepted.
- **Audit log**, in the sidebar, has a `rig_key_accepted` entry, with actor `owner:ui` (the dashboard) or `owner:api` (REST).

[Trust between control and rigs](../../explanation/trust.md) explains why reports are signed and keys are pinned.
