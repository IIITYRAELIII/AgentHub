from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import venv
import shutil
from uuid import uuid4
from datetime import date
from pathlib import Path


ROOT = Path(__file__).resolve().parent
COMPONENTS = ("telegram", "mini-app", "android-app", "shared-dashboard-bot", "test-contour")
LEGACY_PROFILE_COMPONENTS = {
    "full": {"telegram": True, "miniApp": True, "androidApp": True, "sharedDashboardBot": False, "codexContextCleanup": False, "testContour": False},
    "telegram": {"telegram": True, "miniApp": False, "androidApp": False, "sharedDashboardBot": False, "codexContextCleanup": False, "testContour": False},
    "journal": {"telegram": False, "miniApp": False, "androidApp": False, "sharedDashboardBot": False, "codexContextCleanup": False, "testContour": False},
}
SWAP_TOKEN_PATTERN = re.compile(r"[0-9a-f]{32}\Z")
EXTENSION_PROFILES = ("production", "test-contour")
EXTENSION_PROVENANCE_FILE = ".agent-hub-source.json"


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
            "sharedDashboardBot": raw_components.get("sharedDashboardBot") is True,
            "testContour": raw_components.get("testContour") is True,
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
                "sharedDashboardBot": False,
                "codexContextCleanup": False,
                "testContour": False,
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
        "shared-dashboard-bot": "sharedDashboardBot",
        "test-contour": "testContour",
    }
    for name in enabled:
        components[component_names[name]] = True
    for name in disabled:
        components[component_names[name]] = False
    if components["miniApp"] and "telegram" in disabled:
        raise ValueError("mini-app requires telegram; disable mini-app before disabling telegram")
    if components["miniApp"]:
        components["telegram"] = True
    # Очистка rollout временно недоступна: обновление нормализует старое
    # локальное opt-in и не оставляет скрыто работающий компонент.
    components["codexContextCleanup"] = False
    return components


