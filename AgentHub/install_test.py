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

        with tempfile.TemporaryDirectory() as directory:
            utilities_root = Path(directory)
            with mock.patch.object(install, "ROOT", utilities_root / "AgentHub"):
                self.assertIsNone(install.participant_github_login())
                run.assert_not_called()
                profile_tool = utilities_root / "AI_INFRA_SETUP" / "team_profile.py"
                profile_tool.parent.mkdir()
                profile_tool.touch()
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
















if __name__ == "__main__":
    unittest.main()
