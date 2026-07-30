from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import venv
import shutil
from datetime import date
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PROFILES = ("full", "telegram", "journal")


def require_embedded_sqlite() -> None:
    try:
        probe = subprocess.run(
            ["node", "-e", "require('node:sqlite')"],
            check=False,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as error:
        raise RuntimeError("Node.js не найден; установите Node.js 22.5+ (рекомендуется 24+)") from error
    if probe.returncode != 0:
        raise RuntimeError(
            "Текущий Node.js не содержит node:sqlite; установите Node.js 22.5+ "
            "(рекомендуется 24+)"
        )


def runtime_root() -> Path:
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "AgentHub"
    return Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state")) / "agent-hub"


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


def read_existing_config(config_file: Path) -> dict:
    if not config_file.exists():
        return {}
    try:
        value = json.loads(config_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def apply_rollout_image_cleanup_choice(config: dict, choice: str | None) -> dict:
    if choice is None:
        return config
    current = config.get("codexRolloutContext")
    settings = dict(current) if isinstance(current, dict) else {}
    settings["enabled"] = choice == "enabled"
    settings.setdefault("scanIntervalSeconds", 15 * 60)
    return {**config, "codexRolloutContext": settings}


def install_vscode_extension() -> Path | None:
    source = ROOT / "VSCodeExtension"
    if not source.is_dir():
        print("VS Code extension source is not present; skipped.")
        return None
    package = json.loads((source / "package.json").read_text(encoding="utf-8"))
    extension_id = f"{package['publisher']}.{package['name']}-{package['version']}"
    extensions_root = (Path.home() / ".vscode" / "extensions").resolve()
    target = (extensions_root / extension_id).resolve()
    if target.parent != extensions_root or not target.name.startswith(f"{package['publisher']}.{package['name']}-"):
        raise RuntimeError(f"Refusing to replace unexpected extension path: {target}")
    extensions_root.mkdir(parents=True, exist_ok=True)
    removable_prefixes = (f"{package['publisher']}.{package['name']}-",)
    for candidate in extensions_root.iterdir():
        resolved = candidate.resolve()
        if resolved.parent != extensions_root:
            continue
        if candidate.is_dir() and candidate.name.startswith(removable_prefixes):
            shutil.rmtree(resolved)
    shutil.copytree(
        source,
        target,
        ignore=shutil.ignore_patterns("*.vsix", "node_modules", "__pycache__"),
    )
    print(f"Installed VS Code extension: {target}")
    return target


def install_autostart() -> None:
    if sys.platform != "win32":
        return
    subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(ROOT / "install-autostart.ps1"),
        ],
        check=True,
    )


