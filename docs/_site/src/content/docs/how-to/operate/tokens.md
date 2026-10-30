---
title: "Make and change tokens"
description: "Make the owner's token, give people and agents tokens of their own, replace a token, and manage rig tokens."
type: how-to
sidebar:
  order: 7
---

Control knows people and programs by **tokens**: long random strings, each with one role. You make a token on your own computer, keep it, and give control only its SHA-256. The machine control runs on then holds nothing that signs in. This page makes, replaces and ends tokens. [Tokens and roles](../../reference/tokens.md) says what each role may do.

| Role | Control's setting | Typical holder |
| --- | --- | --- |
| Owner | `THERMITE_CONTROL_ADMIN_TOKEN_SHA256`, or `THERMITE_CONTROL_ADMIN_TOKEN_FILE` as on the local stack. Control needs one of them | You. The only token that signs in to the dashboard and works on the whole REST API |
| Operator | `THERMITE_CONTROL_OPERATOR_TOKEN_SHA256` | An AI agent that runs campaigns for you over MCP |
| Agent | `THERMITE_CONTROL_AGENT_TOKEN_SHA256` | An agent that only reads and steers over MCP |
| Reader | `THERMITE_CONTROL_READ_TOKEN_SHA256` | A metrics scraper such as Prometheus, or an agent that only watches. It can't sign in to Thermite's dashboard |

## Before you start

