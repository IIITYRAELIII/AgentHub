"""Exact Windows process custody for the runtime relocation operator.

No process is killed by a later PID lookup. All selected handles are retained,
their creation FILETIMEs and executable identities rechecked before any stop.
Command lines are used privately for ownership and only their hashes are saved.
"""

import argparse
import ctypes as c
from ctypes import wintypes as w
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

from runtime_relocation import digest, inside, load_plan, write_json


def process_snapshot():
    script = r"""[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
@(Get-CimInstance Win32_Process | ForEach-Object {
 [pscustomobject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;name=$_.Name;
 executable=$_.ExecutablePath;command=$_.CommandLine;
 created=$_.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString()}
}) | ConvertTo-Json -Compress
"""
    windows = (
        Path(os.environ["SystemRoot"])
        / "System32/WindowsPowerShell/v1.0/powershell.exe"
    )
    result = subprocess.run(
        [str(windows), "-NoProfile", "-NonInteractive", "-Command", script],
        check=True,
        capture_output=True,
        encoding="utf-8",
        creationflags=0x08000000,
    )
    return json.loads(result.stdout)


def owned_processes(rows, roots, seeds=(), historical=None):
    # The independent helper and its transient CIM subprocess are observers,
    # never members of the stop set even if an ancestor once belonged to Hub.
    observers = {os.getpid()}
    changed = True
    while changed:
        changed = False
        for row in rows:
            if row["parent"] in observers and row["pid"] not in observers:
                observers.add(row["pid"])
                changed = True
    selected = {int(x) for x in seeds}
    for row in rows:
        if row["pid"] in observers:
            continue
        command = str(row.get("command") or "").replace("/", "\\").lower()
        executable = row.get("executable")
        script_process = str(row.get("name") or "").lower() in {
            "node.exe",
            "python.exe",
            "pythonw.exe",
            "pwsh.exe",
            "powershell.exe",
            "caddy.exe",
        }
        profile_process = (
            str(row.get("name") or "").lower() in {"msedge.exe", "chrome.exe"}
            and "--user-data-dir=" in command
        )
        if any(
            (executable and inside(root, executable))
            or (
                (script_process or profile_process)
                and (os.path.normpath(root).lower() + "\\") in command
            )
            for root in roots
        ):
            selected.add(row["pid"])
    by_id = {r["pid"]: r for r in rows}
    changed = True
    while changed:
        changed = False
        for row in rows:
            parent = by_id.get(row["parent"]) or (historical or {}).get(row["parent"])
            birth_matches = (
                parent
                and int(row["created"]) >= int(parent["created"])
                and (
                    not parent.get("exited")
                    or int(row["created"]) <= int(parent["exited"])
                )
            )
            if (
                row["pid"] not in selected
                and row["pid"] not in observers
                and parent
                and parent["pid"] in selected
                and birth_matches
            ):
                selected.add(row["pid"])
                changed = True
    return [r for r in rows if r["pid"] in selected and r["pid"] not in observers]


class HeldProcess:
    def __init__(self, expected):
        self.kernel = c.WinDLL("kernel32", use_last_error=True)
        k = self.kernel
        k.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
        k.OpenProcess.restype = w.HANDLE
        k.GetProcessTimes.argtypes = [
            w.HANDLE,
            c.POINTER(c.c_ulonglong),
            c.POINTER(c.c_ulonglong),
            c.POINTER(c.c_ulonglong),
            c.POINTER(c.c_ulonglong),
        ]
        k.GetProcessTimes.restype = w.BOOL
        k.QueryFullProcessImageNameW.argtypes = [
            w.HANDLE,
            w.DWORD,
            w.LPWSTR,
            c.POINTER(w.DWORD),
        ]
        k.QueryFullProcessImageNameW.restype = w.BOOL
        k.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
        k.WaitForSingleObject.restype = w.DWORD
        k.TerminateProcess.argtypes = [w.HANDLE, w.UINT]
        k.TerminateProcess.restype = w.BOOL
        k.CloseHandle.argtypes = [w.HANDLE]
        self.handle = k.OpenProcess(0x101001, False, int(expected["pid"]))
        if not self.handle:
            raise c.WinError(c.get_last_error())
        try:
            born, ended, kernel, user = (c.c_ulonglong() for _ in range(4))
            if not k.GetProcessTimes(
                self.handle,
                c.byref(born),
                c.byref(ended),
                c.byref(kernel),
                c.byref(user),
            ):
                raise c.WinError(c.get_last_error())
            self.created = str(born.value)
            # CIM retains microseconds, native custody retains all 100ns ticks.
            matches = (
                self.created == expected["created"]
                if expected.get("native_creation")
                else int(self.created) // 10 == int(expected["created"]) // 10
            )
            if not matches:
                raise ValueError("Held process creation identity differs")
            size = w.DWORD(32768)
            name = c.create_unicode_buffer(size.value)
            if not k.QueryFullProcessImageNameW(self.handle, 0, name, c.byref(size)):
                raise c.WinError(c.get_last_error())
            self.executable = name.value
            if os.path.normcase(os.path.abspath(self.executable)) != os.path.normcase(
                os.path.abspath(expected["executable"])
            ):
                raise ValueError("Held process executable identity differs")
            if k.WaitForSingleObject(self.handle, 0) != 258:
                raise ValueError("Held process is no longer running")
        except BaseException:
            self.close()
            raise

    def stop(self):
        k = self.kernel
        if k.WaitForSingleObject(self.handle, 0) == 0:
            return "already_exited_held_identity"
        if not k.TerminateProcess(self.handle, 0xC000013A):
            if k.WaitForSingleObject(self.handle, 0) != 0:
                raise c.WinError(c.get_last_error())
        if k.WaitForSingleObject(self.handle, 10000) != 0:
            raise RuntimeError("Exact retained process handle did not terminate")
        return "stopped_held_identity"

    def exit_time(self):
        born, ended, kernel, user = (c.c_ulonglong() for _ in range(4))
        if not self.kernel.GetProcessTimes(
            self.handle, c.byref(born), c.byref(ended), c.byref(kernel), c.byref(user)
        ):
            raise c.WinError(c.get_last_error())
        return str(ended.value)

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None


