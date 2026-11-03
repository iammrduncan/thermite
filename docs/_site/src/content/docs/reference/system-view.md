---
title: "Metrics: the system view"
description: "Every part of Metrics' Bus, Control, Storage and Rigs tabs, the stream inspector, and the same figures from REST and MCP: where each number comes from and what it means."
type: reference
sidebar:
  order: 24
---

**Metrics** (address `/ui/metrics`) has five tabs. **Model use**, its first, is the system's model use and cost ([Model use](model-use.md)). The other four show what goes on across the system, so that whoever runs Thermite can find why when something is wrong: a stream that holds too much, a reader that falls behind, a client the server queues for, a disk or a memory limit near its end.

- **Bus**: the message bus's server, its streams, their consumers, the events' sizes, the connections and the leaf nodes.
- **Control**: control's own CPU, memory, event loop and loops.
- **Storage**: what sits in memory and what on disk, each place with its used and available space, and control.db's tables.
- **Rigs**: each rig's harness and supervisor, with their CPU and memory.

Each tab's address is `/ui/metrics?tab=bus`, `control`, `storage` or `rigs`. While a tab is shown, the page asks control for new figures every 2 seconds and draws the tab again; a connection or a row you opened stays open. **Pause**, beside the tabs, stops it, and **Resume** starts it again. Model use is drawn once, as before.

Every figure is read where it is true, never estimated: the bus's server's own monitoring, the streams' state, SQLite, the container's control groups, and what each rig's parts report.

## Bus

