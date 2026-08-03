from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import venv
import shutil
from uuid import uuid4
from datetime import date
from pathlib import Path


ROOT = Path(__file__).resolve().parent
COMPONENTS = ("telegram", "mini-app", "android-app", "codex-context-cleanup")
LEGACY_PROFILE_COMPONENTS = {
    "full": {"telegram": True, "miniApp": True, "androidApp": True, "codexContextCleanup": False},
    "telegram": {"telegram": True, "miniApp": False, "androidApp": False, "codexContextCleanup": False},
    "journal": {"telegram": False, "miniApp": False, "androidApp": False, "codexContextCleanup": False},
}
SWAP_TOKEN_PATTERN = re.compile(r"[0-9a-f]{32}\Z")


def resolve_components(
    existing: dict,
    *,
    fresh_install: bool,
    legacy_profile: str | None = None,
    enabled: tuple[str, ...] | list[str] = (),
    disabled: tuple[str, ...] | list[str] = (),
) -> dict[str, bool]:
    raw_components = existing.get("components")
    if isinstance(raw_components, dict):
        legacy_cleanup = existing.get("codexRolloutContext")
        components = {
            "telegram": raw_components.get("telegram") is True,
            "miniApp": raw_components.get("miniApp") is True,
            "androidApp": raw_components.get("androidApp") is True,
            "codexContextCleanup": (
                raw_components.get("codexContextCleanup") is True
                if "codexContextCleanup" in raw_components
                else isinstance(legacy_cleanup, dict) and legacy_cleanup.get("enabled") is True
            ),
        }
    else:
        selected_profile = legacy_profile or str(existing.get("profile", "")).strip().lower()
        if selected_profile:
            components = dict(
                LEGACY_PROFILE_COMPONENTS.get(selected_profile, LEGACY_PROFILE_COMPONENTS["full"])
            )
        elif fresh_install:
            components = {
                "telegram": False,
                "miniApp": False,
                "androidApp": False,
                "codexContextCleanup": False,
            }
        else:
            components = dict(LEGACY_PROFILE_COMPONENTS["full"])
        legacy_cleanup = existing.get("codexRolloutContext")
        if isinstance(legacy_cleanup, dict) and legacy_cleanup.get("enabled") is True:
            components["codexContextCleanup"] = True
    component_names = {
        "telegram": "telegram",
        "mini-app": "miniApp",
        "android-app": "androidApp",
        "codex-context-cleanup": "codexContextCleanup",
    }
    for name in enabled:
        components[component_names[name]] = True
    for name in disabled:
        components[component_names[name]] = False
    if components["miniApp"] and "telegram" in disabled:
        raise ValueError("mini-app requires telegram; disable mini-app before disabling telegram")
    if components["miniApp"]:
        components["telegram"] = True
    return components


def _owned_extension_swap_artifacts(target: Path, kind: str) -> list[Path]:
    prefix = f".{target.name}.{kind}-"
    artifacts: list[Path] = []
    parent = target.parent.resolve()
    if not target.parent.is_dir():
        return artifacts
    for candidate in target.parent.iterdir():
        if not candidate.name.startswith(prefix):
            continue
        token = candidate.name[len(prefix):]
        if not SWAP_TOKEN_PATTERN.fullmatch(token):
            continue
        if candidate.is_symlink() or not candidate.is_dir() or candidate.resolve().parent != parent:
            raise RuntimeError(f"Refusing unsafe extension swap artifact: {candidate}")
        artifacts.append(candidate)
    return sorted(artifacts)


def _extension_package_matches(candidate: Path, package: dict) -> bool:
    try:
        return json.loads((candidate / "package.json").read_text(encoding="utf-8")) == package
    except (OSError, json.JSONDecodeError):
        return False


def recover_interrupted_extension_swap(target: Path, package: dict) -> bool:
    staging = _owned_extension_swap_artifacts(target, "staging")
    rollbacks = _owned_extension_swap_artifacts(target, "rollback")
    if not staging and not rollbacks:
        return False
    if target.exists():
        if target.is_symlink() or not _extension_package_matches(target, package):
            raise RuntimeError(f"Refusing to clean swap artifacts for invalid extension target: {target}")
    else:
        if len(rollbacks) > 1:
            raise RuntimeError(f"Cannot recover {target}: multiple rollback artifacts exist")
        if rollbacks:
            rollback = rollbacks.pop()
            if not _extension_package_matches(rollback, package):
                raise RuntimeError(f"Cannot recover invalid extension rollback: {rollback}")
            os.replace(rollback, target)
    for rollback in rollbacks:
        shutil.rmtree(rollback)
    for staged in staging:
        shutil.rmtree(staged)
    return True


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


def secure_runtime_root(target_root: Path) -> None:
    """Create the private runtime location before any secret is written there."""
    target_root.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        owner = subprocess.run(
            ["whoami"], check=True, capture_output=True, text=True, encoding="utf-8"
        ).stdout.strip()
        if not owner:
            raise RuntimeError("Cannot resolve the current Windows account for Agent Hub ACLs.")
        result = subprocess.run(
            [
                "icacls",
                str(target_root),
                "/inheritance:r",
                "/grant:r",
                f"{owner}:(OI)(CI)F",
                "/grant:r",
                "*S-1-5-18:(OI)(CI)F",
            ],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        if result.returncode != 0:
            raise RuntimeError(f"Cannot restrict Agent Hub runtime directory: {result.stderr.strip()}")
        return
    try:
        os.chmod(target_root, 0o700)
    except OSError as error:
        raise RuntimeError(f"Cannot restrict Agent Hub runtime directory: {target_root}") from error


def atomic_private_json(config_file: Path, value: dict) -> None:
    """Replace config only after a complete, owner-readable temporary file exists."""
    temporary: Path | None = None
    try:
        descriptor, raw_temporary = tempfile.mkstemp(
            prefix=f".{config_file.name}.", suffix=".tmp", dir=config_file.parent
        )
        temporary = Path(raw_temporary)
        os.chmod(temporary, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, config_file)
        temporary = None
        if os.name != "nt":
            os.chmod(config_file, 0o600)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


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
    except OSError as error:
        raise RuntimeError(f"Cannot read existing Agent Hub config: {config_file}") from error
    except json.JSONDecodeError as error:
        raise RuntimeError(f"Existing Agent Hub config is malformed: {config_file}") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"Existing Agent Hub config must be a JSON object: {config_file}")
    return value


