#!/usr/bin/env python
"""on_session_end hook: push a Telegram line when any Hermes turn finishes.

One registration covers every session the backend serves (desktop chats,
CLI, gateway platforms), because `on_session_end` fires at the end of every
`run_conversation` call in this process.

Message is two lines: the session name, then the status.

Reads the shell-hook JSON payload from stdin, filters it against
``turn-complete-telegram.json`` (next to this file), then calls
``hermes send`` with the resolved target.

Design rules:
* Never raise. A hook failure must not touch the agent loop.
* Print nothing but JSON on stdout. Anything else is noise in the hook log.
* Deliver from a detached child, so the turn never waits on `hermes send`.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
HOME = os.path.dirname(HERE)
CONFIG_PATH = os.path.join(HERE, "turn-complete-telegram.json")
STATE_PATH = os.path.join(HERE, ".turn-complete-telegram-state.json")
DB_PATH = os.path.join(HOME, "state.db")
HERMES_EXE = os.path.join(HOME, "hermes-agent", "venv", "Scripts", "hermes.exe")

DEFAULTS = {
    "enabled": True,
    "target": "telegram:152761768",
    "skip_platforms": ["telegram", "subagent"],
    "notify_on_failure": True,
    "notify_on_interrupt": False,
    "min_turn_seconds": 0,
    "rate_limit_per_minute": 0,
    "name_max_chars": 64,
}


def load_config() -> dict:
    cfg = dict(DEFAULTS)
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
        if isinstance(raw, dict):
            cfg.update({key: value for key, value in raw.items() if key in DEFAULTS})
    except (OSError, ValueError):
        pass
    return cfg


def load_state() -> dict:
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
        if isinstance(raw, dict):
            return raw
    except (OSError, ValueError):
        pass
    return {}


def save_state(state: dict) -> None:
    try:
        with open(STATE_PATH, "w", encoding="utf-8") as handle:
            json.dump(state, handle)
    except OSError:
        pass


def connect_db() -> sqlite3.Connection | None:
    if not os.path.exists(DB_PATH):
        return None
    try:
        return sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=2.0)
    except sqlite3.Error:
        return None


def shorten(text: str, limit: int) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= limit:
        return text
    cut = text[:limit].rstrip()
    if " " in cut:
        cut = cut.rsplit(" ", 1)[0]
    return cut


def session_model_config(session_id: str) -> dict:
    """The session row's ``model_config`` as a dict (per-chat pins live here)."""
    if not session_id:
        return {}

    conn = connect_db()
    if conn is None:
        return {}

    try:
        row = conn.execute(
            "select model_config from sessions where id = ?", (session_id,)
        ).fetchone()
    except sqlite3.Error:
        return {}
    finally:
        conn.close()

    raw = row[0] if row else None
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
        except ValueError:
            return {}
        return parsed if isinstance(parsed, dict) else {}

    return {}


def session_name(session_id: str, limit: int) -> str:
    """Session title, else its first prompt, else the session id."""
    if not session_id:
        return "unknown session"

    conn = connect_db()
    if conn is None:
        return shorten(session_id, limit)

    try:
        row = conn.execute("select title from sessions where id = ?", (session_id,)).fetchone()
        if row and row[0] and str(row[0]).strip():
            return shorten(str(row[0]), limit)

        row = conn.execute(
            "select content from messages where session_id = ? and role = 'user'"
            " and length(trim(content)) > 0 order by rowid asc limit 1",
            (session_id,),
        ).fetchone()
        if row and row[0] and str(row[0]).strip():
            return shorten(str(row[0]), limit)
    except sqlite3.Error:
        pass
    finally:
        conn.close()

    return shorten(session_id, limit)


def last_prompt_age(session_id: str) -> int | None:
    if not session_id:
        return None

    conn = connect_db()
    if conn is None:
        return None

    try:
        row = conn.execute(
            "select timestamp from messages where session_id = ?"
            " and role = 'user' and timestamp is not null order by rowid desc limit 1",
            (session_id,),
        ).fetchone()
    except sqlite3.Error:
        return None
    finally:
        conn.close()

    if not row or not isinstance(row[0], (int, float)):
        return None

    age = time.time() - float(row[0])
    return int(age) if 0 <= age < 86400 else None


def build_message(payload: dict, cfg: dict) -> str:
    """Two lines: session name, then status."""
    session_id = str(payload.get("session_id") or "")
    failed = bool(payload.get("failed"))
    interrupted = bool(payload.get("interrupted"))
    reason = str(payload.get("turn_exit_reason") or "").strip()
    name = session_name(session_id, int(cfg.get("name_max_chars", 64)))

    if failed:
        detail = shorten(reason, 120)
        status = f"error — {detail}" if detail else "error"
        icon = "⚠️"
    elif interrupted:
        status = "interrupted"
        icon = "⏹️"
    else:
        status = "completed"
        icon = "✅"

    return f"{icon} {name}\n{status}"


