# Hermes Turn Alerts

Loud, configurable prompt-completion alerts for [Hermes Agent](https://github.com/NousResearch/hermes-agent),
plus a per-chat model-fallback switch and a per-chat Telegram push.

Built against the desktop app. Everything here runs from `~/.hermes`, so a
`hermes update` does not delete it.

## What you get

**Alerts when a prompt finishes**

- A cue bank with volume up to 300% and 1–8 repeats, rendered through a limiter
  so it is loud without clipping.
- **Your own audio**: upload an MP3/WAV/OGG/M4A and it plays instead of the
  built-in cue.
- Screen-edge glow plus a card in any corner (six positions), for a chosen
  number of seconds. Click the card to clear it early.
- **Voice-over**: a system voice reads a phrase you choose, at 0.5×–2×, or you
  upload one recorded line — from any voice service — and that plays instead.
- Per-chat scope: only the active chat, or any tracked session.

**Per-chat controls in the model menu**

Hover a model row and the options submenu now carries two extra switches beside
Thinking and Fast:

- **Fallback** — this chat keeps its primary model when the global
  `fallback_providers` chain would otherwise take over.
- **Telegram push** — send the completion line for this chat. **Off by
  default**; you opt in per chat.

**Telegram on completion**

One message per finished prompt: the session name, then the status.

```
✅ Quant Lab HQ
completed
```

```
⚠️ Quant Lab HQ
error — api_error(status=429, provider=openrouter)
```

Sent straight to the Bot API from a `pythonw.exe` worker: no console window, no
CLI startup delay.

## Install

```bash
# 1. alert plugin (no build step)
mkdir -p ~/.hermes/desktop-plugins/loud-turn-alerts
cp plugin/loud-turn-alerts/plugin.js ~/.hermes/desktop-plugins/loud-turn-alerts/

# 2. Telegram hook
mkdir -p ~/.hermes/agent-hooks
cp hooks/turn-complete-telegram.py hooks/turn-complete-telegram.json ~/.hermes/agent-hooks/
```

Then add the registration to `~/.hermes/config.yaml`:

```yaml
hooks:
  on_session_end:
    - command: '"<path to venv>/python.exe" "<path to>/.hermes/agent-hooks/turn-complete-telegram.py"'
      timeout: 20
```

Both quoted paths matter on Windows — `shell=False` splits on spaces, and this
profile path contains one.

Set the chat id in `hooks/turn-complete-telegram.json` (`target:
"telegram:<chat_id>"`). The token comes from `TELEGRAM_BOT_TOKEN` in
`~/.hermes/.env`.

The desktop app reloads `desktop-plugins/` on save. Open the settings from
**Settings → Notifications → Turn alerts**, or the 🔔 Alerts chip in the status
bar.

## The core patch

Two behaviours need edits inside `hermes-agent`, because a plugin cannot reach
them:

| File | Why |
|---|---|
| `tui_gateway/server.py` | registers `config.yaml` hooks on the desktop backend, the `fallback` / `telegram_push` setters, persisted pins |
| `tui_gateway/methods_complete.py` | `model.options` reports the two chat switches |
| `hermes_cli/lifecycle.py` | re-registers config hooks before `on_session_end` |
| `agent/shell_hooks.py` | idempotent registration (no duplicate callback per turn) |
| `apps/desktop/src/**` | the menu switches and the settings row |

```bash
cd ~/.hermes/hermes-agent
git apply ~/hermes-turn-alerts/patches/core.patch
```

The renderer half needs a rebuild: `cd apps/desktop && npm run build`, then
repack. The Python half applies on the next Hermes start.

### Why the hook needed a patch at all

`_make_agent` registered `config.yaml` hooks **before** plugin discovery, and
`PluginManager.discover_and_load()` rebuilds the manager's hook table. The lazy
discovery inside the first `invoke_hook` therefore wiped the hook that had just
been registered — so `on_session_end` fired for CLI and Telegram turns and never
for a desktop turn, while `hermes hooks list` and `hooks doctor` both reported
healthy.

## Surviving updates

`hermes update` replaces the source tree. The plugin and the hook live outside
it, so they always survive. The core patch may not.

```
scripts/apply-after-update.bat          # or: python scripts/repair.py [--check]
```

It tests each patched file for a marker, re-applies only the files that lost it,
and refreshes the hook approval. If the surrounding code moved, it says which
file and stops rather than applying half a feature.

## Upstream

The reusable parts are proposed to Hermes itself:
**[NousResearch/hermes-agent#151216](https://github.com/NousResearch/hermes-agent/pull/151216)**
— the hook-registration fix and the per-session fallback pin, with tests.

Once that lands, the patch half of this repo is unnecessary.

## Licence

MIT, same as Hermes.
