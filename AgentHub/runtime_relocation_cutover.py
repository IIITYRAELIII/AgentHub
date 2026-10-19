"""One operator-owned offline relocation window, launched outside Hub on D.

This is a bounded operation, never a service. It does not install a release,
drain queues, replay commands, or prune originals. Runtime acceptance is a later
operator step through runtime_relocation.py.
"""

import argparse
import ctypes
from datetime import datetime
import json
import os
from pathlib import Path
import sqlite3
import socket
import subprocess
import sys
import time
import traceback

import runtime_relocation as relocation
import runtime_relocation_process as custody


def terminal_barrier(runtime_root, identities):
    """Inspect canonical state read-only; queued input is preserved, not drained."""
    if not identities:
        raise ValueError("Exact arm-turn terminal identities are required")
    db = sqlite3.connect(
        (Path(runtime_root) / "data/runtime.sqlite").as_uri() + "?mode=ro", uri=True
    )
    try:
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        row = db.execute(
            "SELECT value_json FROM runtime_state WHERE key='main'"
        ).fetchone()
        if not row:
            raise ValueError("Canonical runtime state is absent")
        state = json.loads(row[0])
        if not isinstance(state.get("activeRuns"), list):
            raise ValueError("Canonical active-run set is unknown")
        terminals = []
        for identity in identities:
            key = tuple(identity[name] for name in ("provider", "thread_id", "turn_id"))
            terminal = db.execute(
                "SELECT status,committed_at FROM provider_run_terminals WHERE provider=? AND thread_id=? AND turn_id=?",
                key,
            ).fetchone()
            if not terminal or terminal[0] != "completed":
                return None
            datetime.fromisoformat(terminal[1].replace("Z", "+00:00"))
            terminals.append(
                {**identity, "status": terminal[0], "committed_at": terminal[1]}
            )
        if state["activeRuns"]:
            return None
        return {
            "terminals": terminals,
            "active_runs": 0,
            "pending_ids": [v.get("id") for v in state.get("pendingInputs", [])],
            "queued_ids": [v.get("id") for v in state.get("queuedInputs", [])],
            "checked_at": time.time(),
        }
    finally:
        db.close()


