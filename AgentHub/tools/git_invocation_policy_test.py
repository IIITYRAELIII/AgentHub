"""Argument-only conformance for the two offline Python Git owners."""
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class GitPolicyTests(unittest.TestCase):
    def test_python_owners_consume_shared_policy_without_environment_or_config_mutation(self):
        before = dict(os.environ)
        expected = json.loads((ROOT / "src/infrastructure/filesystem/git-invocation-policy.json").read_text(encoding="utf-8"))["win32"] if os.name == "nt" else []
        installer = load("git_policy_installer", "install.py")
        exporter = load("git_policy_exporter", "tools/source-export.py")
        self.assertEqual(installer.WINDOWS_GIT_ARGS, expected)
        self.assertEqual(exporter.WINDOWS_GIT_ARGS, expected)
        with patch.object(installer.subprocess, "run", return_value=SimpleNamespace(stdout="a" * 40, returncode=0)) as run:
            self.assertEqual(installer.extension_source_revision(), "a" * 40)
            self.assertTrue(installer.extension_revision_is_ancestor("a" * 40, "b" * 40))
            self.assertEqual(run.call_count, 2)
            for call in run.call_args_list:
                self.assertEqual(call.args[0][:1 + len(expected)], ["git", *expected])
        with patch.object(exporter.subprocess, "run", return_value=SimpleNamespace(stdout=b"synthetic")) as run:
            self.assertEqual(exporter.git(ROOT, "status"), b"synthetic")
            self.assertEqual(run.call_args.args[0][:1 + len(expected)], ["git", *expected])
        self.assertTrue(dict(os.environ) == before, "argument-only policy must not change environment")


if __name__ == "__main__":
    unittest.main()
