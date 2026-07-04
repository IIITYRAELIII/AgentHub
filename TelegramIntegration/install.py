from __future__ import annotations

import argparse
import json
import subprocess
import sys
import venv
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def install_voice() -> None:
    venv_dir = ROOT / ".venv-telegram"
    venv.EnvBuilder(with_pip=True).create(venv_dir)
    python = venv_dir / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    subprocess.run(
        [str(python), "-m", "pip", "install", "-r", str(ROOT / "requirements.txt")],
        check=True,
    )
    subprocess.run([str(python), str(ROOT / "transcribe.py"), "--download"], check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Configure the Telegram AI coding bridge")
    parser.add_argument("--token-file", type=Path)
    parser.add_argument("--user-id", type=int)
    parser.add_argument("--project-root", type=Path, default=ROOT.parent.parent)
    parser.add_argument("--provider", choices=("codex", "claude"), default="codex")
    parser.add_argument("--with-voice", action="store_true", help="enable voice messages")
    parser.add_argument("--install-voice", action="store_true", help="create venv and install Whisper")
    args = parser.parse_args()

    token = args.token_file.read_text(encoding="utf-8").strip() if args.token_file else input("Telegram bot token: ").strip()
    user_id = args.user_id or int(input("Your numeric Telegram user ID: ").strip())
    config = {
        "telegramBotToken": token,
        "allowedUserIds": [user_id],
        "allowedChatIds": [user_id],
        "privateChatsOnly": True,
        "provider": args.provider,
        "claudePermissionMode": "acceptEdits",
        "projectRoot": str(args.project_root.resolve()),
        "voiceEnabled": args.with_voice or args.install_voice,
        "whisperModel": "small",
        "dataDir": "data",
    }
    (ROOT / "config.json").write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Created {ROOT / 'config.json'}")
    old_state = ROOT / ".telegram-codex-state.json"
    new_state = ROOT / "data" / "state.json"
    if old_state.exists() and not new_state.exists():
        new_state.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(old_state, new_state)
        print(f"Migrated state to {new_state}")
    if args.install_voice:
        install_voice()
    print("Run: npm run doctor")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
