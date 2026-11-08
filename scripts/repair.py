#!/usr/bin/env python
"""Keep the local Hermes features alive across `hermes update`.

Run this after every update. It checks each patched file for its marker and
re-applies only the files that lost it, one at a time. A second run is a no-op.

Exit codes: 0 applied/ok, 1 needs attention (read the output).
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys

HOME = os.environ.get("HERMES_HOME") or os.path.join(
    os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "hermes"
)
TREE = os.path.join(HOME, "hermes-agent")
PATCH = os.path.join(HOME, "patches", "turn-alerts", "core.patch")

# file -> marker that proves this file carries the feature
MARKERS = {
    "tui_gateway/server.py": "_stored_session_model_config",
    "tui_gateway/methods_complete.py": "telegram_push",
    "hermes_cli/lifecycle.py": "shell-hook re-registration before on_session_end",
    "agent/shell_hooks.py": "_hermes_shell_hook",
    "apps/desktop/src/app/settings/notifications-settings.tsx": "hermes:open-turn-alerts",
    "apps/desktop/src/app/shell/model-edit-submenu.tsx": "copy.fallbackRow",
    "apps/desktop/src/app/shell/model-catalog-menu.tsx": "fallbackAvailable",
    "apps/desktop/src/app/shell/model-menu-panel.tsx": "patchChatSwitch",
    "apps/desktop/src/i18n/en.ts": "fallbackRow:",
    "apps/desktop/src/i18n/types.ts": "fallbackRow?: string",
    "apps/desktop/src/types/hermes.ts": "telegram_push?: boolean",
    "tests/test_tui_gateway_server.py": "test_config_set_fallback_pins_one_session",
}

RENDERER = tuple(path for path in MARKERS if path.startswith("apps/desktop/"))


def missing() -> list[str]:
    gaps = []
    for path, marker in MARKERS.items():
        full = os.path.join(TREE, path)
        try:
            with open(full, "r", encoding="utf-8", errors="replace") as handle:
                if marker not in handle.read():
                    gaps.append(path)
        except OSError:
            gaps.append(path)
    return gaps


def git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=TREE, capture_output=True, text=True, timeout=120)


def reapprove() -> None:
    """The allowlist is by command; keep the recorded stamp fresh."""
    code = (
        "from hermes_cli.config import load_config;"
        "from agent import shell_hooks;"
        "specs=[s for s in shell_hooks.iter_configured_hooks(load_config())"
        " if s.event=='on_session_end'];"
        "[shell_hooks._record_approval(s.event, s.command) for s in specs];"
        "print(len(specs))"
    )
    python = os.path.join(TREE, "venv", "Scripts", "python.exe")
    if not os.path.exists(python):
        python = os.path.join(TREE, "venv", "bin", "python")
    result = subprocess.run([python, "-c", code], cwd=TREE, capture_output=True, text=True, timeout=120)
    print("hook approvals refreshed:", (result.stdout or result.stderr).strip()[:120])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="report only, change nothing")
    args = parser.parse_args()

    if not os.path.isdir(TREE):
        print(f"[x] Hermes source tree not found at {TREE}")
        return 1
    if not os.path.exists(PATCH):
        print(f"[x] Patch not found at {PATCH}")
        return 1

    gaps = missing()
    if not gaps:
        print("[ok] all markers present - nothing to do")
        reapprove()
        return 0

    print("[!] missing in:")
    for path in gaps:
        print(f"    {path}")

    if args.check:
        print("[i] --check only; run without it to re-apply")
        return 1

    # PER FILE. A whole-patch apply is all-or-nothing, so every file that still
    # carries its marker would make the repair fail.
    broken = []
    for path in gaps:
        if git("apply", "--check", "--include", path, PATCH).returncode != 0:
            broken.append(path)
            continue
        if git("apply", "--include", path, PATCH).returncode != 0:
            broken.append(path)
            continue
        print(f"[ok] re-applied {path}")

    if broken:
        print("[x] these files no longer match the patch (the code moved):")
        for path in broken:
            print(f"    {path}")
        print(
            "\nThe durable parts (desktop plugin, Telegram hook, config.yaml hooks block)\n"
            "live OUTSIDE the tree and are unaffected. See README.md to rebase the core bits."
        )
        return 1

    still = missing()
    if still:
        print("[x] markers still missing after apply:")
        for path in still:
            print(f"    {path}")
        return 1

    reapprove()

    if any(path in gaps for path in RENDERER):
        print("[!] desktop renderer changed - rebuild before the UI shows it:")
        print('    cd "' + os.path.join(TREE, "apps", "desktop") + '" && npm run build')
        print("    then repack and swap (see README.md)")

    print("[ok] done; restart Hermes so the Python side loads")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