def env_value(name: str) -> str:
    """Read one key from $HERMES_HOME/.env without importing Hermes."""
    env_path = os.path.join(HOME, ".env")
    try:
        with open(env_path, "r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                if key.strip() == name:
                    return value.strip().strip('"').strip("'")
    except OSError:
        pass

    return os.environ.get(name, "").strip()


def send_telegram_direct(token: str, chat_id: str, text: str) -> bool:
    """POST to the Bot API straight from this process.

    A direct HTTPS call is the whole reason this hook no longer spawns a
    console program: `hermes send` is a console app, and on Windows a detached
    console child flashes a terminal window the user sees while they are away.
    """
    import urllib.parse
    import urllib.request

    body = urllib.parse.urlencode(
        {"chat_id": chat_id, "text": text, "disable_web_page_preview": "true"}
    ).encode("utf-8")
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return 200 <= response.status < 300
    except Exception:
        return False


def send(target: str, text: str) -> bool:
    # Direct Bot API first: no child process, no console, no CLI startup cost.
    platform, _, chat_id = target.partition(":")
    if platform.strip().lower() == "telegram" and chat_id.strip():
        token = env_value("TELEGRAM_BOT_TOKEN")
        if token and send_telegram_direct(token, chat_id.strip(), text):
            return True

    # Fallback keeps every other target working (`hermes send` handles them).
    exe = HERMES_EXE if os.path.exists(HERMES_EXE) else "hermes"
    kwargs = {
        "capture_output": True,
        "text": True,
        "timeout": 25,
    }
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        kwargs["startupinfo"] = subprocess.STARTUPINFO(dwFlags=subprocess.STARTF_USESHOWWINDOW, wShowWindow=0)

    try:
        result = subprocess.run([exe, "send", "--to", target, "--quiet", text], **kwargs)
    except (OSError, subprocess.SubprocessError):
        return False

    return result.returncode == 0


def spawn_send(target: str, text: str) -> bool:
    """Detach the delivery so the agent loop never waits on `hermes send`."""
    flags = 0
    if os.name == "nt":
        flags = getattr(subprocess, "DETACHED_PROCESS", 0)

    # pythonw.exe has no console at all: a plain python.exe worker flashes a
    # console window on a detached spawn, which is exactly the popup the user
    # sees when they are away from the machine.
    worker_exe = sys.executable
    if os.name == "nt":
        candidate = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
        if os.path.exists(candidate):
            worker_exe = candidate

    try:
        subprocess.Popen(
            [worker_exe, os.path.abspath(__file__), "--send", target, text],
            creationflags=flags,
            close_fds=True,
            stderr=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError):
        return False

    return True


def main() -> int:
    raw = sys.stdin.read() if not sys.stdin.isatty() else ""
    if not raw.strip():
        return 0

    try:
        payload = json.loads(raw)
    except ValueError:
        return 0

    if not isinstance(payload, dict):
        return 0

    # Event kwargs (completed / failed / platform / model / turn_exit_reason)
    # arrive under "extra"; session_id is the only one promoted to the top.
    extra = payload.get("extra")
    if isinstance(extra, dict):
        payload = {**payload, **extra}

    cfg = load_config()
    state = load_state()

    # Keep the last payload for diagnostics: proves what the live agent sends.
    state["last_payload"] = {
        key: payload.get(key)
        for key in (
            "session_id",
            "platform",
            "model",
            "completed",
            "failed",
            "interrupted",
            "turn_exit_reason",
        )
    }
    state["last_payload_at"] = int(time.time())

    def done(note: str = "sent") -> int:
        state["last_decision"] = note
        save_state(state)
        print("{}")
        return 0

    if not cfg.get("enabled", True):
        return done("skipped:disabled")

    platform = str(payload.get("platform") or "").strip().lower()
    skip = [str(item).strip().lower() for item in cfg.get("skip_platforms") or []]
    if platform and platform in skip:
        return done(f"skipped:platform={platform}")

    # Per-chat switch from the desktop model menu (config.set key="telegram_push").
    # OFF by default: a chat pushes only after the user turns its switch on, so
    # installing the hook never starts messaging on its own.
    if session_model_config(str(payload.get("session_id") or "")).get("telegram_push") is not True:
        return done("skipped:push_off")

    if payload.get("failed") and not cfg.get("notify_on_failure", True):
        return done("skipped:failed")

    if payload.get("interrupted") and not cfg.get("notify_on_interrupt", False):
        return done("skipped:interrupted")

    min_seconds = int(cfg.get("min_turn_seconds", 0) or 0)
    if min_seconds > 0:
        age = last_prompt_age(str(payload.get("session_id") or ""))
        if age is None or age < min_seconds:
            return done("skipped:min_seconds")

    now = time.time()
    sends = [float(item) for item in state.get("sends") or [] if isinstance(item, (int, float))]
    sends = [item for item in sends if now - item < 60]
    limit = int(cfg.get("rate_limit_per_minute", 0) or 0)
    if limit > 0 and len(sends) >= limit:
        return done("skipped:rate_limit")

    target = str(cfg.get("target") or "").strip()
    if not target:
        return done("skipped:no_target")

    message = build_message(payload, cfg)
    state["last_message"] = message
    ok = spawn_send(target, message)
    if ok:
        sends.append(now)

    state["sends"] = sends

    return done("sent" if ok else "send_failed")


def worker(argv: list[str]) -> int:
    """Background delivery process spawned by spawn_send()."""
    if len(argv) < 3:
        return 0
    send(argv[1], argv[2])
    return 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--send":
        raise SystemExit(worker(sys.argv[1:]))

    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except BaseException:  # noqa: BLE001 - a hook must never break the agent
        print("{}")
        raise SystemExit(0)
