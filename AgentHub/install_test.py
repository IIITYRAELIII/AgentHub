from __future__ import annotations

import unittest
import json
import tempfile
from pathlib import Path
from unittest import mock

from AgentHub import install
from AgentHub.install import apply_rollout_image_cleanup_choice, request_safe_restart, resolve_components


class ComponentSelectionTests(unittest.TestCase):
    def test_fresh_install_starts_with_core_only(self) -> None:
        self.assertEqual(
            resolve_components({}, fresh_install=True),
            {"telegram": False, "miniApp": False, "androidApp": False},
        )

    def test_legacy_full_profile_enables_all_equivalent_components(self) -> None:
        self.assertEqual(
            resolve_components({"profile": "full"}, fresh_install=False),
            {"telegram": True, "miniApp": True, "androidApp": True},
        )

    def test_mini_app_enables_telegram_dependency(self) -> None:
        self.assertEqual(
            resolve_components({}, fresh_install=True, enabled=["mini-app"]),
            {"telegram": True, "miniApp": True, "androidApp": False},
        )

    def test_android_app_does_not_require_telegram(self) -> None:
        self.assertEqual(
            resolve_components({}, fresh_install=True, enabled=["android-app"]),
            {"telegram": False, "miniApp": False, "androidApp": True},
        )

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

        self.assertIs(result, config)
        self.assertNotIn("codexRolloutContext", result)

    def test_enabled_choice_records_default_interval(self) -> None:
        result = apply_rollout_image_cleanup_choice({}, "enabled")

        self.assertEqual(
            result["codexRolloutContext"],
            {"enabled": True, "scanIntervalSeconds": 900},
        )

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


class SafeRestartTests(unittest.TestCase):
    @mock.patch("AgentHub.install.subprocess.run")
    def test_restart_uses_the_authenticated_runtime_control_client(self, run: mock.Mock) -> None:
        request_safe_restart()

        command = run.call_args.args[0]
        self.assertEqual("node", command[0])
        self.assertTrue(command[1].endswith("request-safe-restart.mjs"))
        self.assertEqual(True, run.call_args.kwargs["check"])


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


class SecureInstallationTests(unittest.TestCase):
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

            with (
                mock.patch.object(install, "ROOT", root),
                mock.patch("AgentHub.install.Path.home", return_value=home),
                mock.patch.object(install.shutil, "copytree", side_effect=OSError("copy failed")),
            ):
                with self.assertRaisesRegex(OSError, "copy failed"):
                    install.install_vscode_extension()

            self.assertEqual("working", (target / "old.txt").read_text(encoding="utf-8"))

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
