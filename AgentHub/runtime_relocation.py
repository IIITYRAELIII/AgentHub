"""Offline runtime-root relocation; never changes Hub business state or Git refs.

The operation-local SQLite file is a file-copy manifest, not a Hub state store.
Runtime stop/start and acceptance belong to the operator, not this module.
"""

from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import subprocess
import time
import uuid


def long_path(value):
    value = os.path.abspath(value)
    if os.name != "nt" or value.startswith("\\\\?\\"):
        return value
    return "\\\\?\\UNC\\" + value[2:] if value.startswith("\\\\") else "\\\\?\\" + value


def info(value):
    s = os.stat(long_path(value), follow_symlinks=False)
    return {
        "dev": str(s.st_dev),
        "ino": str(s.st_ino),
        "size": s.st_size,
        "mtime": s.st_mtime_ns,
        "ctime": s.st_ctime_ns,
        "attributes": getattr(s, "st_file_attributes", 0),
        "tag": getattr(s, "st_reparse_tag", 0),
        "links": s.st_nlink,
        "mode": s.st_mode,
    }


def reparse(value):
    return bool(info(value)["attributes"] & 0x400) or stat.S_ISLNK(info(value)["mode"])


def plain_directory(value):
    p = Path(os.path.abspath(value))
    for parent in [p, *p.parents]:
        if not parent.exists() or reparse(parent) or not parent.is_dir():
            raise ValueError(f"Missing or reparse directory: {parent}")
    return p


def inside(root, value):
    root, value = (
        os.path.normcase(os.path.abspath(root)),
        os.path.normcase(os.path.abspath(value)),
    )
    try:
        return value != root and os.path.commonpath([root, value]) == root
    except ValueError:  # Different Windows volumes cannot contain one another.
        return False


