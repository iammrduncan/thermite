# Codex 0.162.1 session logs

Recorded on 2026-10-29 in goal 169's spike of each program's terminal UI: the Codex CLI 0.162.1 (Apache-2.0) ran its terminal UI as a lane's user in the harness image, under the broker, against the spike's scripted stand-in for OpenAI's Responses API, so every reply, tool call and usage limit here is the stand-in's. Each folder is one run: `rollout.jsonl`, the rollout Codex wrote, and `scenario.json`, the command line and the steps that drove it.

`signals.jsonl`, beside the rollout in `codex-tui/` and `codex-hooks/`, holds the hooks' and `notify`'s signals as Thermite's hook program writes them (goal 169): `{t, src, event, payload}`, one for each, each payload as Codex gave it. The spike's hook program wrote them; Codex's own prompt for the session's title, in `notify`'s input, is a placeholder, and the two points where the hooks gave the program a message are written as Thermite's hook program writes them (`thermite.given`).

Codex's base instructions, its instructions to the model and its settings records are cut to a short placeholder to keep the files small, and each record's metadata was dropped.

- `codex-tui/`: text typed mid-turn and taken into it; an interrupt with Esc, whose command ends later in the background; a usage limit.
- `codex-resume/`: a message queued with Tab for the next turn; the program killed and resumed with `codex resume`.
- `codex-hooks/`: a Stop hook that blocks and sends the program on; a PostToolUse hook's context.
