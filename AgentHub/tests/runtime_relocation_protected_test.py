"""Protected foreign process behavior at the existing relocation stop boundary."""

import ctypes as c
from ctypes import wintypes as w
import os
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

import runtime_relocation_process as custody


class ProtectedProcessTest(unittest.TestCase):
    def test_overlap_and_selected_live_ancestor_refuse(self):
        parent = {"pid": 10, "parent": 0, "created": "100"}
        child = {"pid": 11, "parent": 10, "created": "200"}
        with self.assertRaisesRegex(ValueError, "selected live ancestor"):
            custody.refuse_protected_ancestry([parent, child], {10: parent}, [child])
        with self.assertRaisesRegex(ValueError, "selected live ancestor"):
            custody.refuse_protected_ancestry([parent, child], {11: child}, [child])

    def test_reused_parent_pid_does_not_create_false_ancestry(self):
        parent = {"pid": 10, "parent": 0, "created": "300"}
        child = {"pid": 11, "parent": 10, "created": "200"}
        custody.refuse_protected_ancestry([parent, child], {10: parent}, [child])
        with self.assertRaisesRegex(ValueError, "changed identity"):
            custody.refuse_protected_ancestry(
                [parent, child], {}, [{**child, "created": "400"}]
            )

    def test_missing_job_anchor_refuses(self):
        # Exercise the public owner with native wrappers replaced by fixture
        # observations; no stop/assignment can occur through this API.
        with self.assertRaisesRegex(ValueError, "anchor required"):
            custody.inspect_protected_jobs({}, {}, None)

    def test_changed_job_inventory_refuses_before_stop(self):
        kernel = MagicMock()
        kernel.OpenJobObjectW.return_value = 111
        host = SimpleNamespace(
            kernel=kernel, created="100", executable="AgentHub.RuntimeHost.exe"
        )
        anchor = {
            "pid": 42,
            "created": "100",
            "executable": host.executable,
            "native_creation": True,
        }
        own = SimpleNamespace(pid=os.getpid(), handle=111, type=7, object=123)
        added = SimpleNamespace(pid=42, handle=222, type=7, object=456)
        with (
            patch.object(custody, "_system_handles", side_effect=[[own], [own, added]]),
            patch.object(custody, "_inspect_job", return_value={"limit_flags": 0}),
        ):
            with self.assertRaisesRegex(ValueError, "handles changed"):
                custody.inspect_protected_jobs({42: host}, {}, anchor)
        kernel.TerminateProcess.assert_not_called()
        kernel.CloseHandle.assert_called_once_with(111)

    @unittest.skipUnless(os.name == "nt", "Windows job membership")
    def test_actual_protected_job_limits_and_query_only_handle(self):
        child = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(60)"],
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        k = c.WinDLL("kernel32", use_last_error=True)
        k.CreateJobObjectW.argtypes = [c.c_void_p, w.LPCWSTR]
        k.CreateJobObjectW.restype = w.HANDLE
        k.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
        k.OpenProcess.restype = w.HANDLE
        k.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
        k.SetInformationJobObject.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD]
        k.QueryInformationJobObject.argtypes = [
            w.HANDLE,
            c.c_int,
            c.c_void_p,
            w.DWORD,
            c.POINTER(w.DWORD),
        ]
        k.IsProcessInJob.argtypes = [w.HANDLE, w.HANDLE, c.POINTER(w.BOOL)]
        k.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
        k.CloseHandle.argtypes = [w.HANDLE]
        job = k.CreateJobObjectW(None, None)
        process = k.OpenProcess(0x100 | 1, False, child.pid)
        held = None
        try:
            self.assertTrue(job)
            self.assertTrue(process)
            self.assertTrue(k.AssignProcessToJobObject(job, process))
            row = next(r for r in custody.process_snapshot() if r["pid"] == child.pid)
            held = custody.HeldProcess(row, terminate=False)
            with self.assertRaisesRegex(ValueError, "QUERY-only"):
                held.stop()
            with self.assertRaisesRegex(ValueError, "creation identity"):
                custody.HeldProcess(
                    {**row, "created": str(int(row["created"]) + 10_000_000)},
                    terminate=False,
                )
            proof = custody._inspect_job(k, job, {child.pid: held})
            self.assertEqual(proof["protected_membership"], {str(child.pid): True})
            limits = custody._ExtendedLimits()
            limits.basic.flags = 0x2000
            self.assertTrue(
                k.SetInformationJobObject(job, 9, c.byref(limits), c.sizeof(limits))
            )
            with self.assertRaisesRegex(ValueError, "kill-on-close"):
                custody._inspect_job(k, job, {child.pid: held})
            with patch.object(k, "QueryInformationJobObject", return_value=0):
                with self.assertRaises(OSError):
                    custody._inspect_job(k, job, {child.pid: held})
            self.assertIsNone(child.poll())
        finally:
            if held:
                held.close()
            if process:
                k.CloseHandle(process)
            if job:
                k.CloseHandle(job)
            if child.poll() is None:
                child.terminate()
            child.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
