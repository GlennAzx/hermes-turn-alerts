# Loud turn alerts

Two channels announce "the agent finished". Both are configurable.

## 1. In-app sound + visual (desktop plugin)

Files: `desktop-plugins/loud-turn-alerts/plugin.js`

Open the settings: click **🔔 Alerts** in the status bar. You can also run
**Turn Alerts: open settings** from the ⌘K palette.

Settings:

| Control | What it does |
|---|---|
| Enable turn alerts | Master switch |
| Play a sound | Sound channel on/off |
| Cue | Klaxon / Triple beep / Rising chime / Deep gong / Rising siren |
| Volume | Percent of the loud bank. 150 is loud. 300 is the limiter ceiling. |
| Repeats | Cue fires 1 to 8 times per turn |
| Show a visual alert | Visual channel on/off |
| Edge glow | Pulses a coloured frame around the whole window |
| Banner | Top-centre card with the reply preview. Click it to dismiss. |
| Reply preview | First 220 characters in the banner |
| Colour | Amber / Red / Green / Blue / Violet |
| Glow / visible | Glow thickness in px, seconds on screen |
| This chat only | Off lets any tracked session alert |
| System notification | Native OS toast (behind the away-from-Hermes gate) |
| Loud error cue | Triple beep when a turn fails |

The plugin listens to the gateway event `message.complete`, the same event the
built-in completion chime uses.

Notes:

- The sound runs through a limiter, so a high volume stays clean.
- If you want only this cue, turn off the core one in
  **Settings → Notifications → Completion Sound**.
- A hot reload of the file keeps your settings. `ctx.storage` keys are under
  `hermes.plugin.loud-turn-alerts.*` in renderer local storage.

## 2. Telegram push (shell hook)

Fires the moment ANY turn finishes, in any session the backend serves. One
registration covers the whole process: `on_session_end` runs at the end of
every `run_conversation` call, so two chats finishing at the same moment send
two messages.

Message is two lines — session name, then status:

```
✅ Assess the viability of an image-to-tags suggestion feature
completed
```

```
⚠️ Quant Lab HQ
error — api_error(status=429, provider=openrouter)
```

The name is `sessions.title`. When a session has no title yet, it falls back to
the first user prompt, then to the session id.

Files:

- `agent-hooks/turn-complete-telegram.py` — the hook
- `agent-hooks/turn-complete-telegram.json` — the settings
- `config.yaml` → `hooks.on_session_end` — the registration

Config keys:

```json
{
  "enabled": true,
  "target": "telegram:152761768",
  "skip_platforms": ["telegram", "subagent"],
  "notify_on_failure": true,
  "notify_on_interrupt": false,
  "min_turn_seconds": 0,
  "rate_limit_per_minute": 0,
  "name_max_chars": 64
}
```

- `target` accepts any `hermes send` target, for example
  `telegram:-1003847235532:14` for a group topic.
- `skip_platforms` stops echo and noise. `telegram` prevents a Telegram turn
  from pushing back to Telegram. `subagent` hides delegate_task children.
  Cron runs are included; add `cron` to this list to silence them.
- `min_turn_seconds` drops short turns. 0 means every turn.
- `rate_limit_per_minute` 0 means no cap.
- Delivery is detached, so the agent loop never waits on `hermes send`.

Diagnostics: `agent-hooks/.turn-complete-telegram-state.json` holds
`last_payload`, `last_decision`, `last_message`, and the recent send
timestamps. Read it to confirm what the live backend sees.

Re-approve after any edit to the script. `hermes hooks doctor` reports
`script unchanged since approval` when the approval is still valid. To approve
again, run this from `~/.hermes`:

```
hermes-agent/venv/Scripts/python.exe -c "from hermes_cli.config import load_config; from agent import shell_hooks; [shell_hooks._record_approval(s.event, s.command) for s in shell_hooks.iter_configured_hooks(load_config()) if s.event == 'on_session_end']"
```

The gateway registers shell hooks only at startup, so a restart of the Hermes
gateway or the desktop app applies a new hook.
