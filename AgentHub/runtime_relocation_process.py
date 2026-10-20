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

PROCESS_STOP_SETTLE_MS = 10_000


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
    def __init__(self, expected, *, terminate=True, duplicate=False):
        self.may_terminate = terminate
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
        access = 0x101000 | (1 if terminate else 0) | (0x40 if duplicate else 0)
        self.handle = k.OpenProcess(access, False, int(expected["pid"]))
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
        if not self.may_terminate:
            raise ValueError("Protected QUERY-only handle cannot stop a process")
        k = self.kernel
        self.stop_details = {"stage": "precheck", "terminate_winerror": None}
        initial = k.WaitForSingleObject(self.handle, 0)
        self.stop_details["initial_wait"] = initial
        if initial == 0:
            self.stop_details["stage"] = "already_exited"
            return "already_exited_held_identity"
        if initial != 258:
            error = c.get_last_error() if initial == 0xFFFFFFFF else None
            self.stop_details.update(stage="precheck_failed", wait_winerror=error)
            if error is not None:
                raise c.WinError(error)
            raise RuntimeError("Unknown retained process wait state")
        self.stop_details["stage"] = "terminate"
        terminated = bool(k.TerminateProcess(self.handle, 0xC000013A))
        # Capture before any other native call can overwrite the error.
        error = None if terminated else c.get_last_error()
        self.stop_details.update(terminate_return=terminated, terminate_winerror=error)
        if not terminated and error != 5:
            raise c.WinError(error)
        self.stop_details.update(
            stage="settlement", wait_bound_ms=PROCESS_STOP_SETTLE_MS
        )
        started = time.monotonic()
        settled = k.WaitForSingleObject(self.handle, PROCESS_STOP_SETTLE_MS)
        wait_error = c.get_last_error() if settled == 0xFFFFFFFF else None
        self.stop_details.update(
            settlement_wait=settled,
            wait_winerror=wait_error,
            settlement_ms=(time.monotonic() - started) * 1000,
        )
        if settled != 0:
            self.stop_details["stage"] = (
                "settlement_timeout" if settled == 258 else "settlement_failed"
            )
            if wait_error is not None:
                raise c.WinError(wait_error)
            if error is not None:
                raise c.WinError(error)
            raise TimeoutError(
                "Exact retained process handle did not terminate within bound"
            )
        self.stop_details["stage"] = "exited"
        if error is not None:
            return "exited_held_identity_after_termination_error"
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


def refuse_protected_ancestry(rows, selected, protected):
    """Never subtract a foreign child from a rooted stop tree."""
    by_id = {row["pid"]: row for row in rows}
    for expected in protected:
        row = by_id.get(expected["pid"])
        if row is None or int(row["created"]) // 10 != int(expected["created"]) // 10:
            raise ValueError("Protected process disappeared or changed identity")
        seen = set()
        while row and row["pid"] not in seen:
            seen.add(row["pid"])
            if row["pid"] in selected:
                raise ValueError("Protected process has a selected live ancestor")
            parent = by_id.get(row["parent"])
            row = (
                parent
                if parent and int(parent["created"]) <= int(row["created"])
                else None
            )


class _HandleEntry(c.Structure):
    _fields_ = [
        ("object", c.c_void_p),
        ("pid", c.c_size_t),
        ("handle", c.c_size_t),
        ("access", w.ULONG),
        ("trace", w.USHORT),
        ("type", w.USHORT),
        ("attributes", w.ULONG),
        ("reserved", w.ULONG),
    ]


class _BasicLimits(c.Structure):
    _fields_ = [
        ("process_time", c.c_longlong),
        ("job_time", c.c_longlong),
        ("flags", w.DWORD),
        ("minimum", c.c_size_t),
        ("maximum", c.c_size_t),
        ("active", w.DWORD),
        ("affinity", c.c_size_t),
        ("priority", w.DWORD),
        ("scheduling", w.DWORD),
    ]


class _ExtendedLimits(c.Structure):
    _fields_ = [
        ("basic", _BasicLimits),
        ("io", c.c_ulonglong * 6),
        ("process_memory", c.c_size_t),
        ("job_memory", c.c_size_t),
        ("peak_process", c.c_size_t),
        ("peak_job", c.c_size_t),
    ]


