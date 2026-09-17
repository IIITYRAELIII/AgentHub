from __future__ import annotations

import unittest
import json
import sys
import tempfile
from argparse import Namespace
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from AgentHub import install
from AgentHub.install import (
    apply_rollout_image_cleanup_choice,
    contour_only_component_change,
    request_safe_restart,
    resolve_components,
)
from AgentHub.whisper_runtime import nvidia_runtime_directories


class WhisperRuntimeTests(unittest.TestCase):
    def test_windows_runtime_discovers_installed_cublas_and_cudnn(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            prefix = Path(directory)
            cublas = prefix / "Lib" / "site-packages" / "nvidia" / "cublas" / "bin"
            cudnn = prefix / "Lib" / "site-packages" / "nvidia" / "cudnn" / "bin"
            cublas.mkdir(parents=True)
            cudnn.mkdir(parents=True)

            self.assertEqual(
                nvidia_runtime_directories(prefix, platform="win32"),
                (cublas, cudnn),
            )
            self.assertEqual(nvidia_runtime_directories(prefix, platform="linux"), ())


class ComponentSelectionTests(unittest.TestCase):
    def test_fresh_install_starts_with_core_only(self) -> None:
        self.assertEqual(
            resolve_components({}, fresh_install=True),
            {
                "telegram": False,
                "miniApp": False,
                "androidApp": False,
                "sharedDashboardBot": False,
                "codexContextCleanup": False,
                "testContour": False,
            },
        )

    def test_legacy_full_profile_enables_all_equivalent_components(self) -> None:
        self.assertEqual(
            resolve_components({"profile": "full"}, fresh_install=False),
            {
                "telegram": True,
                "miniApp": True,
                "androidApp": True,
                "sharedDashboardBot": False,
                "codexContextCleanup": False,
                "testContour": False,
            },
        )

    def test_mini_app_enables_telegram_dependency(self) -> None:
        self.assertEqual(
            resolve_components({}, fresh_install=True, enabled=["mini-app"]),
            {
                "telegram": True,
                "miniApp": True,
                "androidApp": False,
                "sharedDashboardBot": False,
                "codexContextCleanup": False,
                "testContour": False,
            },
        )

    def test_android_app_does_not_require_telegram(self) -> None:
        self.assertEqual(
            resolve_components({}, fresh_install=True, enabled=["android-app"]),
            {
                "telegram": False,
                "miniApp": False,
                "androidApp": True,
                "sharedDashboardBot": False,
                "codexContextCleanup": False,
                "testContour": False,
            },
        )

    def test_test_contour_is_explicit_opt_in_without_other_dependencies(self) -> None:
        self.assertEqual(
            resolve_components({}, fresh_install=True, enabled=["test-contour"]),
            {
                "telegram": False,
                "miniApp": False,
                "androidApp": False,
                "sharedDashboardBot": False,
                "codexContextCleanup": False,
                "testContour": True,
            },
        )

    def test_existing_test_contour_toggle_skips_production_install_side_effects(self) -> None:
        args = Namespace(
            enable_component=["test-contour"],
            disable_component=[],
            token_file=None,
            user_id=None,
            project_root=None,
            provider=None,
            with_voice=False,
            install_voice=False,
            rebuild_history=False,
            extension_only=False,
            rollout_image_cleanup=None,
        )
        self.assertTrue(contour_only_component_change(args, fresh_install=False))
        args.provider = "codex"
        self.assertFalse(contour_only_component_change(args, fresh_install=False))
        args.provider = None
        self.assertFalse(contour_only_component_change(args, fresh_install=True))

    def test_telegram_cannot_be_disabled_while_mini_app_remains_enabled(self) -> None:
        with self.assertRaisesRegex(ValueError, "requires telegram"):
            resolve_components(
                {"components": {"telegram": True, "miniApp": True, "androidApp": False}},
                fresh_install=False,
                disabled=["telegram"],
            )


class RolloutImageCleanupChoiceTests(unittest.TestCase):
    def test_missing_choice_does_not_create_a_decision(self) -> None:
        config = {"profile": "journal"}

        result = apply_rollout_image_cleanup_choice(config, None)

        self.assertFalse(result["components"]["codexContextCleanup"])
        self.assertNotIn("codexRolloutContext", result)

    def test_enabled_legacy_choice_is_forced_off(self) -> None:
        result = apply_rollout_image_cleanup_choice({}, "enabled")

        self.assertEqual(
            result["codexRolloutContext"],
            {"enabled": False, "scanIntervalSeconds": 1800},
        )
        self.assertFalse(result["components"]["codexContextCleanup"])

    def test_legacy_cleanup_choice_is_normalized_off(self) -> None:
        result = resolve_components(
            {"profile": "journal", "codexRolloutContext": {"enabled": True}},
            fresh_install=False,
        )

        self.assertFalse(result["codexContextCleanup"])

    def test_disabled_choice_preserves_existing_tuning(self) -> None:
        result = apply_rollout_image_cleanup_choice(
            {
                "codexRolloutContext": {
                    "enabled": True,
                    "scanIntervalSeconds": 1200,
                    "keepRecentImages": 6,
                }
            },
            "disabled",
        )

        self.assertEqual(
            result["codexRolloutContext"],
            {
                "enabled": False,
                "scanIntervalSeconds": 1200,
                "keepRecentImages": 6,
            },
        )
        self.assertFalse(result["components"]["codexContextCleanup"])


class SafeRestartTests(unittest.TestCase):
    @mock.patch("AgentHub.install.subprocess.run")
    def test_restart_uses_the_authenticated_runtime_control_client(self, run: mock.Mock) -> None:
        run.return_value.returncode = 0
        self.assertTrue(request_safe_restart())

        command = run.call_args.args[0]
        self.assertEqual("node", command[0])
        self.assertTrue(command[1].endswith("request-safe-restart.mjs"))
        self.assertEqual(False, run.call_args.kwargs["check"])

    @mock.patch("AgentHub.install.subprocess.run")
    def test_restart_reports_an_unavailable_runtime(self, run: mock.Mock) -> None:
        run.return_value.returncode = 1
        self.assertFalse(request_safe_restart())


class PersonalHistoryBackfillTests(unittest.TestCase):
    @mock.patch("AgentHub.install.subprocess.run")
    def test_backfill_targets_sqlite_without_creating_work_log(self, run: mock.Mock) -> None:
        project_root = Path("workspace")
        target_root = Path("runtime")

        install.backfill_personal_history(project_root, target_root)

        command = run.call_args.args[0]
        self.assertEqual(
            command[command.index("--database") + 1],
            str(target_root / "data" / "journal.sqlite"),
        )
        self.assertNotIn("--ledger", command)
        self.assertNotIn("--work-log", command)
        self.assertEqual(True, run.call_args.kwargs["check"])


class ParticipantProfileTests(unittest.TestCase):
    @mock.patch("AgentHub.install.subprocess.run")
    def test_github_login_ignores_legacy_encoded_path_before_json(self, run: mock.Mock) -> None:
        run.return_value = mock.Mock(
            returncode=0,
            stdout=(
                b"C:\\Users\\\x90\xa0\xa1\xae\xe7\xa0\xef\\.team\\101790935.json\r\n"
                b'{"github_login":"Holier-Than-Thou","github_user_id":101790935}\r\n'
            ),
        )

        self.assertEqual("Holier-Than-Thou", install.participant_github_login())
        self.assertNotIn("text", run.call_args.kwargs)
        self.assertNotIn("encoding", run.call_args.kwargs)


class SecureInstallationTests(unittest.TestCase):
    @mock.patch("AgentHub.install.subprocess.run")
    @mock.patch("AgentHub.install.os.name", "nt")
    def test_windows_acl_uses_sid_without_decoding_localized_account_name(self, run: mock.Mock) -> None:
        run.side_effect = [
            mock.Mock(
                stdout=b'"domain\\\xe0\xa0\xa1\xae\xe7\xa0\xef","S-1-5-21-100-200-300-1001"\r\n',
                returncode=0,
            ),
            mock.Mock(stdout="", stderr="", returncode=0),
        ]

        with tempfile.TemporaryDirectory() as temp:
            install.secure_runtime_root(Path(temp) / "runtime")

        self.assertEqual(["whoami", "/user", "/fo", "csv", "/nh"], run.call_args_list[0].args[0])
        self.assertNotIn("encoding", run.call_args_list[0].kwargs)
        self.assertEqual("oem", run.call_args_list[1].kwargs["encoding"])
        self.assertIn("*S-1-5-21-100-200-300-1001:(OI)(CI)F", run.call_args_list[1].args[0])

    def test_malformed_existing_config_fails_without_replacing_it(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            config = Path(temp) / "config.json"
            config.write_text("{broken", encoding="utf-8")

            with self.assertRaisesRegex(RuntimeError, "malformed"):
                install.read_existing_config(config)

            self.assertEqual("{broken", config.read_text(encoding="utf-8"))

    def test_failed_atomic_config_write_preserves_previous_secret(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            config = Path(temp) / "config.json"
            config.write_text('{"telegramBotToken":"old"}\n', encoding="utf-8")

            with mock.patch.object(install.json, "dump", side_effect=OSError("disk full")):
                with self.assertRaises(OSError):
                    install.atomic_private_json(config, {"telegramBotToken": "new"})

            self.assertEqual('{"telegramBotToken":"old"}\n', config.read_text(encoding="utf-8"))
            self.assertEqual([], list(Path(temp).glob("*.tmp")))

    def test_extension_staging_failure_keeps_working_version(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "agent-hub"
            source = root / "VSCodeExtension"
            source.mkdir(parents=True)
            package = {"publisher": "test", "name": "agent-hub", "version": "1.0.0"}
            (source / "package.json").write_text(json.dumps(package), encoding="utf-8")
            home = Path(temp) / "home"
            target = home / ".vscode" / "extensions" / "test.agent-hub-1.0.0"
            target.mkdir(parents=True)
            (target / "old.txt").write_text("working", encoding="utf-8")
            legacy = target.parent / "tyrael.work-log-view-0.4.1"
            legacy.mkdir()

            with (
                mock.patch.object(install, "ROOT", root),
                mock.patch("AgentHub.install.Path.home", return_value=home),
                mock.patch.object(install.shutil, "copytree", side_effect=OSError("copy failed")),
            ):
                with self.assertRaisesRegex(OSError, "copy failed"):
                    install.install_vscode_extension()

            self.assertEqual("working", (target / "old.txt").read_text(encoding="utf-8"))
            self.assertTrue(legacy.exists())

    def test_extension_install_removes_legacy_work_log_view_only_after_success(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "agent-hub"
            source = root / "VSCodeExtension"
            source.mkdir(parents=True)
            package = {"publisher": "test", "name": "agent-hub", "version": "1.0.0"}
            (source / "package.json").write_text(json.dumps(package), encoding="utf-8")
            home = Path(temp) / "home"
            extensions = home / ".vscode" / "extensions"
            legacy = extensions / "tyrael.work-log-view-0.4.1"
            newer_agent_hub = extensions / "test.agent-hub-2.0.0"
            unrelated = extensions / "example.unrelated-2.0.0"
            legacy.mkdir(parents=True)
            newer_agent_hub.mkdir()
            unrelated.mkdir()

            with (
                mock.patch.object(install, "ROOT", root),
                mock.patch("AgentHub.install.Path.home", return_value=home),
            ):
                target = install.install_vscode_extension()

            self.assertIsNotNone(target)
            self.assertTrue(target.is_dir())
            self.assertFalse(legacy.exists())
            self.assertTrue(newer_agent_hub.exists())
            self.assertTrue(unrelated.exists())

    def test_changed_extension_content_gets_a_new_install_version_automatically(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "agent-hub"
            source = root / "VSCodeExtension"
            source.mkdir(parents=True)
            package = {"publisher": "test", "name": "agent-hub", "version": "1.0.0"}
            (source / "package.json").write_text(json.dumps(package), encoding="utf-8")
            (source / "extension.js").write_text("new content", encoding="utf-8")
            home = Path(temp) / "home"
            installed = home / ".vscode" / "extensions" / "test.agent-hub-1.0.0"
            installed.mkdir(parents=True)
            (installed / "package.json").write_text(json.dumps(package), encoding="utf-8")
            (installed / "extension.js").write_text("old content", encoding="utf-8")

            with (
                mock.patch.object(install, "ROOT", root),
                mock.patch("AgentHub.install.Path.home", return_value=home),
            ):
                target = install.install_vscode_extension()

            self.assertEqual("test.agent-hub-1.0.1", target.name)
            self.assertEqual("1.0.1", json.loads((target / "package.json").read_text(encoding="utf-8"))["version"])
            self.assertEqual(
                install.extension_source_fingerprint(source),
                (target / ".agent-hub-source.sha256").read_text(encoding="ascii").strip(),
            )

    def test_current_extension_content_is_not_reinstalled(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "agent-hub"
            source = root / "VSCodeExtension"
            source.mkdir(parents=True)
            package = {"publisher": "test", "name": "agent-hub", "version": "1.0.0"}
            (source / "package.json").write_text(json.dumps(package), encoding="utf-8")
            home = Path(temp) / "home"

            with (
                mock.patch.object(install, "ROOT", root),
                mock.patch("AgentHub.install.Path.home", return_value=home),
            ):
                first = install.install_vscode_extension()
                second = install.install_vscode_extension()

            self.assertEqual(first, second)
            self.assertFalse((first.parent / "test.agent-hub-1.0.1").exists())

    def test_test_contour_extension_uses_an_independent_profile(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "agent-hub"
            source = root / "VSCodeExtension"
            source.mkdir(parents=True)
            package = {
                "publisher": "test",
                "name": "agent-hub",
                "displayName": "Agent Hub",
                "description": "production",
                "version": "1.0.0",
                "activationEvents": [],
                "contributes": {
                    "viewsContainers": {},
                    "views": {},
                    "commands": [],
                },
            }
            (source / "package.json").write_text(json.dumps(package), encoding="utf-8")
            home = Path(temp) / "home"

            with (
                mock.patch.object(install, "ROOT", root),
                mock.patch("AgentHub.install.Path.home", return_value=home),
            ):
                target = install.install_vscode_extension("test-contour")

            self.assertEqual("test.agent-hub-test-contour-1.0.0", target.name)
            installed = json.loads((target / "package.json").read_text(encoding="utf-8"))
            profile = json.loads((target / "extension-profile.json").read_text(encoding="utf-8"))
            self.assertEqual("agent-hub-test-contour", installed["name"])
            self.assertEqual("Agent Hub Test", installed["displayName"])
            self.assertEqual(
                "media/agent-hub-test.svg",
                installed["contributes"]["viewsContainers"]["activitybar"][0]["icon"],
            )
            self.assertEqual("agentHubTestContour.open", installed["contributes"]["commands"][0]["command"])
            self.assertEqual({"profile": "test-contour"}, profile)

    def test_extension_install_recovers_crash_after_target_was_moved_to_rollback(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "agent-hub"
            source = root / "VSCodeExtension"
            source.mkdir(parents=True)
            package = {"publisher": "test", "name": "agent-hub", "version": "1.0.0"}
            (source / "package.json").write_text(json.dumps(package), encoding="utf-8")
            home = Path(temp) / "home"
            extensions = home / ".vscode" / "extensions"
            target = extensions / "test.agent-hub-1.0.0"
            rollback = extensions / f".{target.name}.rollback-{'a' * 32}"
            stale_staging = extensions / f".{target.name}.staging-{'b' * 32}"
            rollback.mkdir(parents=True)
            stale_staging.mkdir()
            (rollback / "package.json").write_text(json.dumps(package), encoding="utf-8")
            (rollback / "old.txt").write_text("working", encoding="utf-8")
            (stale_staging / "package.json").write_text(json.dumps(package), encoding="utf-8")

            with (
                mock.patch.object(install, "ROOT", root),
                mock.patch("AgentHub.install.Path.home", return_value=home),
                mock.patch.object(install.shutil, "copytree", side_effect=OSError("copy failed")),
            ):
                with self.assertRaisesRegex(OSError, "copy failed"):
                    install.install_vscode_extension()

            self.assertEqual("working", (target / "old.txt").read_text(encoding="utf-8"))
            self.assertFalse(rollback.exists())
            self.assertFalse(stale_staging.exists())

    def test_extension_recovery_preserves_ambiguous_rollbacks_and_staging(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            package = {"publisher": "test", "name": "agent-hub", "version": "1.0.0"}
            target = Path(temp) / "extensions" / "test.agent-hub-1.0.0"
            artifacts = [
                target.parent / f".{target.name}.rollback-{'a' * 32}",
                target.parent / f".{target.name}.rollback-{'b' * 32}",
                target.parent / f".{target.name}.staging-{'c' * 32}",
            ]
            for artifact in artifacts:
                artifact.mkdir(parents=True, exist_ok=True)
                (artifact / "package.json").write_text(json.dumps(package), encoding="utf-8")

            with self.assertRaisesRegex(RuntimeError, "multiple rollback"):
                install.recover_interrupted_extension_swap(target, package)

            self.assertTrue(all(artifact.exists() for artifact in artifacts))


if __name__ == "__main__":
    unittest.main()