def capture(plan, output):
    roots = [r["source"] for r in plan["roots"]]
    selected = owned_processes(process_snapshot(), roots)
    result = []
    for row in selected:
        with_handle = HeldProcess(row)
        try:
            result.append(
                {
                    "pid": row["pid"],
                    "parent": row["parent"],
                    "name": row["name"],
                    "executable": with_handle.executable,
                    "created": with_handle.created,
                    "native_creation": True,
                    "command_sha256": hashlib.sha256(
                        str(row.get("command") or "").encode()
                    ).hexdigest(),
                }
            )
        finally:
            with_handle.close()
    value = {
        "operation": plan["operation"],
        "captured_at": time.time(),
        "roots": roots,
        "processes": result,
    }
    write_json(output, value)
    return {"process_count": len(result), "process_plan_sha256": digest(output)}


def stop(plan, process_file, expected_hash, saved_file, output):
    if digest(process_file) != expected_hash:
        raise ValueError("Exact process plan digest differs")
    selected = json.loads(Path(process_file).read_text(encoding="utf-8"))
    saved = json.loads(Path(saved_file).read_text(encoding="utf-8"))
    roots = [r["source"] for r in plan["roots"]]
    if (
        selected.get("operation") != plan["operation"]
        or selected.get("roots") != roots
        or saved.get("operation") != plan["operation"]
        or saved.get("all_streams_saved_stopped") is not True
        or not saved.get("streams")
        or not saved.get("durable_readback_sha256")
    ):
        raise ValueError("Exact saved/stopped and durable readback evidence required")
    if (
        time.time() - selected.get("captured_at", 0) > 300
        or time.time() - saved.get("checked_at", 0) > 300
    ):
        raise ValueError("Fresh process and saved boundaries required")
    expected = {r["pid"]: r for r in selected["processes"]}
    if not expected:
        raise ValueError("Empty live stop set")
    handles = {}
    try:
        for pid, row in expected.items():
            handles[pid] = HeldProcess(row)
        current = owned_processes(process_snapshot(), roots)
        if {r["pid"] for r in current} != set(expected):
            raise ValueError("Owned live process set changed")
        for row in current:
            old = expected[row["pid"]]
            if (
                old["parent"] != row["parent"]
                or old["command_sha256"]
                != hashlib.sha256(str(row.get("command") or "").encode()).hexdigest()
            ):
                raise ValueError("Owned live process command/parent changed")
        receipt = {
            "operation": plan["operation"],
            "process_plan_sha256": expected_hash,
            "saved_boundary_sha256": digest(saved_file),
            "mode": "controlled process stop; SQLite crash recovery, not graceful shutdown",
            "results": [],
            "all_writers_stopped": False,
        }
        write_json(output, receipt)

        # Descendants first. Every stop still uses the retained native handle.
        def depth(pid):
            seen = set()
            p = pid
            while p in expected and p not in seen:
                seen.add(p)
                p = expected[p]["parent"]
            return len(seen)

        for pid in sorted(expected, key=depth, reverse=True):
            outcome = handles[pid].stop()
            expected[pid]["exited"] = handles[pid].exit_time()
            receipt["results"].append(
                {
                    "pid": pid,
                    "created": handles[pid].created,
                    "outcome": outcome,
                    "exited": expected[pid]["exited"],
                }
            )
            write_json(output, receipt)
        remaining = owned_processes(
            process_snapshot(), roots, seeds=expected, historical=expected
        )
        if remaining:
            raise RuntimeError(
                "Owned processes remain after stop; no offline copy admission"
            )
        receipt.update(
            {
                "all_writers_stopped": True,
                "checked_at": time.time(),
                "saved_streams": saved["streams"],
                "stopped_pids": list(expected),
            }
        )
        write_json(output, receipt)
        return {
            "stopped": len(receipt["results"]),
            "all_writers_stopped": True,
            "proof": str(output),
        }
    finally:
        for handle in handles.values():
            handle.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["capture", "stop"])
    parser.add_argument("--plan", required=True)
    parser.add_argument("--expected-plan-sha256", required=True)
    parser.add_argument("--process-plan")
    parser.add_argument("--expected-process-plan-sha256")
    parser.add_argument("--saved-proof")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    plan = load_plan(args.plan, args.expected_plan_sha256)
    result = (
        capture(plan, args.output)
        if args.action == "capture"
        else stop(
            plan,
            args.process_plan,
            args.expected_process_plan_sha256,
            args.saved_proof,
            args.output,
        )
    )
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