def _system_handles():
    # This bounded native inventory is diagnostic only. Unsupported layouts,
    # access failures and unstable inventories refuse before any termination.
    native = c.WinDLL("ntdll")
    native.NtQuerySystemInformation.argtypes = [
        w.ULONG,
        c.c_void_p,
        w.ULONG,
        c.POINTER(w.ULONG),
    ]
    native.NtQuerySystemInformation.restype = c.c_long
    size = 1024 * 1024
    for _ in range(8):
        if size > 64 * 1024 * 1024:
            break
        buffer, needed = c.create_string_buffer(size), w.ULONG()
        status = native.NtQuerySystemInformation(64, buffer, size, c.byref(needed))
        if status == 0:
            count = c.c_size_t.from_buffer(buffer).value
            offset = 2 * c.sizeof(c.c_size_t)
            if count > 1_000_000 or offset + count * c.sizeof(_HandleEntry) > size:
                raise ValueError("Malformed native handle inventory")
            return [
                _HandleEntry.from_buffer_copy(
                    buffer, offset + i * c.sizeof(_HandleEntry)
                )
                for i in range(count)
            ]
        if status not in (-1073741820, -1073741789):
            raise OSError(f"Native handle query failed: {status}")
        size = max(size * 2, needed.value + 65536)
    raise ValueError("Native handle inventory exceeded its bound")


def _inspect_job(kernel, job, protected):
    limits, length = _ExtendedLimits(), w.DWORD()
    if not kernel.QueryInformationJobObject(
        job, 9, c.byref(limits), c.sizeof(limits), c.byref(length)
    ):
        raise c.WinError(c.get_last_error())
    if length.value != c.sizeof(limits):
        raise ValueError("Unknown native job limit layout")
    members = {}
    for pid, process in protected.items():
        member = w.BOOL()
        if not kernel.IsProcessInJob(process.handle, job, c.byref(member)):
            raise c.WinError(c.get_last_error())
        if kernel.WaitForSingleObject(process.handle, 0) != 258:
            raise ValueError("Protected process exited during job query")
        members[str(pid)] = bool(member.value)
    flags = limits.basic.flags
    if flags & 0x2000 and any(members.values()):
        raise ValueError("Selected-owner kill-on-close job contains protected process")
    return {"limit_flags": flags, "protected_membership": members}


def _same_kernel_object(first, second):
    # Documented Windows10 API; redacted kernel addresses are never identities.
    try:
        compare = c.WinDLL("kernelbase", use_last_error=True).CompareObjectHandles
    except (AttributeError, OSError) as error:
        raise ValueError("Supported same-object witness is unavailable") from error
    compare.argtypes = [w.HANDLE, w.HANDLE]
    compare.restype = w.BOOL
    if not compare(first, second):
        raise ValueError("Selected-owner job object changed or identity is unknown")


def inspect_protected_jobs(selected, protected, anchor):
    """Query existing jobs; never create, assign, retain or change their limits."""
    if not isinstance(anchor, dict) or not anchor.get("native_creation"):
        raise ValueError("Exact existing Host job anchor required")
    host = selected.get(anchor["pid"])
    if (
        host is None
        or host.created != anchor["created"]
        or os.path.normcase(host.executable) != os.path.normcase(anchor["executable"])
        or Path(host.executable).name.lower() != "agenthub.runtimehost.exe"
    ):
        raise ValueError("Selected Host job anchor identity changed")
    kernel = host.kernel
    kernel.OpenJobObjectW.argtypes = [w.DWORD, w.BOOL, w.LPCWSTR]
    kernel.OpenJobObjectW.restype = w.HANDLE
    kernel.GetCurrentProcess.restype = w.HANDLE
    kernel.DuplicateHandle.argtypes = [
        w.HANDLE,
        w.HANDLE,
        w.HANDLE,
        c.POINTER(w.HANDLE),
        w.DWORD,
        w.BOOL,
        w.DWORD,
    ]
    kernel.QueryInformationJobObject.argtypes = [
        w.HANDLE,
        c.c_int,
        c.c_void_p,
        w.DWORD,
        c.POINTER(w.DWORD),
    ]
    kernel.IsProcessInJob.argtypes = [w.HANDLE, w.HANDLE, c.POINTER(w.BOOL)]
    job = kernel.OpenJobObjectW(
        4, False, "Local\\IIITYRAELIII.AgentHub." + str(anchor["pid"])
    )
    if not job:
        raise c.WinError(c.get_last_error())
    held_jobs = {}
    try:
        first = _system_handles()
        hint = next(
            (e for e in first if e.pid == os.getpid() and e.handle == job), None
        )
        if hint is None:
            raise ValueError("Existing Host job type is unknown")

        def inventory(entries):
            return {
                (e.pid, e.handle)
                for e in entries
                if e.type == hint.type and e.pid in selected
            }

        jobs = inventory(first)
        if len(jobs) > 4096:
            raise ValueError("Selected-owner job inventory exceeded its bound")
        proof = {"named_host_job": _inspect_job(kernel, job, protected), "jobs": []}

        def duplicate_job(pid, original):
            duplicate = w.HANDLE()
            if not kernel.DuplicateHandle(
                selected[pid].handle,
                original,
                kernel.GetCurrentProcess(),
                c.byref(duplicate),
                4,
                False,
                0,
            ):
                raise c.WinError(c.get_last_error())
            return duplicate

        for pid, original in sorted(jobs):
            duplicate = duplicate_job(pid, original)
            held_jobs[(pid, original)] = duplicate
            _inspect_job(kernel, duplicate, protected)
        if inventory(_system_handles()) != jobs:
            raise ValueError("Selected-owner job handles changed during inspection")
        for pid, original in sorted(jobs):
            duplicate = duplicate_job(pid, original)
            try:
                _same_kernel_object(held_jobs[(pid, original)], duplicate)
                record = _inspect_job(kernel, duplicate, protected)
                record.update(
                    owner_pid=pid,
                    same_object_verified=True,
                )
                proof["jobs"].append(record)
            finally:
                kernel.CloseHandle(duplicate)
        return proof
    finally:
        # Closing all query duplicates before the first termination prevents
        # this observer from masking last-handle job teardown behavior.
        for duplicate in held_jobs.values():
            kernel.CloseHandle(duplicate)
        kernel.CloseHandle(job)


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