def digest(file):
    h = hashlib.sha256()
    if os.name == "nt":
        import msvcrt

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateFileW.argtypes = [
            wintypes.LPCWSTR,
            wintypes.DWORD,
            wintypes.DWORD,
            ctypes.c_void_p,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.HANDLE,
        ]
        kernel.CreateFileW.restype = wintypes.HANDLE
        handle = kernel.CreateFileW(long_path(file), 1, 7, None, 3, 0x200000, None)
        if handle == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        stream = os.fdopen(
            msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY), "rb"
        )
    else:
        stream = open(long_path(file), "rb")
    with stream as f:
        for chunk in iter(lambda: f.read(4 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def named_streams(file):
    """Enumerate NTFS data streams without following a file reparse point."""
    if os.name != "nt":
        return []

    class StreamData(ctypes.Structure):
        _fields_ = [("size", ctypes.c_longlong), ("name", wintypes.WCHAR * 296)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.FindFirstStreamW.argtypes = [
        wintypes.LPCWSTR,
        ctypes.c_int,
        ctypes.POINTER(StreamData),
        wintypes.DWORD,
    ]
    kernel.FindFirstStreamW.restype = wintypes.HANDLE
    kernel.FindNextStreamW.argtypes = [wintypes.HANDLE, ctypes.POINTER(StreamData)]
    kernel.FindClose.argtypes = [wintypes.HANDLE]
    data = StreamData()
    handle = kernel.FindFirstStreamW(long_path(file), 0, ctypes.byref(data), 0)
    if handle == ctypes.c_void_p(-1).value:
        if ctypes.get_last_error() == 38:
            return []
        raise ctypes.WinError(ctypes.get_last_error())
    streams = []
    try:
        while True:
            if data.name != "::$DATA":
                streams.append((data.name, data.size))
            if not kernel.FindNextStreamW(handle, ctypes.byref(data)):
                if ctypes.get_last_error() != 38:
                    raise ctypes.WinError(ctypes.get_last_error())
                break
    finally:
        kernel.FindClose(handle)
    return sorted(streams)


def content_digest(file, default_hash=None):
    """Default stream SHA for ordinary files; bind every named stream if present."""
    default = default_hash or digest(file)
    streams = named_streams(file)
    if not streams:
        return default
    records = [["::$DATA", default]]
    records.extend([name, size, digest(str(file) + name)] for name, size in streams)
    return hashlib.sha256(json.dumps(records, ensure_ascii=False).encode()).hexdigest()


def write_json(file, value):
    p = Path(file)
    temporary = p.with_name(p.name + "." + uuid.uuid4().hex + ".tmp")
    with open(temporary, "x", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(temporary, p)


def tree(root, tolerate_disappearance=False):
    """Yield entries without traversing any reparse point, including junctions."""
    pending = ["."]
    while pending:
        rel = pending.pop()
        p = Path(root) / rel
        try:
            s = info(p)
        except FileNotFoundError:
            if tolerate_disappearance:
                continue
            raise
        if s["attributes"] & 0x400 or stat.S_ISLNK(s["mode"]):
            target = os.readlink(long_path(p))
            if os.name == "nt" and s["tag"] not in (0xA0000003, 0xA000000C):
                raise ValueError(f"Unsupported reparse tag: {p}")
            yield rel, "link", s, target
        elif stat.S_ISDIR(s["mode"]):
            yield rel, "directory", s, None
            with os.scandir(long_path(p)) as entries:
                names = sorted(e.name for e in entries)
            pending.extend(str(Path(rel) / name) for name in reversed(names))
        elif stat.S_ISREG(s["mode"]):
            yield rel, "file", s, None
        else:
            raise ValueError(f"Unsupported filesystem entry: {p}")


def same_identity(a, b):
    return all(
        a[k] == b[k]
        for k in ("dev", "ino", "size", "mtime", "ctime", "attributes", "tag")
    )


def connect(file):
    db = sqlite3.connect(file)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=FULL")
    return db


def create_plan(plan_file, pairs):
    if not pairs:
        raise ValueError("At least one explicit source/destination pair is required")
    if Path(plan_file).exists():
        raise ValueError("Plan already exists; resume its original identity")
    roots = []
    for source, target in pairs:
        source = plain_directory(source)
        target = Path(os.path.abspath(target))
        if target.exists():
            raise ValueError(f"Target already exists: {target}")
        ancestor = target.parent
        while not ancestor.exists():
            ancestor = ancestor.parent
        plain_directory(ancestor)
        if source == Path(source.anchor) or target == Path(target.anchor):
            raise ValueError("A volume root cannot be relocated")
        roots.append(
            {"source": str(source), "target": str(target), "identity": info(source)}
        )
    for i, left in enumerate(roots):
        for j, right in enumerate(roots):
            if (
                (
                    i != j
                    and (
                        left["source"] == right["source"]
                        or inside(left["source"], right["source"])
                    )
                )
                or inside(left["source"], right["target"])
                or left["source"] == right["target"]
            ):
                raise ValueError("Source roots overlap or contain a destination")
            if i != j and (
                left["target"] == right["target"]
                or inside(left["target"], right["target"])
            ):
                # A main root may contain the explicitly selected external targets.
                if not inside(left["target"], right["target"]):
                    raise ValueError("Duplicate destination")
    operation = uuid.uuid4().hex
    plan = {
        "version": 1,
        "operation": operation,
        "created": time.time(),
        "roots": roots,
    }
    for root in roots:
        root["original"] = str(
            Path(root["source"]).with_name(
                Path(root["source"]).name + ".relocation-original-" + operation
            )
        )
        if Path(root["original"]).exists():
            raise ValueError("Original holding path exists")
    manifest = Path(plan_file).with_suffix(".files.sqlite")
    if manifest.exists():
        raise ValueError("Manifest exists")
    plan["manifest"] = str(manifest.absolute())
    db = connect(manifest)
    db.execute(
        "CREATE TABLE files(root INTEGER, rel TEXT, kind TEXT, identity TEXT, link_target TEXT, sha256 TEXT, copied INTEGER DEFAULT 0, generation INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0, PRIMARY KEY(root,rel))"
    )
    db.execute("CREATE INDEX files_identity ON files(root,kind,copied)")
    db.execute("CREATE INDEX files_prune ON files(root,length(rel) DESC,rel DESC)")
    db.execute("CREATE TABLE state(key TEXT PRIMARY KEY, value TEXT)")
    db.execute(
        "CREATE TABLE departed(root INTEGER,rel TEXT,kind TEXT,identity TEXT,sha256 TEXT,quarantine TEXT,PRIMARY KEY(root,rel))"
    )
    db.execute("INSERT INTO state VALUES('phase','planned')")
    entries = logical = 0
    for index, root in enumerate(roots):
        for rel, kind, identity, link_target in tree(
            root["source"], tolerate_disappearance=True
        ):
            db.execute(
                "INSERT INTO files(root,rel,kind,identity,link_target) VALUES(?,?,?,?,?)",
                (index, rel, kind, json.dumps(identity), link_target),
            )
            entries += 1
            if kind == "file":
                logical += identity["size"]
            if entries % 1000 == 0:
                db.commit()
            if entries % 10000 == 0:
                print(
                    json.dumps(
                        {"phase": "index", "entries": entries, "logical_bytes": logical}
                    ),
                    flush=True,
                )
    plan["indexed_entries"] = entries
    plan["indexed_logical_bytes"] = logical
    db.commit()
    db.close()
    write_json(plan_file, plan)
    return {"plan": str(plan_file), "sha256": digest(plan_file), "roots": roots}


def load_plan(file, expected_hash):
    if digest(file) != expected_hash:
        raise ValueError("Exact reviewed plan digest changed")
    plan = json.loads(Path(file).read_text(encoding="utf-8"))
    if plan.get("version") != 1:
        raise ValueError("Unsupported relocation plan")
    return plan


def extend_plan(plan_file, expected_hash, pairs, empty_aliases=()):
    """Append explicit roots before staging, without rescanning earlier roots."""
    plan = load_plan(plan_file, expected_hash)
    db = connect(plan["manifest"])
    try:
        if phase(db) != "planned":
            raise ValueError("Plan extension is limited to the preview phase")
        roots = list(plan["roots"])
        for source, target in pairs:
            source, target = plain_directory(source), Path(os.path.abspath(target))
            if source == Path(source.anchor) or target == Path(target.anchor):
                raise ValueError("Volume roots cannot be relocated")
            if os.path.lexists(long_path(target)):
                raise ValueError("Extension destination already exists")
            for root in roots:
                if (
                    source == Path(root["source"])
                    or inside(source, root["source"])
                    or inside(root["source"], source)
                ):
                    raise ValueError("Extension source overlaps an existing root")
                if (
                    target == Path(root["target"])
                    or inside(source, root["target"])
                    or inside(root["source"], target)
                ):
                    raise ValueError("Extension destination conflicts with a root")
            root = {
                "source": str(source),
                "target": str(target),
                "identity": info(source),
                "original": str(
                    source.with_name(
                        source.name + ".relocation-original-" + plan["operation"]
                    )
                ),
            }
            if os.path.lexists(long_path(root["original"])):
                raise ValueError("Extension original holding path already exists")
            index = len(roots)
            for rel, kind, identity, link_target in tree(
                source, tolerate_disappearance=True
            ):
                db.execute(
                    "INSERT INTO files(root,rel,kind,identity,link_target) VALUES(?,?,?,?,?)",
                    (index, rel, kind, json.dumps(identity), link_target),
                )
            roots.append(root)
        for source, target in empty_aliases:
            source, target = (
                Path(os.path.abspath(source)),
                Path(os.path.abspath(target)),
            )
            if os.path.lexists(long_path(source)) or os.path.lexists(long_path(target)):
                raise ValueError("Empty compatibility path unexpectedly exists")
            plain_directory(source.parent)
            if not inside(roots[0]["target"], target):
                raise ValueError(
                    "Empty compatibility target must stay inside the main destination"
                )
            plan.setdefault("empty_aliases", []).append(
                {"source": str(source), "target": str(target)}
            )
        plan["roots"] = roots
        plan["indexed_entries"] = db.execute("SELECT count(*) FROM files").fetchone()[0]
        db.commit()
        write_json(plan_file, plan)
        return {
            "plan_sha256": digest(plan_file),
            "roots": len(roots),
            "indexed_entries": plan["indexed_entries"],
        }
    finally:
        db.close()


def phase(db):
    return db.execute("SELECT value FROM state WHERE key='phase'").fetchone()[0]


def set_phase(db, value):
    db.execute("UPDATE state SET value=? WHERE key='phase'", (value,))
    db.commit()


def ensure_destination(plan, index):
    root = plan["roots"][index]
    target = Path(root["target"])
    marker = target / ".agent-hub-relocation-owner.json"
    expected = {
        "operation": plan["operation"],
        "source": root["source"],
        "target": root["target"],
    }
    if marker.exists():
        if json.loads(marker.read_text()) != expected:
            raise ValueError("Destination owner changed")
        plain_directory(target)
        return
    if target.exists():
        raise ValueError("Unowned destination appeared")
    target.mkdir(parents=True)
    # Copying configuration/secrets must not make them readable by other users.
    if os.name == "nt":
        sid = (
            subprocess.check_output(["whoami", "/user", "/fo", "csv", "/nh"], text=True)
            .strip()
            .split(",")[-1]
            .strip('"')
        )
        subprocess.run(
            [
                "icacls",
                str(target),
                "/inheritance:r",
                "/grant:r",
                f"*{sid}:(OI)(CI)F",
                "*S-1-5-18:(OI)(CI)F",
                "*S-1-5-32-544:(OI)(CI)F",
            ],
            check=True,
            capture_output=True,
        )
    write_json(marker, expected)


def copy_file(source, target, operation):
    temporary = target.with_name(target.name + ".relocation-" + operation + ".tmp")
    existing_temporary = os.path.lexists(long_path(temporary))
    if existing_temporary and (
        reparse(temporary) or content_digest(temporary) != content_digest(source)
    ):
        raise ValueError(f"Unresolved temporary copy: {temporary}")
    if not existing_temporary and os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CopyFileW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.BOOL]
        if not kernel.CopyFileW(long_path(source), long_path(temporary), True):
            raise ctypes.WinError(ctypes.get_last_error())
    elif not existing_temporary:
        shutil.copy2(source, temporary)
    source_hash, copied_hash = content_digest(source), content_digest(temporary)
    if source_hash != copied_hash:
        raise ValueError(f"Copy checksum differs: {source}")
    if target.exists() and reparse(target):
        raise ValueError("Copy target became a reparse point")
    if os.path.exists(long_path(target)) and info(target)["attributes"] & 1:
        delete_verified_file(target, info(target), content_digest(target))
    os.replace(long_path(temporary), long_path(target))
    return copied_hash


def make_link(source, target, tag, directory):
    if os.path.lexists(long_path(target)):
        if not reparse(target) or os.readlink(long_path(target)) != source:
            raise ValueError(f"Destination link differs: {target}")
        return
    if os.name == "nt" and tag == 0xA0000003:
        if any(c in str(target) + source for c in '&|<>^%!"\r\n'):
            raise ValueError("Unsafe junction argument")
        subprocess.run(
            ["cmd.exe", "/d", "/c", "mklink", "/J", str(target), source],
            check=True,
            capture_output=True,
        )
    else:
        os.symlink(source, long_path(target), target_is_directory=directory)


def copy_roots(plan, offline=False):
    db = connect(plan["manifest"])
    try:
        if phase(db) not in ("planned", "staged", "copied_offline"):
            raise ValueError("Copy cannot run after verification/switch")
        generation = time.time_ns()
        count = copied_bytes = 0
        linked = {}
        for i, root in enumerate(plan["roots"]):
            if info(root["source"])["ino"] != root["identity"]["ino"]:
                raise ValueError("Source root identity changed")
            plain_directory(root["source"])
            ensure_destination(plan, i)
            for rel, kind, identity, link_target in tree(
                root["source"], tolerate_disappearance=not offline
            ):
                source, target = Path(root["source"]) / rel, Path(root["target"]) / rel
                if rel == ".agent-hub-relocation-owner.json":
                    raise ValueError("Source contains a relocation owner marker")
                old = db.execute(
                    "SELECT * FROM files WHERE root=? AND rel=?", (i, rel)
                ).fetchone()
                if old and old["kind"] != kind:
                    raise ValueError(f"Entry type changed: {source}")
                if kind == "directory":
                    os.makedirs(long_path(target), exist_ok=True)
                    if reparse(target):
                        raise ValueError("Destination directory became reparse")
                    sha, copied = None, 1
                elif kind == "link":
                    # Preserve the original target verbatim. Compatibility aliases
                    # retain absolute historical links; never follow their targets.
                    make_link(
                        link_target,
                        target,
                        identity["tag"],
                        bool(identity["attributes"] & 0x10),
                    )
                    sha, copied = None, 1
                elif not offline and (
                    ".sqlite" in source.name.lower()
                    or source.suffix.lower()
                    in (".db", ".json", ".log", ".tmp", ".lock")
                    or source.name.lower().endswith(("-wal", "-shm"))
                ):
                    sha, copied = None, 0
                else:
                    if not old:
                        # Persist ownership before the copy effect. A process crash
                        # may leave the exact operation temporary/target behind.
                        db.execute(
                            "INSERT INTO files(root,rel,kind,identity,copied,generation) VALUES(?,?,?,?,?,?)",
                            (i, rel, kind, json.dumps(identity), -1, generation),
                        )
                        db.commit()
                    if os.path.exists(long_path(target)) and not old:
                        raise ValueError(f"Unowned file at destination: {target}")
                    if (
                        os.path.exists(long_path(target))
                        and old
                        and not old["copied"]
                        and (
                            reparse(target)
                            or content_digest(target) != content_digest(source)
                        )
                    ):
                        raise ValueError(f"Pending destination differs: {target}")
                    if (
                        old
                        and old["copied"]
                        and same_identity(json.loads(old["identity"]), identity)
                        and os.path.exists(long_path(target))
                        and not reparse(target)
                    ):
                        source_hash, target_hash = (
                            content_digest(source),
                            content_digest(target),
                        )
                    else:
                        source_hash, target_hash = None, None
                    if source_hash and source_hash == target_hash:
                        sha = target_hash
                    else:
                        key = (identity["dev"], identity["ino"])
                        if key in linked and not os.path.exists(long_path(target)):
                            os.link(long_path(linked[key]), long_path(target))
                            sha = content_digest(target)
                            if content_digest(source) != sha:
                                raise ValueError("Source hardlink contents changed")
                        else:
                            sha = copy_file(source, target, plan["operation"])
                        if not same_identity(identity, info(source)):
                            raise ValueError(f"Source changed during copy: {source}")
                        copied_bytes += identity["size"]
                    linked[(identity["dev"], identity["ino"])] = target
                    copied = 1
                db.execute(
                    "INSERT OR REPLACE INTO files(root,rel,kind,identity,link_target,sha256,copied,generation) VALUES(?,?,?,?,?,?,?,?)",
                    (
                        i,
                        rel,
                        kind,
                        json.dumps(identity),
                        link_target,
                        sha,
                        copied,
                        generation,
                    ),
                )
                count += 1
                if count % 1000 == 0:
                    db.commit()
                if count % 10000 == 0:
                    print(
                        json.dumps(
                            {
                                "phase": "offline-copy" if offline else "stage",
                                "entries": count,
                                "copied_bytes": copied_bytes,
                            }
                        ),
                        flush=True,
                    )
        # Staging is not a coherent snapshot. Preserve any copied file that later
        # disappears from the live source in the operation's D-side quarantine.
        # It must not reappear as a current receipt/config in the new runtime.
        stale = db.execute(
            "SELECT * FROM files WHERE generation<>? ORDER BY length(rel) DESC,rel DESC",
            (generation,),
        ).fetchall()
        for row in stale:
            destination = Path(plan["roots"][row["root"]]["target"]) / row["rel"]
            quarantine = (
                Path(plan["manifest"]).parent
                / ("staged-departed-" + plan["operation"])
                / str(row["root"])
                / row["rel"]
            )
            if os.path.lexists(long_path(destination)):
                if row["kind"] == "directory":
                    if reparse(destination):
                        raise ValueError("Stale directory became reparse")
                    os.rmdir(long_path(destination))  # Empty only.
                else:
                    if row["kind"] == "file" and (
                        not row["sha256"]
                        or reparse(destination)
                        or content_digest(destination) != row["sha256"]
                    ):
                        raise ValueError(
                            "Departed staged file changed; preserve and inspect"
                        )
                    if row["kind"] == "link" and (
                        not reparse(destination)
                        or os.readlink(long_path(destination)) != row["link_target"]
                    ):
                        raise ValueError("Departed staged link changed")
                    os.makedirs(long_path(quarantine.parent), exist_ok=True)
                    if os.path.lexists(long_path(quarantine)):
                        raise ValueError("Departed evidence already exists")
                    os.rename(long_path(destination), long_path(quarantine))
            db.execute(
                "INSERT OR REPLACE INTO departed VALUES(?,?,?,?,?,?)",
                (
                    row["root"],
                    row["rel"],
                    row["kind"],
                    row["identity"],
                    row["sha256"],
                    str(quarantine),
                ),
            )
            db.execute(
                "DELETE FROM files WHERE root=? AND rel=?", (row["root"], row["rel"])
            )
        set_phase(db, "copied_offline" if offline else "staged")
        if offline:
            verify_offline_copy(plan)
        return {"phase": phase(db), "entries": count, "copied_bytes": copied_bytes}
    finally:
        db.close()


def validate_databases(plan):
    """Read-only checks after the entire offline database+sidecar cohort exists."""
    db = connect(plan["manifest"])
    checked = []
    try:
        if phase(db) not in ("verified", "integrity_verified"):
            raise ValueError("Offline verified copy required")
        for row in db.execute(
            "SELECT root,rel FROM files WHERE kind='file' AND (rel LIKE '%.sqlite' OR rel LIKE '%.db')"
        ):
            target = Path(plan["roots"][row["root"]]["target"]) / row["rel"]
            critical = Path(row["rel"]).parent == Path("data")
            with open(long_path(target), "rb") as f:
                if f.read(16) != b"SQLite format 3\x00":
                    if critical:
                        raise ValueError(
                            f"Critical copied database header is invalid: {target}"
                        )
                    continue  # A .db suffix alone is not an SQLite assertion.
            outcome = "ok"
            try:
                connection = sqlite3.connect(
                    Path(long_path(target)).as_uri() + "?mode=ro", uri=True, timeout=2
                )
                try:
                    connection.execute("PRAGMA query_only=ON")
                    result = connection.execute("PRAGMA integrity_check").fetchall()
                    if result != [("ok",)]:
                        outcome = "failed"
                finally:
                    connection.close()
            except sqlite3.DatabaseError:
                outcome = "failed"
            checked.append(
                {
                    "root": row["root"],
                    "rel": row["rel"],
                    "integrity": outcome,
                    "critical": critical,
                }
            )
            if outcome != "ok" and critical:
                write_json(
                    Path(plan["manifest"]).with_suffix(".integrity-failed.json"),
                    {"operation": plan["operation"], "databases": checked},
                )
                raise ValueError(
                    f"Critical copied SQLite integrity check failed: {target}"
                )
            # Non-current retained fixtures may deliberately contain invalid DBs.
            # Their exact original bytes were copied, and failure stays explicit.
        report = {
            "operation": plan["operation"],
            "databases": checked,
            "checked_at": time.time(),
        }
        write_json(Path(plan["manifest"]).with_suffix(".integrity.json"), report)
        set_phase(db, "integrity_verified")
        return {"databases_checked": len(checked)}
    finally:
        db.close()


def require_stopped(proof_file, plan, allow_expired=False):
    proof = json.loads(Path(proof_file).read_text(encoding="utf-8"))
    if (
        proof.get("operation") != plan["operation"]
        or proof.get("all_writers_stopped") is not True
        or not proof.get("saved_streams")
    ):
        raise ValueError("Exact operator quiescence proof required")
    if not allow_expired and time.time() - proof.get("checked_at", 0) > 300:
        raise ValueError("Quiescence proof expired")
    if os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetProcessTimes.argtypes = [
            wintypes.HANDLE,
            *([ctypes.POINTER(ctypes.c_ulonglong)] * 4),
        ]
        kernel.GetProcessTimes.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        rows = {row["pid"]: row for row in proof.get("results", [])}
        if not rows or set(rows) != set(proof.get("stopped_pids", [])):
            raise ValueError("Exact retained-handle stop results required")
        for pid, row in rows.items():
            handle = kernel.OpenProcess(0x1000, False, int(pid))
            if handle:
                try:
                    born, ended, used_kernel, used_user = (
                        ctypes.c_ulonglong() for _ in range(4)
                    )
                    if not kernel.GetProcessTimes(
                        handle,
                        ctypes.byref(born),
                        ctypes.byref(ended),
                        ctypes.byref(used_kernel),
                        ctypes.byref(used_user),
                    ):
                        raise ctypes.WinError(ctypes.get_last_error())
                    if str(born.value) == row["created"] and ended.value == 0:
                        raise ValueError(
                            f"Stopped exact writer is still present: {pid}"
                        )
                    # A reused PID names another process, never this stopped owner.
                finally:
                    kernel.CloseHandle(handle)
            elif ctypes.get_last_error() != 87:
                raise ValueError(f"Writer process absence is unknown: {pid}")
        assert_no_source_processes(plan)


def refresh_stopped(plan, old_proof, output):
    if Path(old_proof).absolute() == Path(output).absolute():
        raise ValueError("Keep the original stop receipt immutable")
    require_stopped(old_proof, plan, allow_expired=True)
    proof = json.loads(Path(old_proof).read_text(encoding="utf-8"))
    proof.update(previous_proof_sha256=digest(old_proof), checked_at=time.time())
    write_json(output, proof)
    return {"proof": str(output), "sha256": digest(output)}


def verify_offline_copy(plan):
    assert_no_source_processes(plan)
    db = connect(plan["manifest"])
    try:
        if phase(db) != "copied_offline":
            raise ValueError("Complete offline copy required")
        set_phase(db, "verified")
    finally:
        db.close()


def assert_no_source_processes(plan):
    if os.name == "nt":
        from runtime_relocation_process import owned_processes, process_snapshot

        remaining = owned_processes(
            process_snapshot(), [r["source"] for r in plan["roots"]]
        )
        if remaining:
            raise ValueError(
                "Source-owned processes remain; offline copy/switch refused"
            )


def switch_roots(plan):
    db = connect(plan["manifest"])
    try:
        if phase(db) not in ("integrity_verified", "switching"):
            raise ValueError("Offline verified transfer required")
        set_phase(db, "switching")
        for root in plan["roots"]:
            source, original, target = map(
                Path, (root["source"], root["original"], root["target"])
            )
            plain_directory(target)
            if source.exists() and reparse(source):
                if source.resolve() != target.resolve():
                    raise ValueError("Compatibility alias changed")
                continue
            if not original.exists():
                if info(source)["ino"] != root["identity"]["ino"]:
                    raise ValueError("Source root identity changed")
                os.rename(source, original)
            elif info(original)["ino"] != root["identity"]["ino"] or source.exists():
                raise ValueError("Original holding path changed")
            make_link(str(target), source, 0xA0000003, True)
        for alias in plan.get("empty_aliases", []):
            source, target = Path(alias["source"]), Path(alias["target"])
            if os.path.lexists(long_path(source)):
                if not reparse(source) or source.resolve() != target.resolve():
                    raise ValueError("Unexpected compatibility spool source")
            else:
                if target.exists():
                    raise ValueError("Unexpected compatibility spool destination")
                target.mkdir(parents=True)
                make_link(str(target), source, 0xA0000003, True)
        set_phase(db, "switched")
        return {"phase": "switched", "sources_retained_until_runtime_acceptance": True}
    finally:
        db.close()


def rollback_roots(plan):
    """Return names only, before any replacement runtime has been admitted.

    After target startup, automatic rollback would lose new target writes and is
    deliberately refused. Recovery then needs the same offline copy owner.
    """
    db = connect(plan["manifest"])
    try:
        if phase(db) not in ("switching", "switched"):
            raise ValueError("Rollback is limited to pre-start switch recovery")
        for alias in plan.get("empty_aliases", []):
            source, target = Path(alias["source"]), Path(alias["target"])
            if os.path.lexists(long_path(source)):
                if not reparse(source) or source.resolve() != target.resolve():
                    raise ValueError("Compatibility spool alias changed")
                os.rmdir(source)
        for root in reversed(plan["roots"]):
            source, original, target = map(
                Path, (root["source"], root["original"], root["target"])
            )
            if original.exists():
                if info(original)["ino"] != root["identity"]["ino"]:
                    raise ValueError("Original root identity changed")
                if os.path.lexists(long_path(source)):
                    if not reparse(source) or source.resolve() != target.resolve():
                        raise ValueError("Compatibility alias changed")
                    os.rmdir(source)  # Junction only, never its target.
                os.rename(original, source)
        set_phase(db, "rolled_back")
        return {"phase": "rolled_back", "destination_copies_preserved": True}
    finally:
        db.close()


def admit_start(plan):
    db = connect(plan["manifest"])
    try:
        if phase(db) != "switched":
            raise ValueError("Switched roots required before runtime admission")
        set_phase(db, "start_admitted")
        return {"phase": "start_admitted", "automatic_rollback_forbidden": True}
    finally:
        db.close()


def accept_started(plan, proof_file):
    proof = json.loads(Path(proof_file).read_text(encoding="utf-8"))
    if (
        proof.get("operation") != plan["operation"]
        or proof.get("runtime_verified") is not True
        or proof.get("physical_runtime_root") != plan["roots"][0]["target"]
        or proof.get("logical_runtime_root")
        not in (plan["roots"][0]["source"], plan["roots"][0]["target"])
    ):
        raise ValueError("Exact operator runtime verification proof required")
    for key in (
        "release",
        "node_pid",
        "host_pid",
        "history",
        "attachments",
        "mcp",
        "queue_recovery",
        "readonly_legacy_ipc",
        "physical_file_handles",
    ):
        if not proof.get(key):
            raise ValueError(f"Missing runtime verification: {key}")
    db = connect(plan["manifest"])
    try:
        if phase(db) not in ("start_admitted", "accepted"):
            raise ValueError("Switched runtime required")
        db.execute(
            "INSERT OR REPLACE INTO state VALUES('runtime_proof_sha256',?)",
            (digest(proof_file),),
        )
        set_phase(db, "accepted")
        return {"phase": "accepted", "originals_not_yet_deleted": True}
    finally:
        db.close()


def delete_verified_file(file, expected, expected_hash):
    """Hash and delete the same exclusively opened Windows file handle."""
    if os.name != "nt":
        raise ValueError("Verified source pruning is Windows-only")
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.c_void_p,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.SetFileInformationByHandle.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
    ]
    kernel.SetFileInformationByHandle.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    # Deny concurrent writers/deletion; OPEN_REPARSE_POINT never follows a link.
    handle = kernel.CreateFileW(
        long_path(file), 0x10000 | 0x80 | 1, 1, None, 3, 0x200000, None
    )
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    import msvcrt

    descriptor = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
    try:
        s = os.fstat(descriptor)
        if (
            str(s.st_dev) != expected["dev"]
            or str(s.st_ino) != expected["ino"]
            or s.st_size != expected["size"]
            or getattr(s, "st_file_attributes", 0) & 0x400
        ):
            raise ValueError("Source deletion file identity changed")
        h = hashlib.sha256()
        while chunk := os.read(descriptor, 4 * 1024 * 1024):
            h.update(chunk)
        # Check named streams even when the original had none: a later added
        # stream must also block deletion of the original.
        if content_digest(file, h.hexdigest()) != expected_hash:
            raise ValueError("Source deletion checksum changed")
        # DELETE | POSIX_SEMANTICS | IGNORE_READONLY_ATTRIBUTE. The latter permits
        # removal of copied Git object files without an unsafe pathname chmod.
        disposition = wintypes.DWORD(0x13)
        if not kernel.SetFileInformationByHandle(
            handle, 21, ctypes.byref(disposition), ctypes.sizeof(disposition)
        ):
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        os.close(descriptor)


def prune_originals(plan):
    db = connect(plan["manifest"])
    before = {
        str(Path(r["source"]).anchor): shutil.disk_usage(Path(r["source"]).anchor).free
        for r in plan["roots"]
    }
    deleted = count = 0
    try:
        if phase(db) not in ("accepted", "pruning"):
            raise ValueError("Verified target runtime acceptance required")
        set_phase(db, "pruning")
        for i, root in enumerate(plan["roots"]):
            original = Path(root["original"])
            if not original.exists():
                if db.execute(
                    "SELECT count(*) FROM files WHERE root=? AND deleted<>1 AND NOT (rel='.' AND deleted=2)",
                    (i,),
                ).fetchone()[0]:
                    raise ValueError(
                        "Original root disappeared before per-entry receipts"
                    )
                db.execute(
                    "UPDATE files SET deleted=1 WHERE root=? AND rel='.' AND deleted=2",
                    (i,),
                )
                db.commit()
                continue
            plain_directory(original)
            if info(original)["ino"] != root["identity"]["ino"]:
                raise ValueError("Original root identity changed")
            alias = Path(root["source"])
            if not reparse(alias) or alias.resolve() != Path(root["target"]).resolve():
                raise ValueError("Compatibility alias changed before pruning")
            # Refuse extra/changed source entries BEFORE starting this root.
            for rel, kind, observed, link_target in tree(original):
                row = db.execute(
                    "SELECT * FROM files WHERE root=? AND rel=?", (i, rel)
                ).fetchone()
                if not row or row["kind"] != kind or row["deleted"] == 1:
                    raise ValueError("Unknown source entry; preserve it")
                identity = json.loads(row["identity"])
                if kind == "file" and not same_identity(observed, identity):
                    raise ValueError("Source file changed after offline transfer")
                if kind == "link" and link_target != row["link_target"]:
                    raise ValueError("Original link changed")
            rows = db.execute(
                "SELECT * FROM files WHERE root=? AND deleted<>1 ORDER BY length(rel) DESC,rel DESC",
                (i,),
            )
            for row in rows:
                file = original / row["rel"]
                if row["deleted"] == 2 and not os.path.lexists(long_path(file)):
                    db.execute(
                        "UPDATE files SET deleted=1 WHERE root=? AND rel=?",
                        (i, row["rel"]),
                    )
                    db.commit()
                    continue
                db.execute(
                    "UPDATE files SET deleted=2 WHERE root=? AND rel=?", (i, row["rel"])
                )
                db.commit()  # Intent precedes the handle-bound deletion effect.
                if row["kind"] == "file":
                    delete_verified_file(
                        file, json.loads(row["identity"]), row["sha256"]
                    )
                    deleted += json.loads(row["identity"])["size"]
                elif row["kind"] == "link":
                    if (
                        not reparse(file)
                        or os.readlink(long_path(file)) != row["link_target"]
                    ):
                        raise ValueError("Original reparse entry changed")
                    if json.loads(row["identity"])["attributes"] & 0x10:
                        os.rmdir(long_path(file))
                    else:
                        os.unlink(long_path(file))
                else:
                    if reparse(file):
                        raise ValueError("Original directory became reparse")
                    os.rmdir(long_path(file))  # Empty only; no recursive deletion.
                db.execute(
                    "UPDATE files SET deleted=1 WHERE root=? AND rel=?", (i, row["rel"])
                )
                db.commit()  # Exact partial progress survives interruption.
                count += 1
                if count % 10000 == 0:
                    print(
                        json.dumps(
                            {
                                "phase": "pruning",
                                "entries": count,
                                "logical_deleted_bytes": deleted,
                            }
                        ),
                        flush=True,
                    )
        set_phase(db, "completed")
        after = {drive: shutil.disk_usage(drive).free for drive in before}
        result = {
            "phase": "completed",
            "entries": count,
            "logical_deleted_bytes": deleted,
            "free_before": before,
            "free_after": after,
            "observed_free_gain": {
                drive: after[drive] - before[drive] for drive in before
            },
        }
        write_json(Path(plan["manifest"]).with_suffix(".result.json"), result)
        return result
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "action",
        choices=[
            "plan",
            "stage",
            "final-copy",
            "integrity",
            "switch",
            "rollback",
            "admit-start",
            "accept-started",
            "prune-originals",
            "refresh-stopped",
        ],
    )
    parser.add_argument("--plan", required=True)
    parser.add_argument(
        "--map", action="append", nargs=2, default=[], metavar=("SOURCE", "DESTINATION")
    )
    parser.add_argument("--expected-plan-sha256")
    parser.add_argument("--stopped-proof")
    parser.add_argument("--runtime-proof")
    parser.add_argument("--output")
    args = parser.parse_args()
    if args.action == "plan":
        result = create_plan(args.plan, args.map)
    else:
        plan = load_plan(args.plan, args.expected_plan_sha256)
        if args.action in ("final-copy", "switch", "rollback"):
            require_stopped(args.stopped_proof, plan)
        if args.action == "switch":
            result = switch_roots(plan)
        elif args.action == "rollback":
            result = rollback_roots(plan)
        elif args.action == "integrity":
            result = validate_databases(plan)
        elif args.action == "admit-start":
            result = admit_start(plan)
        elif args.action == "accept-started":
            result = accept_started(plan, args.runtime_proof)
        elif args.action == "prune-originals":
            result = prune_originals(plan)
        elif args.action == "refresh-stopped":
            result = refresh_stopped(plan, args.stopped_proof, args.output)
        else:
            result = copy_roots(plan, offline=args.action == "final-copy")
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
