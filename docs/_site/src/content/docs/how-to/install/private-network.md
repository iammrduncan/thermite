---
title: "Keep Thermite on a private network: Tailscale or WireGuard"
description: "Put control and its message bus on a private network that only your machines reach, with Tailscale (recommended) or WireGuard."
type: how-to
sidebar:
  order: 2
---

Control is the one place that steers every rig, and it holds your providers' keys. Two of its ports matter once a second machine joins: the dashboard, API and MCP, which compose shows only to control's own machine at `127.0.0.1:8800`, and the [message bus](../operate/message-bus.md), port 4222, which every rig reaches. Keep both off the public internet. Put control's machine and your rigs' machines on a private network, and let only that network reach them.

We recommend [Tailscale](https://tailscale.com) for most people: it gives each machine a private name and HTTPS, with no proxy of your own and no port to open in a firewall. Use [WireGuard](https://www.wireguard.com) when you run your own network.

The bus is always TLS, signed by control's own authority, and each rig signs in with keys of its own. A private network adds a second wall: no one off it can even connect.

## With Tailscale

1. Install Tailscale on control's machine and on each rig's machine, and sign them in to the same tailnet ([Tailscale's downloads](https://tailscale.com/download)).
2. In Tailscale's admin console, under **DNS**, turn on **MagicDNS** and **HTTPS Certificates**, if they are off.
3. On control's machine, serve the dashboard to the tailnet (on Linux, with `sudo`):

   ```sh
   tailscale serve --bg 8800
   ```

   It prints the address: `https://`, the machine's name on your tailnet, and your tailnet's domain. `serve` shares it with your tailnet only. Never use `tailscale funnel` for control: it would put the dashboard on the internet.
4. Find control's machine's address on the tailnet:

   ```sh
   tailscale ip -4
   ```

5. In `.env`, next to `compose.yaml`, give control its address, and publish the bus on the tailnet address only:

   ```sh title=".env (part)"
   THERMITE_CONTROL_PUBLIC_URL=https://<the address tailscale serve printed>
   THERMITE_NATS_PUBLISH=<the address tailscale ip printed>:4222
   ```

6. Start Thermite again with them: `docker compose up -d` (or `podman compose up -d`).

To tell that it worked, from a rig's machine on the tailnet:

```sh
curl https://<the address tailscale serve printed>/v1/health
nc -zv <the machine's name on your tailnet> 4222
```

`curl` answers `{"ok":true,"bus":"connected","degraded":false}`, and `nc` connects. From a machine off the tailnet, neither connects.

Tailscale's access controls can narrow it further: let only your rigs' machines reach port 4222 on control's machine, and only your own devices the dashboard.

## With WireGuard

1. Set up a WireGuard tunnel between control's machine and each rig's machine, each with an address on the tunnel ([WireGuard's quick start](https://www.wireguard.com/quickstart/)).
2. Give control's machine a name on the tunnel that the rigs' machines resolve, in their `/etc/hosts` or your own DNS.
3. On control's machine, put a reverse proxy that listens on the tunnel address only, in front of `127.0.0.1:8800`, as [Let rigs on other machines reach control](one-machine.md#let-rigs-on-other-machines-reach-control) describes: HTTPS under that name, `X-Forwarded-Proto: https`, request bodies of up to 90 MB.
4. In `.env`, give control that name, and publish the bus on the tunnel address only:

   ```sh title=".env (part)"
   THERMITE_CONTROL_PUBLIC_URL=https://<control's name on the tunnel>
   THERMITE_NATS_PUBLISH=<control's address on the tunnel>:4222
   ```

   WireGuard encrypts what crosses the tunnel. If you'd rather not run HTTPS inside it, an `http://` address works with `THERMITE_CONTROL_ALLOW_PLAIN_HTTP=1` in `.env`: the rigs then send their tokens over plain HTTP, inside the tunnel.
5. Let the tunnel reach the proxy's port and 4222 on control's machine, and nothing else reach them, in its firewall.
6. Start Thermite again with them: `docker compose up -d` (or `podman compose up -d`), and check from a rig's machine as above.

## Next

[Add a second machine](../../tutorials/second-machine.md), at control's address on your private network. [Run the message bus](../operate/message-bus.md#let-rigs-on-other-machines-reach-it) says more about the bus's address, and [The security model](../../explanation/security-model.md) what each part of Thermite reaches and trusts.
