# Claude Code 2.1.308 session logs

Recorded on 2026-10-29 in goal 169's spike of each program's terminal UI: Claude Code 2.1.308 ran as a lane's user in the harness image, under the broker, against the spike's scripted stand-in for Anthropic's API, so every reply, tool call and usage limit here is the stand-in's. Each folder is one run: `transcript.jsonl`, the transcript Claude Code wrote, and `scenario.json`, the command line and the steps that drove it.

`signals.jsonl`, beside the transcript in `claude-tui/`, `claude-hooks/` and `claude-print/`, holds the hooks' signals as Thermite's hook program writes them (goal 169): `{t, src, event, payload}`, one for each hook, each payload as Claude Code gave it. The spike's hook program wrote them; its status line's lines are left out, and the two points where its hooks gave the program a message are written as Thermite's hook program writes them (`thermite.given`).

Claude Code is not open source, so its system prompt, its tool descriptions and its requests are not kept. Its request records (`api-request`, `api-request-shape`, `api-request-blob`) keep their keys, ids and times, with a placeholder for the rest. Its attachments keep only their kind, apart from the words of the user and of the spike's hooks. Its notices, the prompts it writes itself and its words for an interrupt or a refused tool call are placeholders; its usage-limit message and the first line of a message from another session stay. Fields that no test reads were dropped.

- `claude-tui/`: the terminal UI; text typed mid-turn and taken into it; a usage limit (a 429 with a reset), then an exit during the wait.
- `claude-inbox/`: messages from another session through the messaging socket, mid-turn and while idle; an interrupt with Esc; a usage limit, its reset, and the program going on by itself.
- `claude-resume/`: a reply of text and a tool call that repeats its usage; the program killed and resumed with `--resume`; `/exit`.
- `claude-hooks/`: a Stop hook that blocks and sends the program on; a PostToolUse hook's context.
- `claude-print/`: one prompt in `-p`, with its `stream-json` output as `stream.jsonl` (rebuilt from the terminal's screen, its `init` line cut to a placeholder and its result's per-model figures dropped).