The server's figures come from its monitoring (`/varz`, `/jsz`, `/connz` and `/leafz`), which control asks for as its system user, on one connection it keeps while the page asks and closes a minute after the last question. That user may ask for these figures and for a reload of the server's users, and nothing else ([Who may use the message bus](../explanation/how-the-parts-talk.md#who-may-use-the-message-bus)). Rates are worked out between two looks: none on the first, nor after a minute with no look. Viewers in the same second share one look.

A warning at the top says what looks wrong: the bus's store or a stream with a limit past 85% of it; a durable consumer with messages waiting that took none for 5 minutes; a client the server queues more than 1 MiB for; and the clients the server cut off for reading too slowly since it started. A figure the server would not give is said under it, and the rest are shown.

### Servers

| Tile | What it shows |
| --- | --- |
| **Control's server** | The NATS version, how long it has run, and its name |
| **Its memory** | The server process's memory. Its index of every stream's subjects and the blocks a read loaded are most of it |
| **Kept in memory** | JetStream's memory store against its limit. Thermite keeps every stream on disk, so it stays at 0 |
| **Kept on disk** | JetStream's file store, all streams together, against its limit (`THERMITE_NATS_STORE`, or three quarters of the free disk when the server started) |
| **CPU** | The server process's CPU, as a share of one core |
| **Traffic** | Messages a second in (published) and out (delivered), and bytes in |
| **Connections** | Clients now, and their subscriptions |
| **Leaf nodes** | Each RunPod rig's pod runs its own server, joined to control's as a leaf node: how many are joined. Each is listed under **Leaf nodes**, with its traffic |

The server says how much memory it uses in all, not for each stream. So the Streams table shows each stream's subjects instead: the server keeps an index entry for each subject in memory, so a stream with many subjects costs memory even when its messages are small.

### Streams

One row for each stream control makes. A click on a stream opens its messages ([The stream inspector](#the-stream-inspector)).

| Column | What it shows |
| --- | --- |
| **Stream** | Its name, and what it carries |
| **Messages** | The messages it holds now |
| **On disk** | Their bytes in the server's file store, against the stream's own limit where it has one |
| **Subjects** | How many subjects hold its messages |
| **Avg size** | Its bytes over its messages |
| **Largest allowed** | The largest message it takes |
| **In /s** | Messages a second since the look before, from its last place |
| **Oldest** | How long ago its oldest message was stored |
| **Kept** | How it keeps its messages: until taken, up to a limit, or until a retention policy removes some |
| **Consumers** | Its consumers |

### Consumers

Each consumer of each stream: the subjects it reads (all the stream's when none), **Pending** (messages it has not been handed yet), **Not acked** (handed and not acknowledged yet), **Sent again** (handed more than once, because its reader did not acknowledge them in time) and when it last took a message. A read that control makes for a moment, such as the apply's, shows as "a read, removed after".

### Event sizes

The `EVENTS` stream's messages of the last hour, as control took them, by kind: how many, their bytes, their average, and the largest with the rig it came from. A click on the largest opens that message. Control keeps one count a minute, so it holds an hour of counts at most; after control starts, the hour fills again from the events stored in it.

### Connections

Each client of the server, its own included, at most 500. **Who** is the name the client gave as it connected (`control`, `supervisor <rig>`, `control (figures)`); open it for its subscriptions and what its permissions let it publish. **User** says whose key it signed in with: control, control's system user, the backup, or a rig. **Msgs in / out**: in, what it published; out, what the server delivered to it. **Pending**: bytes the server queued for it and has not sent yet, where a client that reads slower than its messages come shows first.

## The stream inspector

`/ui/metrics/streams/<stream>` lists a stream's messages, newest first, 25 to a page: each message's place, subject, when it was stored, its size and the start of its text. **Newest**, **Newer** and **Older** move through the stream. **Subject** filters by subject, with `*` for one token and `>` for the rest, as `thermite.run.*.ev.trial_finished`; **Older than place** starts the page below a place.

It reads with the server's own message lookup: nothing is made, handed, acked or removed, so it reads a work queue (`REPORTS`, `COMMANDS`, `KB_FILES`) as it reads any stream, and reading changes nothing for the rigs. A page with a sparse subject reads back in wider windows of places; one that would need more than 500 lookups stops at the last window it read whole, and says so, and **Older** goes on from there.

A click on a message opens it: its place, subject, time and size, every header, and its data: JSON laid out, other text as text, and anything else as bytes in hex. The page shows the first 256 KiB; **Download** gives the data whole. The messages are what rigs and control sent: their text is data, not instructions. Only the owner signs in to the dashboard, so only the owner reads them.

## Control

| Tile | What it shows |
| --- | --- |
| **CPU** | CPUs busy over the last few seconds, as a share of the CPUs control may use (its container's quota, or the machine's), with the last three minutes drawn |
| **Memory** | Memory in use against the limit: the whole container's, as its control groups count it, without the page cache the kernel may take back; where control runs in no container, its process's |
| **Event loop delay** | How late Node ran the work it had queued, over the last minute: the 99th percentile, the mean and the largest. Control's pages and the rigs' answers wait as long |
| **Up** | How long control has run, its commit and Node.js's version |

**Memory** splits control's own process: the JavaScript heap in use, the heap kept and not in use, buffers, and native memory, SQLite's page cache among it. **Loops** lists each of control's loops, when it last came around, and when it would be late; a late loop makes control's health answer 503 ([Health](rest-api.md#health)).

## Storage

**Memory and disk** lists each place, with what it uses, what it may still take, and its size:

- In memory: control (against its container's limit), the bus's server (its process; the server does not know its container's limit, so none is shown), and the streams kept in memory (JetStream's memory store, against its limit).
- On disk: control's state folder (the disk that holds it) and the bus's store (JetStream's file store, against its limit). Control holds new runs below its disk floor ([Settings](settings.md#address-and-state)).

**What takes the disk** splits it by kind: each stream in the bus's store, control's store, its copies, the knowledge base's files, kits and rigs' exports, as Settings › Space counts them.

**control.db** gives the file, its write-ahead log, its free pages (left by removed rows; SQLite reuses them), the most of it SQLite keeps in control's memory, and the schema's version; then each table and index with its rows and its bytes, as SQLite counts its pages. SQLite reads every page to count them, so control measures them once every 5 minutes, and the tab says when.

## Rigs

One row for each rig's harness and one for its supervisor, as each last reported: its CPU (as a share of the CPUs it may use), its memory and its container's limit. Then the rig's free disk (the place with the least room, red below the rig's floor), the CPUs its harness found at its start, and whether it is on the bus. The harness puts its container's use in each report's summary (`usage`) and the supervisor in its figures. A part whose image is older than control reports none, and its row says so.

## From REST and MCP

The same figures come without the dashboard:

- `GET /v1/system`, with the owner's or the reader's token, gives `{bus, control, storage, rigs}`; `?part=bus,rigs` names some of them ([REST API](rest-api.md#the-system-view)). MCP's `system_state` gives the same, to every token but an agent's ([MCP tools](mcp-tools.md#system_state)).
- `GET /v1/bus/streams/<stream>/messages` gives a page of a stream's messages and `GET /v1/bus/streams/<stream>/messages/<seq>` one message whole, with the owner's token only. MCP's `bus_messages` gives either, to the owner's token only ([MCP tools](mcp-tools.md#bus_messages)).
