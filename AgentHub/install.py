from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import venv
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def runtime_root() -> Path:
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "Tyrael" / "TelegramIntegration"
    return Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state")) / "tyrael" / "telegram-integration"


def install_voice(target_root: Path) -> None:
    venv_dir = target_root / "voice-venv"
    venv.EnvBuilder(with_pip=True).create(venv_dir)
    python = venv_dir / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    subprocess.run(
        [str(python), "-m", "pip", "install", "-r", str(ROOT / "requirements.txt")],
        check=True,
    )
    whisper_environment = {
        **os.environ,
        "WHISPER_MODEL_DIR": str(target_root / "data" / "models" / "whisper"),
    }
    subprocess.run(
        [str(python), str(ROOT / "transcribe.py"), "--download"],
        check=True,
        env=whisper_environment,
    )

    tts_venv_dir = target_root / "tts-venv"
    venv.EnvBuilder(with_pip=True).create(tts_venv_dir)
    tts_python = tts_venv_dir / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    subprocess.run(
        [str(tts_python), "-m", "pip", "install", "-r", str(ROOT / "requirements-tts.txt")],
        check=True,
    )
    subprocess.run([
        str(tts_python), str(ROOT / "tts_worker.py"),
        "--cache-dir", str(target_root / "data" / "models" / "silero"),
        "--model", "v5_5_ru",
        "--speaker", "xenia",
        "--download",
    ], check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Configure the Telegram AI coding bridge")
    parser.add_argument("--token-file", type=Path)
    parser.add_argument("--user-id", type=int)
    parser.add_argument("--project-root", type=Path, default=ROOT.parent.parent)
    parser.add_argument("--provider", choices=("codex", "claude"), default="codex")
    parser.add_argument("--with-voice", action="store_true", help="enable voice messages")
    parser.add_argument("--install-voice", action="store_true", help="install Whisper and Silero TTS")
    args = parser.parse_args()
    target_root = runtime_root()
    target_root.mkdir(parents=True, exist_ok=True)

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
        "ttsEnabled": args.with_voice or args.install_voice,
        "ttsModel": "v5_5_ru",
        "ttsSpeaker": "xenia",
        "ttsIdleTimeoutSeconds": 900,
        "pythonExe": str(
            target_root / "voice-venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
        ),
        "ttsPythonExe": str(
            target_root / "tts-venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
        ),
        "whisperModelDir": "data/models/whisper",
        "ttsCacheDir": "data/models/silero",
        "dataDir": "data",
    }
    config_file = target_root / "config.json"
    config_file.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Created {config_file}")
    old_state = ROOT / ".telegram-codex-state.json"
    new_state = ROOT / "data" / "state.json"
    if old_state.exists() and not new_state.exists():
        new_state.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(old_state, new_state)
        print(f"Migrated state to {new_state}")
    if args.install_voice:
        install_voice(target_root)
    subprocess.run(["node", str(ROOT / "runtime-manager.mjs"), "deploy"], check=True)
    subprocess.run(["node", str(ROOT / "runtime-manager.mjs"), "activate"], check=True)
    legacy_config = ROOT / "config.json"
    if legacy_config.exists():
        legacy_config.unlink()
        print(f"Removed legacy workspace config: {legacy_config}")
    print("Run: npm run doctor")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