def pause_stage(plan, worker_file, expected_hash, worker_helper, plan_file, output):
    """Stop only the reviewed copy worker, without claiming Hub quiescence."""
    if digest(worker_file) != expected_hash:
        raise ValueError("Exact stage-worker binding changed")
    expected = json.loads(Path(worker_file).read_text(encoding="utf-8"))
    if (
        expected.get("operation") != plan["operation"]
        or digest(plan_file) != expected.get("plan_sha256")
        or digest(worker_helper) != expected.get("helper_sha256")
        or not expected.get("native_creation")
        or Path(worker_helper).name != "runtime_relocation.py"
    ):
        raise ValueError("Reviewed stage helper/plan identity required")

    def exact_row(rows):
        row = next((r for r in rows if r["pid"] == expected["pid"]), None)
        if row is None:
            return None
        command = str(row.get("command") or "")
        # The exact argv is reviewed with the command hash. These additional
        # guards prevent this narrow action being used for runtime/server stop.
        normalized = command.replace("\\", "/").lower()
        if (
            row["parent"] != expected["parent"]
            or hashlib.sha256(command.encode()).hexdigest()
            != expected["command_sha256"]
            or str(Path(worker_helper)).replace("\\", "/").lower() not in normalized
            or str(Path(plan_file)).replace("\\", "/").lower() not in normalized
            or " stage " not in normalized
            or "--plan " not in normalized
            or expected["plan_sha256"] not in normalized
            or any(r["parent"] == row["pid"] for r in rows)
        ):
            raise ValueError("Stage worker command/parent/children changed")
        return row

    current = exact_row(process_snapshot())
    if current is None:
        result = {
            "operation": plan["operation"],
            "stage_worker_absent": True,
            "outcome": "already_absent; inspect original exit and logs",
            "all_writers_stopped": False,
            "worker_binding_sha256": expected_hash,
            "checked_at": time.time(),
        }
        write_json(output, result)
        return result
    handle = HeldProcess(expected)
    try:
        if exact_row(process_snapshot()) is None:
            raise ValueError(
                "Stage worker exited before final custody check; inspect its exit"
            )
        result = {
            "operation": plan["operation"],
            "worker_binding_sha256": expected_hash,
            "pid": expected["pid"],
            "created": handle.created,
            "stage_worker_absent": False,
            "all_writers_stopped": False,
            "outcome": "stop intent; original stage is not successful",
        }
        write_json(output, result)
        result["outcome"] = handle.stop()
        result["exited"] = handle.exit_time()
        remaining = process_snapshot()
        if any(
            r["pid"] == expected["pid"]
            or (
                r["parent"] == expected["pid"]
                and int(expected["created"])
                <= int(r["created"])
                <= int(result["exited"])
            )
            for r in remaining
        ):
            raise ValueError("Stage worker identity/children remain; resume refused")
        result.update(stage_worker_absent=True, checked_at=time.time())
        write_json(output, result)
        return result
    finally:
        handle.close()


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
    protected = saved.get("protected_processes")
    if not isinstance(protected, list):
        raise ValueError("Explicit protected-process boundary required")
    if not expected:
        raise ValueError("Empty live stop set")
    handles, protected_handles = {}, {}
    try:
        for row in protected:
            if not row.get("native_creation") or row["pid"] in protected_handles:
                raise ValueError("Exact unique protected native identity required")
            if row["pid"] in expected:
                raise ValueError("Protected process overlaps the stop set")
            protected_handles[row["pid"]] = HeldProcess(row, terminate=False)
        for pid, row in expected.items():
            handles[pid] = HeldProcess(row, duplicate=bool(protected))
        snapshot = process_snapshot()
        current = owned_processes(snapshot, roots)
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
        refuse_protected_ancestry(snapshot, expected, protected)
        job_proof = (
            inspect_protected_jobs(handles, protected_handles, saved.get("job_anchor"))
            if protected
            else {"protected_processes": 0, "jobs": []}
        )
        receipt = {
            "operation": plan["operation"],
            "process_plan_sha256": expected_hash,
            "saved_boundary_sha256": digest(saved_file),
            "mode": "controlled process stop; SQLite crash recovery, not graceful shutdown",
            "results": [],
            "attempts": [],
            "all_writers_stopped": False,
            "protected_job_proof": job_proof,
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
            attempt = {
                "pid": pid,
                "created": handles[pid].created,
                "executable": handles[pid].executable,
                "stage": "stop_intent",
                "status": "intent",
                "started_at": time.time(),
            }
            receipt["attempts"].append(attempt)
            write_json(output, receipt)  # Exact identity intent precedes each effect.
            try:
                outcome = handles[pid].stop()
                attempt["stage"] = "exit_time"
                expected[pid]["exited"] = handles[pid].exit_time()
            except BaseException as error:
                details = getattr(handles[pid], "stop_details", {})
                details = details if isinstance(details, dict) else {}
                attempt.update(
                    status="failed",
                    finished_at=time.time(),
                    stop_details=details,
                    stage=attempt["stage"]
                    if attempt["stage"] == "exit_time"
                    else details.get("stage", "stop"),
                    error={
                        "type": type(error).__name__,
                        "message": str(error),
                        "winerror": getattr(error, "winerror", None),
                        "errno": getattr(error, "errno", None),
                    },
                )
                receipt["failure"] = dict(attempt)
                write_json(output, receipt)
                raise
            attempt.update(
                status="completed",
                stage="exited",
                outcome=outcome,
                exited=expected[pid]["exited"],
                finished_at=time.time(),
                stop_details=getattr(handles[pid], "stop_details", {}),
            )
            receipt["results"].append(
                {
                    "pid": pid,
                    "created": handles[pid].created,
                    "outcome": outcome,
                    "exited": expected[pid]["exited"],
                    "stop_details": attempt["stop_details"],
                }
            )
            write_json(output, receipt)
        remaining = owned_processes(
            process_snapshot(), roots, seeds=expected, historical=expected
        )
        if remaining:
            receipt["failure"] = {
                "stage": "verify_absence",
                "remaining": [
                    {"pid": row["pid"], "created": row["created"]} for row in remaining
                ],
            }
            write_json(output, receipt)
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
        for handle in [*handles.values(), *protected_handles.values()]:
            handle.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["capture", "stop", "pause-stage"])
    parser.add_argument("--plan", required=True)
    parser.add_argument("--expected-plan-sha256", required=True)
    parser.add_argument("--process-plan")
    parser.add_argument("--expected-process-plan-sha256")
    parser.add_argument("--saved-proof")
    parser.add_argument("--worker-helper")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    plan = load_plan(args.plan, args.expected_plan_sha256)
    if args.action == "capture":
        result = capture(plan, args.output)
    elif args.action == "pause-stage":
        result = pause_stage(
            plan,
            args.process_plan,
            args.expected_process_plan_sha256,
            args.worker_helper,
            args.plan,
            args.output,
        )
    else:
        result = stop(
            plan,
            args.process_plan,
            args.expected_process_plan_sha256,
            args.saved_proof,
            args.output,
        )
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