def execute(config_file, expected_hash):
    if relocation.digest(config_file) != expected_hash:
        raise ValueError("Exact S2 cutover input changed")
    config = json.loads(Path(config_file).read_text(encoding="utf-8"))
    if os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetCurrentProcess.restype = ctypes.c_void_p
        kernel.IsProcessInJob.argtypes = [
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_int),
        ]
        in_job = ctypes.c_int()
        if (
            not kernel.IsProcessInJob(
                kernel.GetCurrentProcess(), None, ctypes.byref(in_job)
            )
            or in_job.value
        ):
            raise ValueError("Offline helper is not proven independent of a parent job")
    plan = relocation.load_plan(config["plan"], config["plan_sha256"])
    if Path(__file__).resolve().drive.casefold() != Path(plan["roots"][0]["target"]).drive.casefold() or any(relocation.inside(root["source"],__file__) for root in plan["roots"]):
        raise ValueError("Offline helper must live on the destination volume")
    for name, expected in config["helper_sha256"].items():
        if (
            Path(name).name != name
            or relocation.digest(Path(__file__).parent / name) != expected
        ):
            raise ValueError("Frozen migration helper bytes changed")
    root = Path(plan["roots"][0]["source"])
    host = root / "AgentHub.RuntimeHost.exe"
    if relocation.digest(host) != config["host_sha256"]:
        raise ValueError("Installed Host identity changed")
    current = json.loads((root / "current.json").read_text(encoding="utf-8"))["current"]
    if (
        current != config["release"]
        or relocation.digest(root / "releases" / current / "runtime-manifest.json")
        != config["runtime_manifest_sha256"]
    ):
        raise ValueError("Installed release identity changed")
    output = Path(config["output_directory"])
    relocation.plain_directory(output)
    contour_file = Path(config["contour_binding"])
    if relocation.digest(contour_file) != config["contour_binding_sha256"]:
        raise ValueError("Exact existing Contour binding changed")
    contour = json.loads(contour_file.read_text(encoding="utf-8"))
    if len(contour["argv"]) != 16 or contour["argv"][1] != "serve":
        raise ValueError("Only the exact existing Contour serve operation is allowed")
    for record in contour["files"]:
        if relocation.digest(record["path"]) != record["sha256"]:
            raise ValueError("Existing Contour pointer/marker/source identity changed")
    if (
        relocation.digest(config["saved_boundary"]) != config["saved_boundary_sha256"]
        or relocation.digest(config["durable_readback"])
        != config["durable_readback_sha256"]
    ):
        raise ValueError("Saved boundary or original receipt witness changed")
    saved = json.loads(Path(config["saved_boundary"]).read_text(encoding="utf-8"))
    if (
        saved.get("operation") != plan["operation"]
        or not saved.get("all_streams_saved_stopped")
        or not saved.get("streams")
    ):
        raise ValueError("Saved stream boundary is required")
    deadline = time.monotonic() + min(
        900, max(1, config.get("terminal_wait_seconds", 600))
    )
    barrier = None
    while time.monotonic() < deadline:
        barrier = terminal_barrier(root, config["terminal_identities"])
        if barrier is not None:
            break
        time.sleep(1)  # Bounded arm-turn barrier, never evidence of terminality.
    if barrier is None:
        raise TimeoutError("Terminal barrier not reached; no process stopped")
    relocation.write_json(output / "terminal-barrier.json", barrier)
    custody.capture(plan, output / "processes.json")
    if terminal_barrier(root, config["terminal_identities"]) is None:
        raise ValueError("A new managed run appeared before stop")
    saved.update(
        checked_at=time.time(),
        durable_readback_sha256=config["durable_readback_sha256"],
    )
    relocation.write_json(output / "saved-at-barrier.json", saved)
    custody.stop(
        plan,
        output / "processes.json",
        relocation.digest(output / "processes.json"),
        output / "saved-at-barrier.json",
        output / "stopped.json",
    )
    relocation.require_stopped(output / "stopped.json", plan)
    relocation.copy_roots(plan, offline=True)
    relocation.validate_databases(plan)
    relocation.refresh_stopped(
        plan, output / "stopped.json", output / "pre-switch-stopped.json"
    )
    relocation.require_stopped(output / "pre-switch-stopped.json", plan)
    relocation.switch_roots(plan)
    for record in contour["files"]:
        if relocation.digest(record["path"]) != record["sha256"]:
            raise ValueError("Relocated Contour identity differs")
    # No start/refresh/verify or candidate construction. Preserve mutable old
    # bootstrap state before the same serve owner rewrites nonce/config/PIDs.
    contour_root = Path(contour["argv"][3])
    evidence = (
        Path(plan["roots"][0]["target"]) / "migration-evidence" / plan["operation"]
    )
    evidence.mkdir(parents=True, exist_ok=False)
    for name in ("config.json", "test-contour-state.json"):
        file = contour_root / name
        if file.exists():
            relocation.copy_file(
                file, evidence / ("contour-before-" + name), plan["operation"]
            )
    port = int(contour["argv"][5])
    with socket.socket() as probe:
        if probe.connect_ex(("127.0.0.1", port)) == 0:
            raise ValueError("Existing Contour port is occupied; no relaunch")
    temporary = Path(plan["roots"][0]["target"]) / "temp"
    temporary.mkdir(exist_ok=True)
    relocation.plain_directory(temporary)
    env = os.environ.copy()
    env.update(TEMP=str(temporary), TMP=str(temporary))
    # Invoke the old logical path: isolated installed-Host probe must be reviewed.
    # Windows file handles resolve its executable and all data physically to D.
    relocation.admit_start(plan)
    child = subprocess.Popen(
        [str(host)],
        cwd=plan["roots"][0]["target"],
        env=env,
        creationflags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP,
        close_fds=True,
    )
    contour_env = {k: v for k, v in env.items() if not k.startswith("AGENT_HUB_")}
    contour_env["AGENT_HUB_RUNTIME_ROOT"] = str(contour_root)
    with open(evidence / "contour-serve.log", "xb") as log:
        contour_child = subprocess.Popen(
            [contour["exe"], *contour["argv"]],
            cwd=contour["cwd"],
            env=contour_env,
            stdout=log,
            stderr=log,
            creationflags=subprocess.CREATE_NO_WINDOW
            | subprocess.CREATE_NEW_PROCESS_GROUP,
            close_fds=True,
        )
    result = {
        "operation": plan["operation"],
        "phase": "start_admitted",
        "host_pid": child.pid,
        "contour_manager_pid": contour_child.pid,
        "logical_runtime_root": str(root),
        "physical_runtime_root": plan["roots"][0]["target"],
        "originals_retained": True,
        "operator_acceptance_required": True,
    }
    relocation.write_json(output / "start-admitted.json", result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--expected-config-sha256", required=True)
    args = parser.parse_args()
    if relocation.digest(args.config) != args.expected_config_sha256:
        raise ValueError("Exact S2 invocation changed")
    config = json.loads(Path(args.config).read_text(encoding="utf-8"))
    output = relocation.plain_directory(config["output_directory"])
    with open(output / "cutover.log", "x", encoding="utf-8", buffering=1) as log:
        sys.stdout = sys.stderr = log
        try:
            result = execute(args.config, args.expected_config_sha256)
            print(json.dumps(result), flush=True)
        except BaseException:
            traceback.print_exc()
            raise


if __name__ == "__main__":
    main()
