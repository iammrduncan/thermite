---
title: "Manage MCP servers"
description: "Read an MCP server's state and tools, read them again, sign in again, change its secret or address, or delete it, on the dashboard, over REST, MCP or the command line; and what became of an outside knowledge base at the update to 0.1.0."
type: how-to
sidebar:
  order: 5
---

This page is for an MCP server that is already in **Settings › Providers**: how to see whether it works, keep it working, change it and remove it. To add one and give it to a campaign's agents, see [Give agents MCP tools](../campaigns/give-agents-mcp-tools.md).

## Before you start

- You are signed in to the dashboard, or you have the owner's token for the REST API, MCP or the command line. Only the owner adds, changes or deletes a server. An operator's or a reader's token may list them over MCP.

## See whether a server works

Press the cog icon, **Settings**, at the foot of the sidebar. The block **MCP servers** has one row for each server:

- its name and how it signs in: `gbrain · key in a header`;
- its state: `Connected · 31 tools · read 3m ago`, `Its tools are not read yet. Press Read tools again.`, or, in red, `Not signed in yet. Sign in to read its tools.`, `The sign-in ended. Sign in again.` or the last error and when it came, such as `the server answered 401: check the key (3m ago)`;
- its address; the end of its secret (`Authorization · key …c41b`, `client thermite-control · secret …9d0e`), `signed in · the sign-in renews itself`, `OAuth sign-in ended`, `not signed in yet`, or `no secret`, and `not HTTPS` for an `http://` address;
- the kits that name it, `named by q4-gemv-kit`, or `no kit names it`.

Open the row to see its tools, each with what it does and **reads** or **writes**, from the server's own hints. A server that fails and that a kit names also says `q4-gemv-kit names it. Runs that use that kit go on without its tools until it works again, and their history says so.`

## Read its tools again

Press **Read tools again** on the row. Control reads the server's tools with its sign-in and calls none of them. The block says, for example, `gbrain answers. Control read 31 tools, and called none of them. Next: name it in a kit, on a campaign's How to measure step.`, or **Not done.** and the reason.

## Sign in again

An OAuth server shows **Sign in ↗** until it is first signed in, **Sign in again ↗** when its sign-in ended (the server refused to renew it), and **Sign in again with another account ↗** inside its row when it works. Press it: a new tab opens the server's sign-in page. Allow Thermite there; the tab comes back to **Settings**. Control renews an OAuth sign-in by itself while the server lets it, when less than five minutes of its access token are left.

## Change a server

Open its row, change the fields and press **Save and read its tools**:

- **MCP URL.** The same server (the same address up to its path) keeps its secret. Another server needs the secret again: `Another address or sign-in needs the key again: paste its value.`
- **Header** and **New value**, for a key; **Client ID**, **New client secret** and **Scopes**, for a client. A secret left empty keeps the one you gave. A new one replaces it at once.
- **Client ID**, for OAuth. A new client ID, like a new address, ends the sign-in: the block says `notion is saved. Sign in again: its address or client changed.`

The **Name** can't change: add a server with the new name, name it in the kits, then delete the old one.

## Delete a server

Open its row and press **Delete this server**. Control forgets its secrets and its sign-in; nothing changes on the server. While a kit names the server, the button is off, and the row says `q4-gemv-kit names it. Take it out of that kit first.`

## The same, without the dashboard

| Task | REST (owner's token) | MCP (owner's token) | Command line |
| --- | --- | --- | --- |
| List | `GET /v1/mcp-servers` | [`mcp_servers`](../../reference/mcp-tools.md#mcp_servers) (also the operator's and the reader's) | `thermite mcp list` |
| Add | `POST /v1/mcp-servers` | `mcp_server_add` | `thermite mcp add NAME --url URL --auth KIND …` |
| Change | `PUT /v1/mcp-servers/{name}` | `mcp_server_change` | `thermite mcp change NAME …` |
| Read its tools again | `POST /v1/mcp-servers/{name}/check` | `mcp_server_check` | `thermite mcp check NAME` |
| Sign in again (OAuth) | `POST /v1/mcp-servers/{name}/sign-in` | `mcp_server_sign_in` | `thermite mcp sign-in NAME` |
| Delete | `DELETE /v1/mcp-servers/{name}` | `mcp_server_delete` | `thermite mcp delete NAME` |

Adding an OAuth server, or signing in again, answers with the address of the server's sign-in page: open it in a browser within 15 minutes. On the command line, secrets come from files, never from the command itself:

```sh
printf 'Bearer %s' "$BRAIN_TOKEN" > brain.secret
npx thermite mcp add gbrain --url https://brain.example.com/mcp --auth key \
  --secret-file brain.secret --control https://control.example.com --token-file owner.token
```

It prints the server's line, `gbrain  key …c41b  ok  31 tools  https://brain.example.com/mcp`, and its tools. [The REST API](../../reference/rest-api.md#mcp-servers), [MCP tools](../../reference/mcp-tools.md#mcp_servers) and [the command line](../../reference/command-line.md) list every field.

## What a rig gets

A rig's supervisor asks control for its MCP servers on the same beat as its model route (`THERMITE_MODEL_ROUTE_POLL_SECONDS`, 30 seconds by default). With the [message bus](../../explanation/how-the-parts-talk.md#config-over-the-message-bus), it asks nothing: control looks every 5 seconds and writes the rig's servers to its config there when they change, sealed to the rig, and the supervisor hands them over as soon as they come. Either way, control gives the servers that the runs it assigned that rig name, each with its sign-in as headers, and the servers they name that it can't give, with why (`Settings has no MCP server of that name now`, or `control can't sign in to it: …`). The supervisor hands the harness the servers its workers and planner use, and keeps the advisors' in memory. Control writes `mcp_servers_handed` to its audit log, with the servers' names, when what a rig gets changes. A run's first plan and trial wait up to 2 minutes for the harness to hold its servers: see [Before the first trial](../campaigns/give-agents-mcp-tools.md#before-the-first-trial).

## After the update from an outside knowledge base

Before 0.1.0, control could keep an **outside knowledge base**: an MCP server it copied campaign collections to, and that a campaign's teachers could search. At the update to 0.1.0, control changed each one, once, when it first started:

- It became an MCP server with a key: the header `Authorization`, with the value `Bearer` and its token. The token is kept. Its name became lowercase letters, digits and dashes (`team.brain` became `team-brain`).
- Control stopped copying campaign folders to it. The pages it wrote there stay on the server.
- The campaigns' grants to search it went. A kit names the server now: name it in the kits of the campaigns whose agents should use it.
- Control wrote `outside_kb_migrated` to its audit log for each one, with its old and new names, whether its token was kept, the copies that stopped and the grants it removed.

**Settings** shows a note, **The outside knowledge base is now an MCP server**, until you press **Got it**, and the server's row says `Moved here from the outside knowledge base at the update to 0.1.0, with its token.` Press **Read tools again** to read its tools with their descriptions. A token that could not be opened at the update shows `Its token could not be opened at the update. Enter the key again.`: paste the value in **New value**.