def start_runtime(target_root: Path) -> None:
    if sys.platform == "win32":
        launcher = target_root / "launch.vbs"
        subprocess.Popen(
            ["wscript.exe", "//B", "//Nologo", str(launcher)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    else:
        subprocess.Popen(
            [str(target_root / "launch.sh")],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )


def backfill_personal_history(project_root: Path, target_root: Path) -> None:
    subprocess.run(
        [
            "node",
            str(ROOT / "work-log-backfill.mjs"),
            "--project-root",
            str(project_root),
            "--ledger",
            str(target_root / "data" / "work-log-usage.json"),
            "--work-log",
            str(project_root / "WORK_LOG.md"),
            "--through",
            date.today().isoformat(),
            "--apply",
        ],
        check=True,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Configure Agent Hub")
    parser.add_argument(
        "--profile",
        choices=PROFILES,
        help="full: Telegram + Mini App; telegram: Telegram without Mini App; journal: local journal only; existing profile is preserved when omitted",
    )
    parser.add_argument("--token-file", type=Path)
    parser.add_argument("--user-id", type=int)
    parser.add_argument(
        "--project-root",
        type=Path,
        help="workspace whose personal WORK_LOG.md is maintained; existing value is preserved when omitted",
    )
    parser.add_argument(
        "--provider",
        choices=("codex", "claude"),
        help="active AI provider; existing value is preserved when omitted",
    )
    parser.add_argument("--with-voice", action="store_true", help="enable voice messages")
    parser.add_argument("--install-voice", action="store_true", help="install Whisper and Silero TTS")
    parser.add_argument(
        "--skip-history",
        action="store_true",
        help="do not rebuild the personal journal from local Codex rollouts",
    )
    parser.add_argument(
        "--rebuild-history",
        action="store_true",
        help="rebuild history even when Agent Hub was already configured",
    )
    parser.add_argument(
        "--skip-extension",
        action="store_true",
        help="do not install the local VS Code journal extension",
    )
    parser.add_argument(
        "--extension-only",
        action="store_true",
        help="install only the local VS Code journal extension and leave runtime configuration unchanged",
    )
    parser.add_argument(
        "--skip-autostart",
        action="store_true",
        help="do not add Agent Hub to the current user's startup",
    )
    parser.add_argument(
        "--rollout-image-cleanup",
        choices=("enabled", "disabled"),
        help=(
            "record the explicit local choice for periodic duplicate-image "
            "cleanup in idle Codex rollout snapshots"
        ),
    )
    args = parser.parse_args()
    require_embedded_sqlite()
    if args.extension_only:
        install_vscode_extension()
        return 0
    target_root = runtime_root()
    target_root.mkdir(parents=True, exist_ok=True)

    config_file = target_root / "config.json"
    fresh_install = not config_file.exists()
    existing = read_existing_config(config_file)
    profile = args.profile or str(existing.get("profile", "full")).strip().lower()
    if profile not in PROFILES:
        profile = "full"
    project_root = (
        args.project_root.resolve()
        if args.project_root
        else Path(existing.get("projectRoot", ROOT.parent.parent)).resolve()
    )
    provider = args.provider or str(existing.get("provider", "codex")).strip().lower()
    if provider not in ("codex", "claude"):
        provider = "codex"
    telegram_enabled = profile != "journal"
    token = ""
    user_id = None
    if telegram_enabled:
        token = (
            args.token_file.read_text(encoding="utf-8").strip()
            if args.token_file
            else str(existing.get("telegramBotToken", "")).strip()
        )
        if not token:
            token = input("Telegram bot token: ").strip()
        existing_users = existing.get("allowedUserIds", [])
        remembered_user = existing_users[0] if isinstance(existing_users, list) and existing_users else None
        user_id = args.user_id or remembered_user or int(input("Your numeric Telegram user ID: ").strip())
    existing_mini_app = existing.get("miniApp")
    if not isinstance(existing_mini_app, dict):
        existing_mini_app = {
            "enabled": True,
            "host": "127.0.0.1",
            "port": 8787,
            "quickTunnel": {"enabled": False},
            "worker": {"enabled": False},
        }
    remembered_users = existing.get("allowedUserIds", [])
    remembered_chats = existing.get("allowedChatIds", remembered_users)
    config = {
        **existing,
        "profile": profile,
        "telegramBotToken": token or str(existing.get("telegramBotToken", "")).strip(),
        "allowedUserIds": [user_id] if user_id is not None else remembered_users,
        "allowedChatIds": [user_id] if user_id is not None else remembered_chats,
        "privateChatsOnly": True,
        "provider": provider,
        "claudePermissionMode": "acceptEdits",
        "projectRoot": str(project_root),
        "miniApp": existing_mini_app,
        "voiceEnabled": bool(existing.get("voiceEnabled")) or args.with_voice or args.install_voice,
        "whisperModel": "small",
        "ttsEnabled": bool(existing.get("ttsEnabled")) or args.with_voice or args.install_voice,
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
    config = apply_rollout_image_cleanup_choice(config, args.rollout_image_cleanup)
    config_file.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Created {config_file}")
    if args.install_voice:
        install_voice(target_root)
    subprocess.run(["node", str(ROOT / "runtime-manager.mjs"), "deploy"], check=True)
    subprocess.run(["node", str(ROOT / "runtime-manager.mjs"), "activate"], check=True)
    subprocess.run(["node", str(ROOT / "codex-hook-config.mjs"), "install"], check=True)
    if not args.skip_history and (fresh_install or args.rebuild_history):
        backfill_personal_history(project_root, target_root)
    if not args.skip_extension:
        install_vscode_extension()
    if not args.skip_autostart:
        install_autostart()
    if fresh_install:
        start_runtime(target_root)
        print("Agent Hub runtime started.")
    else:
        print("Configuration updated. Restart the existing Agent Hub runtime to apply the profile.")
    legacy_config = ROOT / "config.json"
    if legacy_config.exists():
        legacy_config.unlink()
        print(f"Removed legacy workspace config: {legacy_config}")
    print(f"Agent Hub profile: {profile}")
    print("Reload the VS Code window after first extension installation.")
    print("Run: npm run doctor")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
