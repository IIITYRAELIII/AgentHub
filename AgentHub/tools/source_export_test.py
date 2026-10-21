from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("source_export", Path(__file__).with_name("source-export.py"))
EXPORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EXPORT)


class SourceExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hub-export-test-", dir=os.environ.get("AGENT_HUB_TEST_TEMP"))
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root/"source"
        self.source.mkdir()
        self.git("init", "--initial-branch=main")
        self.git("config", "user.name", "Synthetic Author")
        self.git("config", "user.email", "synthetic@example.invalid")
        self.write("TelegramIntegration/main.mjs", b"export const value = 1;\n")
        self.write("TelegramIntegration/README.md", b"old name\n")
        self.write("Other/private.txt", b"not a project dependency\n")
        self.commit("initial technical source\n\nPrivate body never exported")
        self.write("AgentHub/main.mjs", b"export const value = 2;\n")
        self.write("AgentHub/README.md", b"new name coexists\n")
        self.write("AgentHub/Bugs/bug-1/screenshot.png", b"private synthetic screenshot\0")
        self.write("AgentHub/config.json", b'{"token":"synthetic-private"}\n')
        self.write("AgentHub/тест.txt", "UTF-8 retained\n".encode())
        self.write("AgentHub/assets/logo.png", b"synthetic image\0")
        self.pin = self.commit("rename with overlapping paths")
        self.before = self.git("show-ref")
        self.audit = self.root/"audit"
        with contextlib.redirect_stdout(io.StringIO()):
            EXPORT.plan(self.source, self.pin, self.audit)

    def git(self, *args):
        return EXPORT.git(self.source, *args)

    def write(self, name, data):
        path = self.source/name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def commit(self, message):
        self.git("add", ".")
        self.git("commit", "-m", message)
        return self.git("rev-parse", "HEAD").strip().decode()

    def decisions(self):
        plan_file = self.audit/"plan.private.json"
        plan = json.loads(plan_file.read_text(encoding="utf-8"))
        decisions = {"planSha256": EXPORT.digest(plan_file.read_bytes()),
                     "blobs": {x["oid"]: {"decision": "allow", "reason": "synthetic fixture image"}
                               for x in plan["blobs"] if x["binary"] or x["signals"]},
                     "commits": {x["oid"]: {"subject": f"Technical fixture {i}", "author": "Synthetic Author",
                                             "committer": "Synthetic Author"} for i, x in enumerate(plan["commits"])}}
        path = self.root/"decisions.json"
        EXPORT.write_json(path, decisions)
        return path

    def test_exact_history_projection_metadata_and_primary_preservation(self):
        destination = self.root/"standalone.git"
        with contextlib.redirect_stdout(io.StringIO()):
            EXPORT.extract(self.source, self.audit/"plan.private.json", self.decisions(), destination)
        files = EXPORT.git(destination, "ls-tree", "-r", "--name-only", "main").decode().splitlines()
        self.assertNotIn("Other/private.txt", files)
        self.assertNotIn("AgentHub/config.json", files)
        self.assertFalse(any("Bugs" in x for x in files))
        for prefix in ("AgentHub", "TelegramIntegration"):
            self.assertEqual(EXPORT.git(destination, "show", f"main:{prefix}/README.md"),
                             self.git("show", f"{self.pin}:{prefix}/README.md"))
        self.assertEqual(EXPORT.git(destination, "show", "main:AgentHub/тест.txt"), b"UTF-8 retained\n")
        messages = EXPORT.git(destination, "log", "--format=%B %ae", "main")
        self.assertNotIn(b"Private body", messages)
        self.assertNotIn(b"synthetic@example.invalid", messages)
        self.assertEqual(self.git("show-ref"), self.before)
        self.assertEqual(self.git("status", "--porcelain"), b"")
        self.assertEqual(EXPORT.git(destination, "remote"), b"")
        self.assertFalse((destination/"objects/info/alternates").exists())
        mapping = json.loads((self.root/"standalone.git.mapping.private.json").read_text())
        self.assertEqual(len(mapping["commits"]), 2)
        self.assertTrue(all(x["projectionVerified"] for x in mapping["commits"]))
        self.assertFalse(mapping["publicApproval"])

    def test_unreviewed_binary_and_wrong_plan_refuse_before_destination(self):
        choices = self.decisions()
        data = json.loads(choices.read_text())
        data["blobs"] = {}
        EXPORT.write_json(choices, data)
        destination = self.root/"no-import.git"
        with self.assertRaisesRegex(ValueError, "Unreviewed"):
            EXPORT.extract(self.source, self.audit/"plan.private.json", choices, destination)
        self.assertFalse(destination.exists())
        data["planSha256"] = "0"*64
        EXPORT.write_json(choices, data)
        with self.assertRaisesRegex(ValueError, "exact history"):
            EXPORT.extract(self.source, self.audit/"plan.private.json", choices, destination)
        self.assertFalse(destination.exists())

    def test_excluded_blob_is_absent_from_all_reachable_objects(self):
        choices = self.decisions()
        data = json.loads(choices.read_text())
        blob = next(iter(data["blobs"]))
        data["blobs"][blob] = {"decision": "exclude", "reason": "not approved for export"}
        EXPORT.write_json(choices, data)
        destination = self.root/"excluded.git"
        with contextlib.redirect_stdout(io.StringIO()):
            EXPORT.extract(self.source, self.audit/"plan.private.json", choices, destination)
        objects = EXPORT.git(destination, "rev-list", "--objects", "--all")
        self.assertNotIn(blob.encode(), objects)

    def test_private_signal_detection_does_not_emit_matched_values(self):
        secret = b"ghp_"+b"x"*36
        self.assertEqual(EXPORT.scan(secret), ["github-token"])
        self.assertEqual(EXPORT.projected_path(b'"AgentHub/\\321\\202\\320\\265\\321\\201\\321\\202.txt"'),
                         "AgentHub/тест.txt".encode())
        with self.assertRaises(ValueError):
            EXPORT.projected_path(b"Other/private.txt")

    def test_runtime_and_configuration_source_survive_state_exclusions(self):
        retained = {
            "AgentHub/src/runtime/runtime-manager.mjs": b"export const manager = true;\n",
            "AgentHub/src/infrastructure/filesystem/config.mjs": b"export const defaults = {};\n",
            "AgentHub/tests/runtime/runtime-manager.test.mjs": b"export const test = true;\n",
            "AgentHub/tests/infrastructure/filesystem/config.test.mjs": b"export const configTest = true;\n",
            "AgentHub/src/data/codec.mjs": b"export const codec = true;\n",
            "TelegramIntegration/src/runtime/controller.mjs": b"export const legacy = true;\n",
            "AgentHub/config.example.json": b'{"token":""}\n',
        }
        private = {
            "AgentHub/runtime/private.txt": b"synthetic runtime state\n",
            "AgentHub/data/private.txt": b"synthetic persisted state\n",
            "AgentHub/releases/private.txt": b"synthetic installed release\n",
            "AgentHub/models/private.txt": b"synthetic downloaded model\n",
            "AgentHub/config.local.json": b"synthetic operator setting\n",
            "AgentHub/config.secret": b"synthetic operator secret\n",
            "AgentHub/.env": b"synthetic environment\n",
            "AgentHub/src/node_modules/private.txt": b"synthetic dependency\n",
            "AgentHub/src/__pycache__/private.pyc": b"synthetic bytecode\n",
            "TelegramIntegration/runtime/private.txt": b"synthetic legacy runtime\n",
        }
        for name, body in {**retained, **private}.items():
            self.write(name, body)
        self.pin = self.commit("source and synthetic local state coexist")
        self.audit = self.root/"runtime-source-audit"
        source_refs = self.git("show-ref")
        source_index = EXPORT.digest((self.source/".git/index").read_bytes())
        destination = self.root/"runtime-source.git"
        with contextlib.redirect_stdout(io.StringIO()):
            EXPORT.plan(self.source, self.pin, self.audit)
            EXPORT.extract(self.source, self.audit/"plan.private.json", self.decisions(), destination)
        files = set(EXPORT.git(destination, "ls-tree", "-r", "--name-only", "main").decode().splitlines())
        for name, body in retained.items():
            self.assertIn(name, files)
            self.assertEqual(EXPORT.git(destination, "show", "main:"+name), body)
        objects = EXPORT.git(destination, "rev-list", "--objects", "--all")
        for name in private:
            self.assertNotIn(name, files)
            original_blob = self.git("rev-parse", self.pin+":"+name).strip()
            self.assertNotIn(original_blob, objects)
        self.assertEqual(self.git("show-ref"), source_refs)
        self.assertEqual(EXPORT.digest((self.source/".git/index").read_bytes()), source_index)

    def test_private_only_root_middle_and_tip_have_explicit_alias_mapping(self):
        self.source = self.root/"private-first-source"
        self.source.mkdir()
        self.git("init", "--initial-branch=main")
        self.git("config", "user.name", "Synthetic Author")
        self.git("config", "user.email", "synthetic@example.invalid")
        self.write("AgentHub/Bugs/bug-1/report.txt", b"private-only root\n")
        root = self.commit("private-only root")
        self.write("AgentHub/main.mjs", b"export const first = true;\n")
        first = self.commit("technical first")
        self.write("AgentHub/Bugs/bug-1/report.txt", b"private-only middle\n")
        middle = self.commit("private-only middle")
        self.write("AgentHub/second.mjs", b"export const second = true;\n")
        second = self.commit("technical second")
        self.write("AgentHub/config.json", b'{"private":"synthetic"}\n')
        self.pin = self.commit("private-only tip")
        self.audit = self.root/"private-first-audit"
        destination = self.root/"private-first.git"
        before = self.git("show-ref")
        with contextlib.redirect_stdout(io.StringIO()):
            EXPORT.plan(self.source, self.pin, self.audit)
            EXPORT.extract(self.source, self.audit/"plan.private.json", self.decisions(), destination)
        mapping = json.loads((self.root/"private-first.git.mapping.private.json").read_text())
        rows = {r["oldCommit"]: r for r in mapping["commits"]}
        self.assertIsNone(rows[root]["newCommit"])
        self.assertEqual(rows[root]["prunedReason"], "empty-root-after-exclusions")
        self.assertEqual(rows[middle]["newCommit"], rows[first]["newCommit"])
        self.assertEqual(rows[self.pin]["newCommit"], rows[second]["newCommit"])
        self.assertEqual(mapping["tip"], rows[second]["newCommit"])
        self.assertEqual(EXPORT.git(destination, "rev-list", "--count", "main").strip(), b"2")
        parents = EXPORT.git(destination, "show", "-s", "--format=%P", "main").strip().decode()
        self.assertEqual(parents, rows[first]["newCommit"])
        self.assertEqual(EXPORT.git(destination, "show", "main:AgentHub/second.mjs"), b"export const second = true;\n")
        self.assertTrue(all(r["projectionVerified"] for r in rows.values()))
        self.assertEqual(self.git("show-ref"), before)

    def test_reviewed_blob_exclusion_prunes_unchanged_tip(self):
        self.write("AgentHub/private-image.png", b"synthetic excluded binary\0")
        self.pin = self.commit("image-only contribution")
        self.audit = self.root/"binary-tail-audit"
        with contextlib.redirect_stdout(io.StringIO()):
            EXPORT.plan(self.source, self.pin, self.audit)
        choices = self.decisions()
        data = json.loads(choices.read_text())
        blob = self.git("rev-parse", self.pin+":AgentHub/private-image.png").strip().decode()
        data["blobs"][blob] = {"decision": "exclude", "reason": "synthetic private image"}
        EXPORT.write_json(choices, data)
        destination = self.root/"binary-tail.git"
        with contextlib.redirect_stdout(io.StringIO()):
            EXPORT.extract(self.source, self.audit/"plan.private.json", choices, destination)
        mapping = json.loads((self.root/"binary-tail.git.mapping.private.json").read_text())
        self.assertEqual(mapping["publicCommits"], 2)
        self.assertEqual(mapping["prunedCommits"], 1)
        self.assertEqual(mapping["commits"][-1]["newCommit"], mapping["commits"][-2]["newCommit"])
        self.assertNotIn(blob.encode(), EXPORT.git(destination, "rev-list", "--objects", "--all"))

    def test_fully_empty_selected_projection_refuses(self):
        self.source = self.root/"empty-source"
        self.source.mkdir()
        self.git("init", "--initial-branch=main")
        self.git("config", "user.name", "Synthetic Author")
        self.git("config", "user.email", "synthetic@example.invalid")
        self.write("AgentHub/Bugs/bug-1/report.txt", b"synthetic private only\n")
        self.pin = self.commit("private only")
        self.audit = self.root/"empty-audit"
        with contextlib.redirect_stdout(io.StringIO()):
            EXPORT.plan(self.source, self.pin, self.audit)
            with self.assertRaisesRegex(ValueError, "Selected source projection is empty"):
                EXPORT.extract(self.source, self.audit/"plan.private.json", self.decisions(), self.root/"empty.git")
        self.assertFalse((self.root/"empty.git.mapping.private.json").exists())

    def test_native_merge_parents_and_trees_survive_without_inherited_git_overrides(self):
        self.git("checkout", "-b", "feature")
        self.write("AgentHub/feature.txt", b"feature branch\n")
        self.commit("technical feature")
        self.git("checkout", "main")
        self.write("AgentHub/main.txt", b"main branch\n")
        self.commit("technical main change")
        self.git("merge", "--no-ff", "feature", "-m", "technical merge")
        self.pin = self.git("rev-parse", "HEAD").strip().decode()
        self.audit = self.root/"merged-audit"
        source_refs = self.git("show-ref")
        source_index = EXPORT.digest((self.source/".git/index").read_bytes())
        with contextlib.redirect_stdout(io.StringIO()):
            EXPORT.plan(self.source, self.pin, self.audit)
            with patch.dict(os.environ, {"GIT_DIR": str(self.source/".git"), "GIT_OBJECT_DIRECTORY": str(self.source/".git/objects"),
                                         "GIT_INDEX_FILE": str(self.source/".git/index")}):
                EXPORT.extract(self.source, self.audit/"plan.private.json", self.decisions(), self.root/"merged.git")
        parents = EXPORT.git(self.root/"merged.git", "show", "-s", "--format=%P", "main").split()
        self.assertEqual(len(parents), 2)
        self.assertEqual(self.git("show-ref"), source_refs)
        self.assertEqual(EXPORT.digest((self.source/".git/index").read_bytes()), source_index)
        self.assertEqual(EXPORT.git(self.root/"merged.git", "show", "main:AgentHub/feature.txt"), b"feature branch\n")
        self.assertEqual(EXPORT.git(self.root/"merged.git", "show", "main:AgentHub/main.txt"), b"main branch\n")


if __name__ == "__main__":
    unittest.main()
