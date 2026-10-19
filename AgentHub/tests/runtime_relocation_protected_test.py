"""Protected foreign process behavior at the existing relocation stop boundary."""

import ctypes as c
from ctypes import wintypes as w
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

import runtime_relocation_process as custody


class ProtectedProcessTest(unittest.TestCase):
    def test_unavailable_same_object_api_refuses(self):
        with patch.object(custody.c, "WinDLL", side_effect=OSError("unavailable")):
            with self.assertRaisesRegex(ValueError, "witness is unavailable"):
                custody._same_kernel_object(1, 1)

    @unittest.skipUnless(os.name == "nt", "Windows actual job handle reuse")
    def test_actual_recycled_job_handle_refuses_with_unknown_native_addresses(self):
        parent = Path(
            os.environ.get("AGENT_HUB_TEST_TMP", tempfile.gettempdir())
        ).resolve()
        fixture = Path(tempfile.mkdtemp(prefix="hub143-job-reuse-", dir=parent))
        source = fixture / "Fixture.cs"
        source.write_text(
            r"""
using System;
using System.Runtime.InteropServices;
class Fixture {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr sa,string name);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 static int Main() {
  IntPtr anchor=CreateJobObject(IntPtr.Zero,"Local\\IIITYRAELIII.AgentHub."+System.Diagnostics.Process.GetCurrentProcess().Id);
  IntPtr extra=CreateJobObject(IntPtr.Zero,null);
  try {
   if(anchor==IntPtr.Zero || extra==IntPtr.Zero) return 1;
   Console.WriteLine("ready"); string line;
   while((line=Console.ReadLine())!=null) {
    if(line=="swap") {
     long old=extra.ToInt64(); if(!CloseHandle(extra)) return 2;
     extra=CreateJobObject(IntPtr.Zero,null); if(extra==IntPtr.Zero) return 3;
     Console.WriteLine(old+" "+extra.ToInt64());
    } else if(line=="quit") return 0; else return 4;
   }
   return 0;
  } finally { CloseHandle(extra); CloseHandle(anchor); }
 }
}
""",
            encoding="utf-8",
        )
        host = held_host = held_self = None
        try:
            exe = fixture / "AgentHub.RuntimeHost.exe"
            compiler = (
                Path(os.environ["SystemRoot"])
                / "Microsoft.NET/Framework64/v4.0.30319/csc.exe"
            )
            built = subprocess.run(
                [str(compiler), "/nologo", "/target:exe", f"/out:{exe}", str(source)],
                capture_output=True,
                timeout=30,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            self.assertEqual(built.returncode, 0, built.stdout)
            host = subprocess.Popen(
                [str(exe)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            messages = queue.Queue()

            def reader():
                for line in host.stdout:
                    messages.put(line.strip())

            thread = threading.Thread(target=reader, daemon=True)
            thread.start()
            self.assertEqual(messages.get(timeout=10), "ready")
            rows = custody.process_snapshot()
            held_host = custody.HeldProcess(
                next(r for r in rows if r["pid"] == host.pid),
                terminate=False,
                duplicate=True,
            )
            held_self = custody.HeldProcess(
                next(r for r in rows if r["pid"] == os.getpid()), terminate=False
            )
            anchor = {
                "pid": host.pid,
                "created": held_host.created,
                "executable": held_host.executable,
                "native_creation": True,
            }
            native = custody._system_handles
            observations = []

            def enumerate_handles():
                if observations:
                    host.stdin.write("swap\n")
                    host.stdin.flush()
                    old, new = messages.get(timeout=10).split()
                    self.assertEqual(
                        old, new, "Fixture must reuse the actual source handle"
                    )
                result = native()
                observations.append(result)
                return result

            with patch.object(
                custody, "_system_handles", side_effect=enumerate_handles
            ):
                with self.assertRaisesRegex(
                    ValueError, "job object changed or identity is unknown"
                ):
                    custody.inspect_protected_jobs(
                        {host.pid: held_host}, {os.getpid(): held_self}, anchor
                    )
            self.assertEqual(len(observations), 2)
            self.assertIsNone(host.poll(), "The observer must not stop the owner")
        finally:
            if held_host:
                held_host.close()
            if held_self:
                held_self.close()
            if host:
                if host.poll() is None:
                    host.stdin.write("quit\n")
                    host.stdin.flush()
                host.wait(timeout=10)
                self.assertEqual(host.returncode, 0, host.stderr.read())
                host.stdin.close()
                host.stdout.close()
                host.stderr.close()
            if fixture.parent.resolve() != parent or not fixture.name.startswith(
                "hub143-job-reuse-"
            ):
                raise ValueError("Fixture cleanup escaped its exact root")
            shutil.rmtree(fixture)

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