def contour_only_component_change(args: argparse.Namespace, *, fresh_install: bool) -> bool:
    return (
        not fresh_install
        and set(args.enable_component + args.disable_component) == {"test-contour"}
        and not any((
            args.token_file,
            args.user_id,
            args.project_root,
            args.provider,
            args.with_voice,
            args.install_voice,
            args.rebuild_history,
            args.extension_only,
            args.rollout_image_cleanup,
        ))
    )


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
        owner_result = subprocess.run(
            ["whoami", "/user", "/fo", "csv", "/nh"],
            check=True,
            capture_output=True,
        )
        sid_match = re.search(rb"S-\d+(?:-\d+)+", owner_result.stdout)
        if sid_match is None:
            raise RuntimeError("Cannot resolve the current Windows SID for Agent Hub ACLs.")
        owner_sid = sid_match.group(0).decode("ascii")
        result = subprocess.run(
            [
                "icacls",
                str(target_root),
                "/inheritance:r",
                "/grant:r",
                f"*{owner_sid}:(OI)(CI)F",
                "/grant:r",
                "*S-1-5-18:(OI)(CI)F",
            ],
            check=False,
            capture_output=True,
            text=True,
            encoding="oem",
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


def atomic_private_text(target: Path, value: str) -> None:
    """Replace a small secret file without exposing a partially written value."""
    temporary: Path | None = None
    try:
        descriptor, raw_temporary = tempfile.mkstemp(
            prefix=f".{target.name}.", suffix=".tmp", dir=target.parent
        )
        temporary = Path(raw_temporary)
        os.chmod(temporary, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(value.rstrip("\n"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
        temporary = None
        if os.name != "nt":
            os.chmod(target, 0o600)
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
        "WHISPER_MODEL": "large-v3-turbo",
        "WHISPER_MODEL_DIR": str(target_root / "data" / "models" / "whisper"),
        "WHISPER_DEVICE": "cuda",
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
    current = config.get("codexRolloutContext")
    settings = dict(current) if isinstance(current, dict) else {}
    components = dict(config.get("components") or {})
    components["codexContextCleanup"] = False
    result = {**config, "components": components}
    if settings or choice is not None:
        settings["enabled"] = False
        settings.setdefault("scanIntervalSeconds", 30 * 60)
        result["codexRolloutContext"] = settings
    return result


def request_safe_restart() -> bool:
    result = subprocess.run(["node", str(ROOT / "request-safe-restart.mjs")], check=False)
    return result.returncode == 0


def vscode_extension_package(source_package: dict, profile: str = "production") -> dict:
    if profile not in EXTENSION_PROFILES:
        raise ValueError(f"Unknown VS Code extension profile: {profile}")
    package = json.loads(json.dumps(source_package))
    if profile == "production":
        return package
    package.update({
        "name": "agent-hub-test-contour",
        "displayName": "Agent Hub Test",
        "description": "Изолированный VS Code-клиент тестового контура Agent Hub.",
    })
    package["activationEvents"] = [
        "onView:agentHubTestContour.view",
        "onCommand:agentHubTestContour.open",
        "onCommand:agentHubTestContour.refresh",
    ]
    contributes = package["contributes"]
    contributes["viewsContainers"] = {
        "activitybar": [{
            "id": "agentHubTestContour",
            "title": "Agent Hub Test",
            "icon": "media/agent-hub-test.svg",
        }]
    }
    contributes["views"] = {
        "agentHubTestContour": [{
            "type": "webview",
            "id": "agentHubTestContour.view",
            "name": "Agent Hub Test",
        }]
    }
    contributes["commands"] = [
        {
            "command": "agentHubTestContour.open",
            "title": "Открыть Agent Hub Test",
            "category": "Agent Hub Test",
            "icon": "$(open-preview)",
        },
        {
            "command": "agentHubTestContour.refresh",
            "title": "Обновить Agent Hub Test",
            "category": "Agent Hub Test",
            "icon": "$(refresh)",
        },
    ]
    return package


def extension_source_fingerprint(source: Path) -> str:
    digest = hashlib.sha256()
    for file in sorted(source.rglob("*"), key=lambda item: item.relative_to(source).as_posix()):
        relative = file.relative_to(source)
        if (
            not file.is_file()
            or file.name.endswith(".vsix")
            or "node_modules" in relative.parts
            or "__pycache__" in relative.parts
            or file.name in (".agent-hub-source.sha256", EXTENSION_PROVENANCE_FILE)
        ):
            continue
        digest.update(relative.as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(file.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def numeric_extension_version(value: str) -> tuple[int, int, int]:
    parts = value.split(".")
    if len(parts) != 3 or any(not part.isdigit() for part in parts):
        raise RuntimeError(f"VS Code extension version must be numeric SemVer: {value}")
    return tuple(int(part) for part in parts)


def extension_source_revision() -> str:
    try:
        revision = subprocess.run(
            ["git", "-C", str(ROOT), "rev-parse", "HEAD^{commit}"],
            check=True,
            capture_output=True,
            encoding="utf-8",
        ).stdout.strip().lower()
    except (OSError, subprocess.CalledProcessError) as error:
        raise RuntimeError("VS Code extension source revision is unavailable") from error
    if not re.fullmatch(r"[a-f0-9]{40,64}", revision):
        raise RuntimeError("VS Code extension source revision is invalid")
    return revision


def extension_revision_is_ancestor(previous: str, current: str) -> bool:
    try:
        result = subprocess.run(
            ["git", "-C", str(ROOT), "merge-base", "--is-ancestor", previous, current],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError as error:
        raise RuntimeError("Cannot verify VS Code extension source ancestry") from error
    if result.returncode == 0:
        return True
    if result.returncode == 1:
        return False
    raise RuntimeError("Cannot verify VS Code extension source ancestry")


def extension_source_provenance(
    source: Path,
    fingerprint: str,
    revision: str,
    release_version: str | None = None,
) -> dict:
    if release_version is None:
        release_package = ROOT / "package.json"
        package_file = release_package if release_package.is_file() else source / "package.json"
        package = json.loads(package_file.read_text(encoding="utf-8"))
        release_version = str(package["version"])
    if not re.fullmatch(r"[a-f0-9]{40,64}", revision):
        raise RuntimeError("VS Code extension source revision is invalid")
    return {
        "schemaVersion": 1,
        "releaseVersion": release_version,
        "sourceRevision": revision,
        "sourceFingerprint": fingerprint,
    }


def read_extension_provenance(candidate: Path) -> dict | None:
    file = candidate / EXTENSION_PROVENANCE_FILE
    if not file.exists():
        return None
    try:
        value = json.loads(file.read_text(encoding="utf-8"))
        release_version = str(value["releaseVersion"])
        revision = str(value["sourceRevision"]).lower()
        fingerprint = str(value["sourceFingerprint"])
        if (
            value.get("schemaVersion") != 1
            or not re.fullmatch(r"[a-f0-9]{40,64}", revision)
            or not re.fullmatch(r"[a-f0-9]{64}", fingerprint)
        ):
            raise ValueError("invalid extension provenance")
        recorded_fingerprint = (candidate / ".agent-hub-source.sha256").read_text(encoding="ascii").strip()
        if recorded_fingerprint != fingerprint:
            raise ValueError("extension provenance fingerprint mismatch")
        return {
            "schemaVersion": 1,
            "releaseVersion": release_version,
            "sourceRevision": revision,
            "sourceFingerprint": fingerprint,
        }
    except (OSError, KeyError, ValueError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Installed VS Code extension provenance is invalid: {candidate}") from error


def extension_install_version(requested: str, installed: list[str]) -> str:
    requested_tuple = numeric_extension_version(requested)
    installed_tuples = [numeric_extension_version(value) for value in installed]
    if not installed_tuples or requested_tuple > max(installed_tuples):
        return requested
    major, minor, patch = max(installed_tuples)
    return f"{major}.{minor}.{patch + 1}"


def _installed_vscode_extensions(package: dict, extensions_root: Path) -> list[dict]:
    prefix = f"{package['publisher']}.{package['name']}-"
    installed = []
    if not extensions_root.is_dir():
        return installed
    for candidate in extensions_root.iterdir():
        if not candidate.is_dir() or not candidate.name.startswith(prefix):
            continue
        # Inventory is read-only: existing installations may be directory links.
        # Replacement targets are checked separately before any staging or write.
        resolved = candidate.resolve()
        try:
            installed_package = json.loads((candidate / "package.json").read_text(encoding="utf-8"))
            installed_version = str(installed_package["version"])
            numeric_extension_version(installed_version)
            if (
                installed_package.get("publisher") != package["publisher"]
                or installed_package.get("name") != package["name"]
                or candidate.name != f"{prefix}{installed_version}"
            ):
                continue
            try:
                installed_fingerprint = (candidate / ".agent-hub-source.sha256").read_text(
                    encoding="ascii",
                ).strip()
            except FileNotFoundError:
                installed_fingerprint = None
            installed.append({
                "target": resolved,
                "version": installed_version,
                "fingerprint": installed_fingerprint,
                "provenance": read_extension_provenance(candidate),
            })
        except (OSError, KeyError, ValueError, json.JSONDecodeError):
            continue
    return installed


def _installed_extension_identity(entry: dict | None) -> str:
    if entry is None:
        return "none"
    if entry["provenance"] is not None:
        return f"revision:{entry['provenance']['sourceRevision']}"
    fingerprint = entry["fingerprint"] or extension_source_fingerprint(entry["target"])
    return f"legacy:{fingerprint}"


def installed_vscode_extension_identity(profile: str = "production", *, extensions_root: Path | None = None) -> str:
    source_package = json.loads((ROOT / "VSCodeExtension" / "package.json").read_text(encoding="utf-8"))
    package = vscode_extension_package(source_package, profile)
    root = (extensions_root or (Path.home() / ".vscode" / "extensions")).resolve()
    installed = _installed_vscode_extensions(package, root)
    newest = max(installed, key=lambda entry: numeric_extension_version(entry["version"]), default=None)
    return _installed_extension_identity(newest)


def vscode_extension_install_plan(
    profile: str = "production",
    *,
    source_revision: str | None = None,
    release_version: str | None = None,
    expected_installed_identity: str | None = None,
    extensions_root: Path | None = None,
) -> dict:
    source = ROOT / "VSCodeExtension"
    source_package = json.loads((source / "package.json").read_text(encoding="utf-8"))
    package = vscode_extension_package(source_package, profile)
    root = (extensions_root or (Path.home() / ".vscode" / "extensions")).resolve()
    fingerprint = extension_source_fingerprint(source)
    revision = (source_revision or extension_source_revision()).strip().lower()
    provenance = extension_source_provenance(source, fingerprint, revision, release_version)
    installed = _installed_vscode_extensions(package, root)
    installed_versions = [entry["version"] for entry in installed]
    newest = max(installed, key=lambda entry: numeric_extension_version(entry["version"]), default=None)
    installed_identity = _installed_extension_identity(newest)
    expected = str(expected_installed_identity or "").strip().lower()
    if (
        newest is not None
        and newest["provenance"] is not None
        and newest["fingerprint"] == fingerprint
    ):
        return {
            "profile": profile,
            "action": "current",
            "package": json.loads((newest["target"] / "package.json").read_text(encoding="utf-8")),
            "provenance": newest["provenance"],
            "sourceFingerprint": newest["fingerprint"],
            "installedIdentity": installed_identity,
            "targetName": newest["target"].name,
        }
    if expected and expected != installed_identity:
        raise RuntimeError(
            "VS Code extension installed identity changed: "
            f"expected {expected}, observed {installed_identity}"
        )
    if newest is not None and newest["provenance"] is not None:
        installed_revision = newest["provenance"]["sourceRevision"]
        if installed_revision == revision:
            raise RuntimeError("VS Code extension fingerprint changed within the same source revision")
        if expected != installed_identity and not extension_revision_is_ancestor(installed_revision, revision):
            raise RuntimeError(
                "Refusing VS Code extension source without descendant proof; "
                f"installed identity is {installed_identity}"
            )
    package["version"] = extension_install_version(str(package["version"]), installed_versions)
    return {
        "profile": profile,
        "action": "install",
        "package": package,
        "provenance": provenance,
        "sourceFingerprint": fingerprint,
        "installedIdentity": installed_identity,
        "targetName": f"{package['publisher']}.{package['name']}-{package['version']}",
    }


def _prepared_extension_plan_is_applied(plan: dict, prepared_plan: dict) -> bool:
    provenance = prepared_plan.get("provenance")
    if not isinstance(provenance, dict):
        return False
    return (
        prepared_plan.get("action") == "install"
        and plan.get("action") == "current"
        and plan.get("targetName") == prepared_plan.get("targetName")
        and plan.get("package") == prepared_plan.get("package")
        and plan.get("sourceFingerprint") == prepared_plan.get("sourceFingerprint")
        and plan.get("provenance") == provenance
        and plan.get("installedIdentity") == f"revision:{provenance.get('sourceRevision')}"
    )


def install_vscode_extension(
    profile: str = "production",
    *,
    source_revision: str | None = None,
    release_version: str | None = None,
    expected_installed_identity: str | None = None,
    prepared_plan: dict | None = None,
) -> Path | None:
    source = ROOT / "VSCodeExtension"
    if not source.is_dir():
        print("VS Code extension source is not present; skipped.")
        return None
    extensions_root = (Path.home() / ".vscode" / "extensions").resolve()
    plan = vscode_extension_install_plan(
        profile,
        source_revision=source_revision,
        release_version=release_version,
        expected_installed_identity=expected_installed_identity,
        extensions_root=extensions_root,
    )
    if prepared_plan is not None and plan != prepared_plan:
        if _prepared_extension_plan_is_applied(plan, prepared_plan):
            target = (extensions_root / plan["targetName"]).resolve()
            print(f"VS Code extension is current: {target}")
            return target
        raise RuntimeError("Prepared VS Code extension install plan changed")
    package = plan["package"]
    source_package = json.loads((source / "package.json").read_text(encoding="utf-8"))
    requested_id = f"{package['publisher']}.{package['name']}-{package['version']}"
    requested_target = (extensions_root / requested_id).resolve()
    target = (extensions_root / plan["targetName"]).resolve()
    if plan["action"] == "current":
        print(f"VS Code extension is current: {target}")
        return target
    fingerprint = plan["sourceFingerprint"]
    provenance = plan["provenance"]
    if target.parent != extensions_root or not target.name.startswith(f"{package['publisher']}.{package['name']}-"):
        raise RuntimeError(f"Refusing to replace unexpected extension path: {target}")
    extensions_root.mkdir(parents=True, exist_ok=True)
    recover_interrupted_extension_swap(requested_target, vscode_extension_package(source_package, profile))
    if target != requested_target:
        recover_interrupted_extension_swap(target, package)
    staging = extensions_root / f".{target.name}.staging-{uuid4().hex}"
    rollback = extensions_root / f".{target.name}.rollback-{uuid4().hex}"
    # VS Code owns retirement of its previous Agent Hub versions.  A publisher
    # running from a stale checkout must never delete a newer version that VS
    # Code has already registered or loaded; doing so leaves extensions.json
    # pointing at a directory without package.json until the next repair.
    removable_prefixes = ("tyrael.work-log-view-",) if profile == "production" else ()
    try:
        shutil.copytree(
            source,
            staging,
            ignore=shutil.ignore_patterns("*.vsix", "node_modules", "__pycache__"),
        )
        (staging / "package.json").write_text(
            json.dumps(package, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        (staging / ".agent-hub-source.sha256").write_text(f"{fingerprint}\n", encoding="ascii")
        (staging / EXTENSION_PROVENANCE_FILE).write_text(
            json.dumps(provenance, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        profile_file = staging / "extension-profile.json"
        if profile == "test-contour":
            profile_file.write_text(
                json.dumps({"profile": "test-contour"}, indent=2) + "\n",
                encoding="utf-8",
            )
        elif profile_file.exists():
            profile_file.unlink()
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


def uninstall_vscode_extension(profile: str) -> list[Path]:
    if profile not in EXTENSION_PROFILES:
        raise ValueError(f"Unknown VS Code extension profile: {profile}")
    source = ROOT / "VSCodeExtension"
    source_package = json.loads((source / "package.json").read_text(encoding="utf-8"))
    package = vscode_extension_package(source_package, profile)
    extensions_root = (Path.home() / ".vscode" / "extensions").resolve()
    if not extensions_root.is_dir():
        return []
    prefix = f"{package['publisher']}.{package['name']}-"
    removed = []
    for candidate in extensions_root.iterdir():
        if not candidate.name.startswith(prefix):
            continue
        resolved = candidate.resolve()
        if candidate.is_symlink() or not candidate.is_dir() or resolved.parent != extensions_root:
            raise RuntimeError(f"Refusing to remove unsafe extension path: {candidate}")
        try:
            installed = json.loads((candidate / "package.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError(f"Refusing to remove invalid extension: {candidate}") from error
        if installed.get("publisher") != package["publisher"] or installed.get("name") != package["name"]:
            raise RuntimeError(f"Refusing to remove foreign extension: {candidate}")
        shutil.rmtree(resolved)
        removed.append(resolved)
    return removed


def install_autostart() -> None:
    if sys.platform != "win32":
        return
    subprocess.run(
        [str(runtime_root() / "AgentHub.RuntimeHost.exe"), "--install-autostart"],
        check=True,
    )


def start_runtime(target_root: Path) -> None:
    if sys.platform == "win32":
        launcher = target_root / "AgentHub.RuntimeHost.exe"
        subprocess.Popen(
            [str(launcher)],
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


def participant_github_login() -> str | None:
    profile_tool = ROOT.parent / "AI_INFRA_SETUP" / "team_profile.py"
    if not profile_tool.is_file():
        return None
    result = subprocess.run(
        [
            sys.executable,
            str(profile_tool),
            "--utilities",
            str(ROOT.parent),
            "changelog-author",
        ],
        cwd=ROOT.parent,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        return None
    start = result.stdout.find(b"{")
    if start < 0:
        return None
    try:
        value = json.loads(result.stdout[start:])
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    login = str(value.get("github_login", "")).strip()
    return login or None


def backfill_team_rate_limit_accounts(target_root: Path, participant: str | None = None) -> None:
    login = (participant or participant_github_login() or "").strip()
    if not login:
        print("Team rate-limit account migration skipped: participant profile is unavailable.")
        return
    subprocess.run(
        [
            "node",
            str(ROOT / "src" / "interfaces" / "cli" / "rate-limit-account-backfill.mjs"),
            "--database",
            str(target_root / "data" / "journal.sqlite"),
            "--participant",
            login,
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
        "--extension-replace-from",
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--skip-autostart",
        action="store_true",
        help="do not add Agent Hub to the current user's startup",
    )
    parser.add_argument(
        "--rollout-image-cleanup",
        choices=("enabled", "disabled"),
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--skip-restart",
        action="store_true",
        help="activate the new release without requesting a safe restart of a running Agent Hub",
    )
    parser.add_argument("--participant-login", help=argparse.SUPPRESS)
    args = parser.parse_args()
    require_embedded_sqlite()
    if args.extension_only:
        install_vscode_extension(expected_installed_identity=args.extension_replace_from)
        existing = read_existing_config(runtime_root() / "config.json")
        if isinstance(existing.get("components"), dict) and existing["components"].get("testContour") is True:
            install_vscode_extension("test-contour", expected_installed_identity=args.extension_replace_from)
        return 0
    target_root = runtime_root()
    secure_runtime_root(target_root)

    config_file = target_root / "config.json"
    fresh_install = not config_file.exists()
    existing = read_existing_config(config_file)
    previous_test_contour = (
        isinstance(existing.get("components"), dict)
        and existing["components"].get("testContour") is True
    )
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
    existing_shared_bot = existing.get("sharedDashboardBot")
    if not isinstance(existing_shared_bot, dict):
        existing_shared_bot = {}
    shared_bot = dict(existing_shared_bot)
    if components["sharedDashboardBot"]:
        shared_bot.setdefault("publicUrl", "https://hub.darksanctuary.ru")
        shared_bot.setdefault("hubId", str(uuid4()))
        shared_bot.setdefault("hubName", f"Agent Hub — {project_root.name}")
        shared_bot.setdefault("secretFile", "shared-dashboard-bot.secret")
        shared_bot.setdefault("retrySeconds", 5)
        shared_secret_file = (target_root / str(shared_bot["secretFile"])).resolve()
        if not shared_secret_file.is_relative_to(target_root.resolve()):
            raise RuntimeError("Shared Dashboard bot secret file must stay inside the Agent Hub runtime")
        if not shared_secret_file.exists():
            atomic_private_text(shared_secret_file, secrets.token_urlsafe(48))
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
        "sharedDashboardBot": shared_bot,
        "voiceEnabled": bool(existing.get("voiceEnabled")) or args.with_voice or args.install_voice,
        "whisperModel": "large-v3-turbo",
        "whisperDevice": "cuda",
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
    if components["testContour"]:
        subprocess.run(
            ["node", str(ROOT / "test-contour.mjs"), "install", "--component-approved"],
            check=True,
        )
        if not args.skip_extension:
            install_vscode_extension("test-contour", expected_installed_identity=args.extension_replace_from)
    elif previous_test_contour:
        subprocess.run(
            ["node", str(ROOT / "test-contour.mjs"), "uninstall", "--component-approved"],
            check=True,
        )
        if not args.skip_extension:
            uninstall_vscode_extension("test-contour")
    contour_only_change = contour_only_component_change(args, fresh_install=fresh_install)
    if contour_only_change:
        print("Agent Hub Test component updated without production deploy or restart.")
        return 0
    if args.install_voice:
        install_voice(target_root)
    subprocess.run(["node", str(ROOT / "runtime-manager.mjs"), "deploy"], check=True)
    subprocess.run(["node", str(ROOT / "runtime-manager.mjs"), "activate"], check=True)
    subprocess.run(
        ["node", str(ROOT / "src" / "infrastructure" / "codex" / "codex-hook-config.mjs"), "install"],
        check=True,
    )
    if not args.skip_history and (fresh_install or args.rebuild_history):
        backfill_personal_history(project_root, target_root)
    backfill_team_rate_limit_accounts(target_root, args.participant_login)
    if not args.skip_extension:
        install_vscode_extension(expected_installed_identity=args.extension_replace_from)
    if not args.skip_autostart:
        install_autostart()
    if fresh_install:
        start_runtime(target_root)
        print("Agent Hub runtime started.")
    elif not args.skip_restart:
        if not request_safe_restart():
            start_runtime(target_root)
            print("Running Agent Hub was unavailable; the installed RuntimeHost was started directly.")
    else:
        print("Configuration updated. Restart was skipped; the active runtime still uses the previous release.")
    legacy_config = ROOT / "config.json"
    if legacy_config.exists():
        legacy_config.unlink()
        print(f"Removed legacy workspace config: {legacy_config}")
    enabled_components = [name for name, enabled in components.items() if enabled]
    print(f"Agent Hub components: {', '.join(enabled_components) if enabled_components else 'core'}")
    if components["sharedDashboardBot"]:
        print("Pair the shared Dashboard bot: npm run dashboard-bot:pair")
    if components["testContour"]:
        print("Start the isolated Test Contour: npm run contour:refresh")
    print("Reload the VS Code window after first extension installation.")
    print("Run: npm run doctor")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
