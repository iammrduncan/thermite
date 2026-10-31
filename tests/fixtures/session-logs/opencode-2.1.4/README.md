# OpenCode 2.1.4 session logs

Recorded on 2026-10-29 in goal 169's spike of each program's terminal UI: OpenCode 2.1.4 (MIT) ran as a server with its terminal UI attached, as a lane's user in the harness image, under the broker, against the spike's scripted stand-in for a chat completions API, so every reply, tool call and usage limit here is the stand-in's. Each folder is one run: `events.jsonl`, the events the spike's plugin received (`event.subscribe()`), one a line, and `scenario.json`, the command line and the steps that drove it. Each event's `location` was dropped.

- `opencode-tui/`: text typed mid-turn and taken into it; a message sent through the server's prompt route while idle (queued) and another mid-turn (steer); a usage limit. Beside it, `messages.json` is the session's messages route (`GET /api/session/<id>/message`, newest first) at the end, and `api-event.sse` the server's event stream (`GET /api/event`) as it arrived, joined after the first turn began, with the events no test reads left out.
- `opencode-interrupt/`: an interrupt with Esc pressed twice.
