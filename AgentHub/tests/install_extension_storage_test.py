"""Executable extension placement and interrupted-publication boundaries."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from AgentHub import install


def junction(target: Path, link: Path) -> None:
    if os.name == "nt":
        import _winapi
        _winapi.CreateJunction(str(target), str(link))
    else:
        link.symlink_to(target, target_is_directory=True)


class ExtensionStorageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="hub-extension-storage-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.source_root = self.base / "source"
        self.source = self.source_root / "VSCodeExtension"
        self.source.mkdir(parents=True)
        self.package = {"publisher": "test", "name": "agent-hub", "version": "1.0.0"}
        (self.source / "package.json").write_text(json.dumps(self.package), encoding="utf-8")
        (self.source / "extension.js").write_text("source one", encoding="utf-8")
        self.home = self.base / "home"
        self.extensions = self.home / ".vscode/extensions"
        self.extensions.mkdir(parents=True)
        self.runtime = self.base / "physical-runtime"
        self.runtime.mkdir()
        self.payloads = self.runtime / "external/vscode/extensions"
        for patch in (
            mock.patch.object(install, "ROOT", self.source_root),
            mock.patch.object(install, "runtime_root", return_value=self.runtime),
            mock.patch.object(install.Path, "home", return_value=self.home),
            mock.patch.object(install, "extension_source_revision", return_value="a" * 40),
            mock.patch.object(install, "extension_revision_is_ancestor", return_value=True),
        ):
            patch.start()
            self.addCleanup(patch.stop)

    def migrated(self, *, foreign: bool = False) -> tuple[Path, Path]:
        physical = (self.base / "foreign" if foreign else self.payloads) / "test.agent-hub-1.0.0"
        physical.mkdir(parents=True)
        (physical / "package.json").write_text(json.dumps(self.package), encoding="utf-8")
        (physical / "extension.js").write_text("legacy body", encoding="utf-8")
        logical = self.extensions / physical.name
        junction(physical, logical)
        return logical, physical

    def test_new_install_uses_runtime_payload_and_only_alias_in_vscode(self) -> None:
        installed = install.install_vscode_extension()
        logical = self.extensions / installed.name
        self.assertEqual(self.payloads / installed.name, logical.resolve())
        self.assertTrue(logical.is_junction() if os.name == "nt" else logical.is_symlink())
        self.assertEqual("source one", (logical / "extension.js").read_text(encoding="utf-8"))
        self.assertEqual(f"revision:{'a' * 40}", install.installed_vscode_extension_identity())
        self.assertEqual("current", install.vscode_extension_install_plan()["action"])

    def test_migrated_alias_is_readable_and_update_preserves_older_version(self) -> None:
        logical, physical = self.migrated()
        identity = install.installed_vscode_extension_identity()
        self.assertTrue(identity.startswith("legacy:"))
        installed = install.install_vscode_extension(expected_installed_identity=identity)
        self.assertEqual("test.agent-hub-1.0.1", installed.name)
        self.assertEqual(self.payloads / installed.name, (self.extensions / installed.name).resolve())
        self.assertEqual("legacy body", (logical / "extension.js").read_text(encoding="utf-8"))
        self.assertTrue(physical.is_dir())

    def test_foreign_alias_is_refused_without_writing_through_it(self) -> None:
        _, physical = self.migrated(foreign=True)
        with self.assertRaisesRegex(RuntimeError, "unsafe|payload"):
            install.install_vscode_extension()
        self.assertEqual("legacy body", (physical / "extension.js").read_text(encoding="utf-8"))
        self.assertFalse(self.payloads.exists())

    def test_alias_failure_retains_payload_and_exact_retry_reuses_it(self) -> None:
        plan = install.vscode_extension_install_plan()
        with mock.patch.object(install, "_create_extension_alias", side_effect=OSError("alias interrupted")):
            with self.assertRaisesRegex(OSError, "alias interrupted"):
                install.install_vscode_extension(prepared_plan=plan)
        physical = self.payloads / plan["targetName"]
        before = (physical / "extension.js").stat().st_ino
        self.assertFalse(os.path.lexists(self.extensions / plan["targetName"]))
        installed = install.install_vscode_extension(prepared_plan=plan)
        self.assertEqual(before, (physical / "extension.js").stat().st_ino)
        self.assertEqual(physical, (self.extensions / installed.name).resolve())
        self.assertEqual(installed, install.install_vscode_extension(prepared_plan=plan))

    def test_changed_unpublished_payload_is_preserved_and_refused(self) -> None:
        plan = install.vscode_extension_install_plan()
        with mock.patch.object(install, "_create_extension_alias", side_effect=OSError("interrupted")):
            with self.assertRaises(OSError):
                install.install_vscode_extension(prepared_plan=plan)
        physical = self.payloads / plan["targetName"]
        (physical / "valuable-wip.txt").write_text("retain", encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "payload"):
            install.install_vscode_extension(prepared_plan=plan)
        self.assertEqual("retain", (physical / "valuable-wip.txt").read_text(encoding="utf-8"))
        self.assertFalse(os.path.lexists(self.extensions / plan["targetName"]))

    def test_substituted_payload_parent_is_refused_without_foreign_write(self) -> None:
        foreign = self.base / "foreign"
        foreign.mkdir()
        junction(foreign, self.runtime / "external")
        with self.assertRaisesRegex(RuntimeError, "payload"):
            install.install_vscode_extension()
        self.assertEqual([], list(foreign.iterdir()))
        self.assertEqual([], list(self.extensions.iterdir()))

    def test_explicit_uninstall_removes_owned_alias_and_payload_only(self) -> None:
        logical, physical = self.migrated()
        foreign = self.extensions / "example.foreign-1.0.0"
        foreign.mkdir()
        (foreign / "keep").write_text("retain", encoding="utf-8")
        removed = install.uninstall_vscode_extension("production")
        self.assertEqual([physical], removed)
        self.assertFalse(os.path.lexists(logical))
        self.assertFalse(physical.exists())
        self.assertEqual("retain", (foreign / "keep").read_text(encoding="utf-8"))

    def test_runtime_logical_alias_keeps_extension_payload_physical(self) -> None:
        logical_runtime = self.base / "logical-runtime"
        junction(self.runtime, logical_runtime)
        with mock.patch.object(install, "runtime_root", return_value=logical_runtime):
            installed = install.install_vscode_extension()
        self.assertEqual(self.payloads / installed.name, (self.extensions / installed.name).resolve())

    def test_concurrent_registration_is_not_overwritten(self) -> None:
        publish = install._create_extension_alias

        def competing_registration(payload: Path, logical: Path) -> None:
            logical.mkdir()
            (logical / "keep").write_text("concurrent", encoding="utf-8")
            publish(payload, logical)

        with mock.patch.object(install, "_create_extension_alias", side_effect=competing_registration):
            with self.assertRaises(OSError):
                install.install_vscode_extension()
        logical = self.extensions / "test.agent-hub-1.0.0"
        self.assertEqual("concurrent", (logical / "keep").read_text(encoding="utf-8"))
        self.assertEqual("source one", (self.payloads / logical.name / "extension.js").read_text(encoding="utf-8"))

    def test_unpublished_linked_payload_is_preserved_and_refused(self) -> None:
        self.payloads.mkdir(parents=True)
        foreign = self.base / "foreign"
        foreign.mkdir()
        (foreign / "keep").write_text("retain", encoding="utf-8")
        junction(foreign, self.payloads / "test.agent-hub-1.0.0")
        with self.assertRaisesRegex(RuntimeError, "payload"):
            install.install_vscode_extension()
        self.assertEqual("retain", (foreign / "keep").read_text(encoding="utf-8"))
        self.assertFalse(os.path.lexists(self.extensions / "test.agent-hub-1.0.0"))


if __name__ == "__main__":
    unittest.main()