- The `thermite` command line on your computer. Run `npx thermite` in the folder you built it in (see [the command line](../install/one-machine.md#the-command-line)).
- A way to change control's settings and restart it. On the local stack, that is your compose tool.

The local stack already has an owner's token and an operator's token: the `init` container (or, in a checkout of the source code, `npm run dev:init`) wrote them to `.dev/secrets/control-admin-token` and `.dev/secrets/control-operator-token`, and `compose.yaml` gives them to control as files. Make the others yourself.

## 1. Make a token

Make one token for each role you need. The file name is yours to choose:

```sh
npx thermite token new --out ~/thermite-agent-token
```

It prints:

```text
wrote the token to /home/you/thermite-agent-token
sha256 <64 hexadecimal characters>
Deploy control with the hash as THERMITE_CONTROL_<ROLE>_TOKEN_SHA256, where ROLE is ADMIN (the owner), OPERATOR, AGENT or READ.
```

The token is only in that file, which only you can read. Keep it, for example in a password manager. `token new` never overwrites a file: `… exists; a token is never overwritten`.

## 2. Give control the hash

Set the role's `_SHA256` setting to the printed hash, and restart control. On the local stack, `compose.yaml` doesn't pass these settings on, so put them in the override file `compose.tokens.yaml` next to it. [Install Thermite on one machine](../install/one-machine.md#use-an-owners-token-of-your-own) makes that file for the owner's token; if you have it, add the line to its `environment`:

```yaml title="compose.tokens.yaml"
services:
  control:
    environment:
      THERMITE_CONTROL_AGENT_TOKEN_SHA256: "<the 64-character hash>"
```

```sh
docker compose -f compose.yaml -f compose.tokens.yaml up -d   # or: podman compose -f … -f … up -d
```

Compose starts control again with the new setting. From now on, name every override file you use, each with its own `-f`, on every `up` (for example `-f compose.yaml -f compose.tokens.yaml -f compose.results.yaml`): a file left out drops its settings. [Install Thermite on one machine](../install/one-machine.md#settings-and-override-files) lists every override file and gives the full command. Check control's log with `docker compose logs control`: after the restart it has a `listening` line. If control keeps restarting instead, its log has a `fatal` line that says why:

| Message | Cause |
| --- | --- |
| `set THERMITE_CONTROL_AGENT_TOKEN_SHA256 or _FILE, not both` | A role has both settings |
| `the admin, operator, agent and read tokens must all be different` | Two roles have the same token |
| `a token hash is 64 hexadecimal characters` | The hash was cut or has a space in it |
| `control needs the owner's credential` | Control has no owner's token, for example because its file is empty and the start left out the override file |

## 3. Hand the token over

Give the token file to whoever will use it:

- Operator and agent tokens work only over MCP. See [Let an agent run Thermite over MCP](../automate/agent-over-mcp.md).
- A reader's token works over MCP, and on six read-only REST routes: `/metrics`, `GET /v1/usage`, `GET /v1/model-prices`, `GET /v1/kits`, `GET /v1/kits/<name>` and a rig's live log (`GET /v1/rigs/<rig>/live`). To see that it works:

  ```sh
  curl -sS -H "Authorization: Bearer $(cat ~/thermite-read-token)" http://127.0.0.1:8800/metrics | head -3
  ```

  Its first line starts with `# HELP thermite_rig_up`.

## Replace or end a token

To **replace** a token, make a new one, put its hash in the same setting, and restart control. The old token stops working as soon as control starts again. A new owner's token signs every browser out of the dashboard: sign in again with the new one.

On the local stack, the owner's and the operator's tokens start as files (`THERMITE_CONTROL_ADMIN_TOKEN_FILE` and `THERMITE_CONTROL_OPERATOR_TOKEN_FILE`):

- **The owner's token:** follow [Use an owner's token of your own](../install/one-machine.md#use-an-owners-token-of-your-own).
- **The operator's token:** in `compose.tokens.yaml`, empty its `_FILE` setting and set its hash. Control refuses to start when both are set.

  ```yaml title="compose.tokens.yaml"
  services:
    control:
      environment:
        THERMITE_CONTROL_OPERATOR_TOKEN_FILE: ""
        THERMITE_CONTROL_OPERATOR_TOKEN_SHA256: "<the new hash>"
  ```

  Then empty the old file, so that a start without the override doesn't accept the old token, and start the stack with both `-f` options:

  ```sh
  : > .dev/secrets/control-operator-token
  docker compose -f compose.yaml -f compose.tokens.yaml up -d
  ```

  Leave the empty file in place: compose still mounts it.

To **end** a token, remove its setting and restart control. On the local stack, end the operator's token by emptying its file as above, without setting a hash. The owner's token can't be ended, only replaced: control doesn't start without it.

## Rig tokens

Each rig has its own token, which its supervisor uses to report to control. The `rig` commands below need the owner's token. The examples use the owner's token file of the local stack, `.dev/secrets/control-admin-token`. If you made an owner's token of your own, use its file instead.

- **Rigs control sets up** with **Add a rig**, or with a join command, get a token by themselves. See [Add a rig on a machine over SSH](../install/rig-on-a-machine.md) and [Join a rig yourself](../install/join-a-rig.md).
- **Enroll a rig yourself** with the owner's token. Control makes the rig's token, and the command writes it with the rig's other files into a new folder:

  ```sh
  npx thermite rig add rig-1 --control https://control.example.com \
    --token-file .dev/secrets/control-admin-token --out rig-1-files
  ```

  It prints `enrolled rig-1; control's key fingerprint …` (the fingerprint of control's own key, not the rig's) and each file it wrote. `rig-1-files/README.txt` says which setting reads each file. Thermite ships no deployment that reads this folder, so starting a rig from it is not supported yet ([goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal)). Use **Add a rig** on the dashboard instead.

- **Replace a rig's token** when it may have leaked:

  ```sh
  npx thermite rig token rig-1 --control https://control.example.com \
    --token-file .dev/secrets/control-admin-token --out rig-1-new-token
  ```

  It prints `rig-1 has a new token, in rig-1-new-token; its old token no longer works`. Control doesn't send the new token to the rig: put it in the file the rig's supervisor reads (`THERMITE_CONTROL_TOKEN_FILE`), and restart the supervisor. Until then the rig can't report. On a machine control set up, that file is `secrets/control-rig-token` in the rig's folder: `~/.local/share/thermite/rigs/rig-1/`, or `/var/lib/thermite/rigs/rig-1/` for a rig that runs as root. On a cluster, it is the key `control-rig-token` of the Secret `thermite-rig-1`, in the namespace that the rig's page shows. To change it there:

  ```sh
  kubectl -n <namespace> patch secret thermite-rig-1 --type merge \
    --patch-file <(printf '{"stringData":{"control-rig-token":"%s"}}' "$(tr -d '\n' < rig-1-new-token)")
  ```

  For a rig control set up, **Restart them** on the rig's page then restarts the supervisor.

- **The local stack's rigs**, `local-1` and `local-2`, are enrolled by the stack's `enroll` step at each `up`, which writes each token to `.dev/secrets/control-rig-token` (`control-rig-token-2` for `local-2`). To replace `local-1`'s token, empty its file and start the stack again; the enroll step gets a new token from control, writes it there, and the old one stops working. Then restart the supervisor, so that it reads the new token:

  ```sh
  : > .dev/secrets/control-rig-token
  docker compose up -d
  docker compose restart supervisor
  ```

  With Podman, use `podman compose`. Add your `-f` options if you start the stack with override files. A token you made with `rig token` instead goes into that file by hand: the enroll step keeps whatever token the file holds while control has the rig enrolled.

- **End a rig's token** by retiring the rig: `npx thermite rig retire rig-1 --control https://control.example.com --token-file .dev/secrets/control-admin-token`, or **Retire it** on the rig's page. See [Stop, restart, remove or reset a rig](rig-lifecycle.md#retire-and-bring-back). Bringing the rig back doesn't bring its token back; enrolling it again with `rig add` gives it a new one.

Every `rig` command needs the owner's token: any other gets `401 {"error":"unauthorized"}`.
