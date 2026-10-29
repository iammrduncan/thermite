---
title: "Use a private repository"
description: "Give rigs access to a private project or kit repository with a deploy key or a token."
type: how-to
sidebar:
  order: 6
---

A [rig](../../reference/glossary.md) fetches your project and your [kit](../../reference/glossary.md) itself, from their git repositories. For a private repository, set up **Git access** once on control: a deploy key that control makes, or an access token you paste. Then choose it on the **New campaign** page. Each access is for one host, such as `github.com`: control uses it for that host only, and gives it to a rig only while a run assigned to that rig that names it is live, waiting for the rig or taken by it and not closed.

The **New campaign** page is the one place made for naming a Git access. From the command line, see [From the command line](#from-the-command-line).

## Before you start

- You are signed in to the dashboard as the owner.
- You can add a deploy key, or make an access token, on the git host.
- Choose the kind of access by the repository's address:

| Access | Address it works with |
| --- | --- |
| **A deploy key (control makes it)** | `ssh://git.example.com/you/project.git` or `git@git.example.com:you/project.git` |
| **An access token (HTTPS)** | `https://git.example.com/you/project.git` |

## 1. Add the Git access

1. Open **Settings**, the cog at the foot of the sidebar. The page is **Providers**.
2. Under **Add a provider**, set **Type** to **A deploy key (control makes it)** or **An access token (HTTPS)**.
3. Fill in **Name**, such as `project-deploy`. Campaigns refer to the access by this name.
4. Fill in **Host**: the git server's name alone, such as `github.com` or `git.example.com`. Control and the rigs use the access for repositories on this host only. Without one: `Name the host the Git access is for, such as github.com: the server's name alone, with no https://, user, port or path.`
5. For a token, also fill in **Token** (read-only if the host allows it) and **User name**: the name the host expects with the token. Empty means `x-access-token`, which GitHub takes. GitLab takes `oauth2`.
6. Press **Make the key** or **Add the token**.

You see `Made the deploy key "project-deploy": add its public key, below, to the repository as a read-only deploy key.`, or `"project-deploy" is kept, sealed: choose it on the new-campaign page.` The access shows in the **Providers** list as **Git access**, `for github.com only`. Control seals the secret and never shows it again.

An access added before accesses had a host is bound, as control updates, to the one host the campaigns that name it fetch from. One they name on more hosts, or none, shows `for no host yet`: open its row, fill in **Host** and press **Set the host**. Until then, campaigns that name it can't start.

## 2. Add a deploy key to the repository

For a deploy key, open its row in the list. It shows the public key. Add it on the git host as a **read-only** deploy key of the repository.

Many git hosts, GitHub among them, refuse one deploy key on a second repository. If both the project and the kit are private, make one Git access for each, or use one access token that can read both.

## 3. Try it

In the access's row, enter the repository's address under **Try it on a repository** and press **Try it**. Control reads the repository's branches, as a rig would, and keeps nothing.

You see a line such as `"project-deploy" reads git@git.example.com:you/project.git: its default branch is at 1a2b3c4, with 214 files.`, or `"project-deploy" could not read …` with the reason. A repository on another host is not tried: `the Git access project-deploy is for git.example.com only, and <address> is on <host>`.

## 4. Choose it for a campaign

On **Campaigns › New campaign**:

- for the project, in **3 Project**, write the address in **Repository** and choose the access in **Repository access**;
- for a kit in a repository, in **4 How to measure**, choose it in **Kit repository access**.

**Look it up** then reads the project with the access. A deploy key needs an `ssh://` or `git@host:path` address: an `https://` one gives `with an SSH deploy key, the repository is an ssh:// or git@host:path address`. See [Start a campaign from the dashboard](start-from-dashboard.md) for the other fields.

## 5. Check that the rig fetched it

Stay on the campaign's page: once the rig reports the run, within a minute or so, the page opens the run's own page by itself. If the rig could not fetch the project, the card at the top says `Not started:`, the run, and `rig-1 refused it: staging:` with the reason. On **Commands** in the sidebar, the **assign campaign** row is **failed**, with the same reason.

| Reason | What to do |
| --- | --- |
| `Git access project-deploy: control answered 404` | Control has no Git access of that name for this rig. Check the name under **Settings** |
| `Git access project-deploy is for git.example.com only, and … comes from …` | The repository is on another host than the access. Use an access for that host |
| `… has no commit …` | The commit is not in that repository, or the access can't read it: use **Try it** on the repository |
| git's own error, such as `Permission denied (publickey)` | The access can't read the repository: its key is not a deploy key of that repository, or the token can't read it. **Try it** shows the same error |

When it is fixed, start the run again: press **Start a run** at the top of the campaign's page, choose the rig, and press **Start the run**.

## From the command line

`thermite assign` has no option to name a Git access. To start a run on a private repository from the command line, either put its commits in the rig's inbox as git bundles ([Start it when the rig can't fetch](start-from-command-line.md#start-it-when-the-rig-cant-fetch)), or name the access in the command yourself, with the owner's or the operator's token. The repository must be on the access's host: control refuses the command otherwise, with `The Git access <name> is for <host> only, and <path> comes from <host>.` An agent's token may not name a Git access.

Run `npx thermite` in your Thermite folder, after `npm ci` and `npm run build` (see [the command line](../../reference/command-line.md)). The examples use the owner's token file of the local stack, `.dev/secrets/control-admin-token`. If you made an owner's token of your own, use its file instead.

1. Build the command's payload with `--print`, with the repositories' SSH addresses for a deploy key:

   ```sh
   npx thermite assign --contract contract.json --run sort-speed-1 \
     --seed git@git.example.com:you/project.git@0123456789abcdef0123456789abcdef01234567 \
     --kit git@git.example.com:you/project-kit.git --print > payload.json
   ```

2. In `payload.json`, add `"access"` and the access's name beside the `"git"` address of each private repository:

   ```json
   "source": { "git": "git@git.example.com:you/project.git", "access": "project-deploy" }
   ```

3. Send it:

   ```sh
   npx thermite command --control http://127.0.0.1:8800 --token-file .dev/secrets/control-admin-token \
     --rig local-1 --kind assign_campaign --payload @payload.json
   ```

[Signed commands](../../reference/signed-commands.md) describes the payload's sources. Then check that the rig fetched it, as in step 5.

## Change or remove it

- **A token:** in its row, enter the new one under **New token** and press **Replace the token**. Campaigns that use it keep working.
- **A deploy key:** add a new access under a new name, add its key to the repository, and start the campaign's next version with it.
- **Delete this Git access** removes an access. You see `Rigs that ran with it keep nothing of it.` An access that a campaign uses can't be deleted: its row says `In use by …: their runs fetch with it, so it can't be deleted.` The row's `used by …` line names those campaigns.
