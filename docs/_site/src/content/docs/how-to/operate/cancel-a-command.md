---
title: "Cancel a pending command"
description: "Withdraw a signed command that has not reached its rig yet, with the REST API."
type: how-to
sidebar:
  order: 8
---

Everything you or an agent asks a rig to do travels as a [signed command](../../reference/signed-commands.md). Control publishes it on the message bus, and it stays **pending** until the harness's outcome reaches control: the rig's supervisor takes it from the bus within a second and hands it to the harness, and the harness's record of it comes back in the rig's next report, within a minute by default. A command stays pending longer when the rig is off the bus or not reporting, while control holds it because the bus did not take it, or while its supervisor fetches what the command needs, such as a large project or a model. While a command is pending, the owner can cancel it, though one the harness has applied already takes effect all the same.

Cancelling is possible only with the REST API and the owner's token. The dashboard, MCP and the `thermite` command line have no way to do it yet ([goal 029](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/029-api-mcp-coverage.goal)).

The examples use the owner's token file of the local stack, `.dev/secrets/control-admin-token`. If you made an owner's token of your own, use its file instead. They also use the local stack's address, `http://127.0.0.1:8800`: for a control on another computer, use its address, such as `https://control.example.com`.

## 1. Find the command's id

List the newest commands, with their status:

```sh
curl -sS -H "Authorization: Bearer $(cat .dev/secrets/control-admin-token)" \
  "http://127.0.0.1:8800/v1/commands?limit=10"
```

Each command has an `id`, its `rig`, its `kind` and its `status`. Look for the one with `"status":"pending"`:

```text
{"commands":[{"id":"0b6d3e52-6f1a-4c2e-9a57-3f4e1d2c8b90","rig":"rig-1","kind":"assign_campaign","issued_by":"owner:ui","issued_at":"…","status":"pending","acked_at":null,"outcome":null}, …]}
```

You can also find the id elsewhere:

- The command that issued it printed it, for example `thermite command` or `thermite assign`: `{"id":"…","status":"pending"}`.
- Over MCP, the `list_commands` tool lists commands with their ids.
- On the dashboard, **Commands** in the sidebar lists every command with its status but not its id. **Audit log**, also in the sidebar, shows the id in the detail of the `command_issued` entry.

## 2. Cancel it

```sh
curl -sS -X POST -H "Authorization: Bearer $(cat .dev/secrets/control-admin-token)" \
  http://127.0.0.1:8800/v1/commands/0b6d3e52-6f1a-4c2e-9a57-3f4e1d2c8b90/cancel
```

- `{"cancelled":true}`: control withdrew it, and took it off the message bus, so the rig will never receive it unless its supervisor had taken it already.
- `404 {"error":"no such pending command"}`: it is no longer pending. The rig's report with its outcome reached control, or it expired or was cancelled before. Its status says which.

## Check the result

```sh
curl -sS -H "Authorization: Bearer $(cat .dev/secrets/control-admin-token)" \
  http://127.0.0.1:8800/v1/commands/0b6d3e52-6f1a-4c2e-9a57-3f4e1d2c8b90
```

A cancelled command shows `{"status":"failed","outcome":{"cancelled_by":"owner:api"}}` over REST and MCP: there is no separate "cancelled" status. On the **Commands** page it shows as **cancelled**, in a grey chip, with `cancelled_by` in its **Outcome**. **Audit log** has a `command_cancelled` entry.

The rig still applies it if its supervisor had taken it from the bus before you cancelled: a command is pending until the rig's report with its outcome comes, up to a minute after the harness applied it. The command's status then changes to `delivered` at that report.

## Commands also expire

Each command has a lifetime: 60 minutes by default, set with `ttl_minutes` (REST, MCP) or `--ttl` (the command line), up to 7 days. Sending a champion to another rig lives 24 hours, and the steps of a full reset 30 minutes. A command still pending at the end of its lifetime is never delivered: the harness refuses it, and the supervisor does not hand it over. Control marks it `expired` within 10 seconds of its expiry, as it looks at every rig's pending commands. Cancel a command when you don't want it to run even if the rig comes back within its lifetime.

A pending command also holds up a [full reset](rig-lifecycle.md#fully-reset-a-rig) of its rig: cancel it to let the reset go on.