def apply_rollout_image_cleanup_choice(config: dict, choice: str | None) -> dict:
    if choice is None:
        return config
    current = config.get("codexRolloutContext")
    settings = dict(current) if isinstance(current, dict) else {}
    enabled = choice == "enabled"
    settings["enabled"] = enabled
    settings.setdefault("scanIntervalSeconds", 30 * 60)
    components = dict(config.get("components") or {})
    components["codexContextCleanup"] = enabled
    return {**config, "components": components, "codexRolloutContext": settings}


def request_safe_restart() -> None:
    subprocess.run(["node", str(ROOT / "request-safe-restart.mjs")], check=True)


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
    recover_interrupted_extension_swap(target, package)
    staging = extensions_root / f".{target.name}.staging-{uuid4().hex}"
    rollback = extensions_root / f".{target.name}.rollback-{uuid4().hex}"
    removable_prefixes = (
        f"{package['publisher']}.{package['name']}-",
        "tyrael.work-log-view-",
    )
    try:
        shutil.copytree(
            source,
            staging,
            ignore=shutil.ignore_patterns("*.vsix", "node_modules", "__pycache__"),
        )
        staged_package = json.loads((staging / "package.json").read_text(encoding="utf-8"))
        if staged_package != package:
            raise RuntimeError("Staged VS Code extension package does not match source package.")
        if target.exists():
            os.replace(target, rollback)
        try:
            os.replace(staging, target)
        except Exception:
            if rollback.exists():
                os.replace(rollback, target)
            raise
        shutil.rmtree(rollback, ignore_errors=True)
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)

    # Only retire older copies after the replacement is usable.  A cleanup
    # failure leaves a working extension rather than removing all versions.
    for candidate in extensions_root.iterdir():
        resolved = candidate.resolve()
        if candidate == target or resolved.parent != extensions_root:
            continue
        if candidate.is_dir() and candidate.name.startswith(removable_prefixes):
            shutil.rmtree(resolved, ignore_errors=True)
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
            "--database",
            str(target_root / "data" / "journal.sqlite"),
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
        choices=tuple(LEGACY_PROFILE_COMPONENTS),
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--enable-component",
        action="append",
        choices=COMPONENTS,
        default=[],
        help="enable an optional component; repeat for multiple components",
    )
    parser.add_argument(
        "--disable-component",
        action="append",
        choices=COMPONENTS,
        default=[],
        help="disable an optional component; repeat for multiple components",
    )
    parser.add_argument("--token-file", type=Path)
    parser.add_argument("--user-id", type=int)
    parser.add_argument(
        "--project-root",
        type=Path,
        help="workspace whose personal SQLite journal is maintained; existing value is preserved when omitted",
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
    parser.add_argument(
        "--skip-restart",
        action="store_true",
        help="activate the new release without requesting a safe restart of a running Agent Hub",
    )
    args = parser.parse_args()
    require_embedded_sqlite()
    if args.extension_only:
        install_vscode_extension()
        return 0
    target_root = runtime_root()
    secure_runtime_root(target_root)

    config_file = target_root / "config.json"
    fresh_install = not config_file.exists()
    existing = read_existing_config(config_file)
    try:
        components = resolve_components(
            existing,
            fresh_install=fresh_install,
            legacy_profile=args.profile,
            enabled=args.enable_component,
            disabled=args.disable_component,
        )
    except ValueError as error:
        parser.error(str(error))
    project_root = (
        args.project_root.resolve()
        if args.project_root
        else Path(existing.get("projectRoot", ROOT.parent.parent)).resolve()
    )
    provider = args.provider or str(existing.get("provider", "codex")).strip().lower()
    if provider not in ("codex", "claude"):
        provider = "codex"
    telegram_enabled = components["telegram"]
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
            "host": "127.0.0.1",
            "port": 8787,
            "quickTunnel": {"enabled": False},
            "worker": {"enabled": False},
        }
    else:
        existing_mini_app = dict(existing_mini_app)
        existing_mini_app.pop("enabled", None)
    remembered_users = existing.get("allowedUserIds", [])
    remembered_chats = existing.get("allowedChatIds", remembered_users)
    config = {
        **existing,
        "components": components,
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
    config.pop("profile", None)
    config = apply_rollout_image_cleanup_choice(config, args.rollout_image_cleanup)
    atomic_private_json(config_file, config)
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
    elif not args.skip_restart:
        request_safe_restart()
    else:
        print("Configuration updated. Restart was skipped; the active runtime still uses the previous release.")
    legacy_config = ROOT / "config.json"
    if legacy_config.exists():
        legacy_config.unlink()
        print(f"Removed legacy workspace config: {legacy_config}")
    enabled_components = [name for name, enabled in components.items() if enabled]
    print(f"Agent Hub components: {', '.join(enabled_components) if enabled_components else 'core'}")
    print("Reload the VS Code window after first extension installation.")
    print("Run: npm run doctor")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
