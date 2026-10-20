"""Offline runtime-root relocation; never changes Hub business state or Git refs.

The operation-local SQLite file is a file-copy manifest, not a Hub state store.
Runtime stop/start and acceptance belong to the operator, not this module.
"""

from __future__ import annotations

import argparse
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import struct
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
    kernel.GetFileInformationByHandleEx.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
    ]
    kernel.GetFileInformationByHandleEx.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.CreateFileW(long_path(file), 0x80, 7, None, 3, 0x02200000, None)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        capacity = 4096
        while capacity <= 1024 * 1024:
            buffer = ctypes.create_string_buffer(capacity)
            if kernel.GetFileInformationByHandleEx(handle, 7, buffer, capacity):
                break
            error = ctypes.get_last_error()
            if error == 38:
                return []
            if error not in (122, 234):
                raise ctypes.WinError(error)
            capacity *= 2
        else:
            raise ValueError("File stream metadata exceeds the explicit bound")
        streams = []
        offset = 0
        while True:
            following, length, size, _allocated = struct.unpack_from(
                "<IIqq", buffer.raw, offset
            )
            if length % 2 or offset + 24 + length > capacity:
                raise ValueError("Malformed file stream metadata")
            name = buffer.raw[offset + 24 : offset + 24 + length].decode("utf-16le")
            if name.endswith(":$DATA") and name != "::$DATA":
                streams.append((name, size))
            if not following:
                return sorted(streams)
            if (
                following < 24 + length
                or following % 8
                or offset + following >= capacity
            ):
                raise ValueError("Malformed next file stream metadata offset")
            offset += following
    finally:
        kernel.CloseHandle(handle)


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


def private_root_sddl():
    """Read our token SID without launching whoami or changing privileges."""
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    advapi.OpenProcessToken.argtypes = [
        wintypes.HANDLE,
        wintypes.DWORD,
        ctypes.c_void_p,
    ]
    advapi.GetTokenInformation.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.c_void_p,
    ]
    advapi.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    token, text, size = wintypes.HANDLE(), wintypes.LPWSTR(), wintypes.DWORD()
    if not advapi.OpenProcessToken(kernel.GetCurrentProcess(), 8, ctypes.byref(token)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        advapi.GetTokenInformation(token, 1, None, 0, ctypes.byref(size))
        if ctypes.get_last_error() != 122 or not size.value:
            raise ctypes.WinError(ctypes.get_last_error())
        buffer = ctypes.create_string_buffer(size.value)
        if not advapi.GetTokenInformation(token, 1, buffer, size, ctypes.byref(size)):
            raise ctypes.WinError(ctypes.get_last_error())
        sid = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_void_p))[0]
        if not advapi.ConvertSidToStringSidW(sid, ctypes.byref(text)):
            raise ctypes.WinError(ctypes.get_last_error())
        return f"D:P(A;OICI;FA;;;{text.value})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
    finally:
        if text:
            kernel.LocalFree(text)
        kernel.CloseHandle(token)


def root_directory_acl(descriptor):
    import msvcrt

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    advapi.GetSecurityInfo.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        wintypes.DWORD,
        *([ctypes.c_void_p] * 5),
    ]
    advapi.GetSecurityInfo.restype = wintypes.DWORD
    advapi.ConvertSecurityDescriptorToStringSecurityDescriptorW.argtypes = [
        ctypes.c_void_p,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.c_void_p,
        ctypes.c_void_p,
    ]
    sd, text = ctypes.c_void_p(), wintypes.LPWSTR()
    error = advapi.GetSecurityInfo(
        msvcrt.get_osfhandle(descriptor), 1, 4, None, None, None, None, ctypes.byref(sd)
    )
    if error:
        raise ctypes.WinError(error)
    try:
        if not advapi.ConvertSecurityDescriptorToStringSecurityDescriptorW(
            sd, 1, 4, ctypes.byref(text), None
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        return text.value
    finally:
        if text:
            kernel.LocalFree(text)
        kernel.LocalFree(sd)


def private_root_acl_matches(value):
    expected = private_root_sddl()
    prefix, _, aces = value.partition("(")
    # Canonical ACE ordering and the auto-inheritance bookkeeping bits may
    # differ from older icacls output. Protection and the exact three grants may not.
    if not prefix.startswith("D:") or "P" not in prefix[2:]:
        return False
    actual_aces = [x for x in ("(" + aces).split(")") if x]
    expected_aces = [x for x in expected[expected.index("(") :].split(")") if x]
    return len(actual_aces) == len(expected_aces) and set(actual_aces) == set(
        expected_aces
    )


@contextmanager
def held_root_directory(
    path, expected=None, create=False, parent_descriptor=None, delete=True
):
    """FILE_CREATE returns the exact new private directory handle atomically."""
    import msvcrt

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = None
    if create:
        advapi = ctypes.WinDLL("advapi32", use_last_error=True)
        advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
            wintypes.LPCWSTR,
            wintypes.DWORD,
            ctypes.c_void_p,
            ctypes.c_void_p,
        ]
        kernel.LocalFree.argtypes = [ctypes.c_void_p]
        sd = ctypes.c_void_p()
        if not advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(
            private_root_sddl(), 1, ctypes.byref(sd), None
        ):
            raise ctypes.WinError(ctypes.get_last_error())

        class UnicodeString(ctypes.Structure):
            _fields_ = [
                ("length", wintypes.USHORT),
                ("maximum", wintypes.USHORT),
                ("buffer", wintypes.LPWSTR),
            ]

        class ObjectAttributes(ctypes.Structure):
            _fields_ = [
                ("length", wintypes.ULONG),
                ("root", wintypes.HANDLE),
                ("name", ctypes.c_void_p),
                ("flags", wintypes.ULONG),
                ("security", ctypes.c_void_p),
                ("quality", ctypes.c_void_p),
            ]

        class IoStatus(ctypes.Structure):
            _fields_ = [("status", ctypes.c_void_p), ("information", ctypes.c_size_t)]

        native = ctypes.WinDLL("ntdll")
        native.NtCreateFile.argtypes = [
            ctypes.c_void_p,
            wintypes.DWORD,
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_void_p,
            wintypes.ULONG,
            wintypes.ULONG,
            wintypes.ULONG,
            wintypes.ULONG,
            ctypes.c_void_p,
            wintypes.ULONG,
        ]
        native.NtCreateFile.restype = wintypes.LONG
        native.RtlNtStatusToDosError.argtypes = [wintypes.LONG]
        native.RtlNtStatusToDosError.restype = wintypes.ULONG
        name = ctypes.create_unicode_buffer(
            Path(path).name
            if parent_descriptor is not None
            else "\\??\\" + os.path.abspath(path)
        )
        length = len(name.value.encode("utf-16le"))
        string = UnicodeString(length, length + 2, ctypes.cast(name, wintypes.LPWSTR))
        attributes = ObjectAttributes(
            ctypes.sizeof(ObjectAttributes),
            msvcrt.get_osfhandle(parent_descriptor)
            if parent_descriptor is not None
            else None,
            ctypes.addressof(string),
            0x40,
            sd,
            None,
        )
        result, status = wintypes.HANDLE(), IoStatus()
        try:
            # DELETE|READ_CONTROL|SYNCHRONIZE|READ_ATTRIBUTES|LIST_DIRECTORY;
            # share child writes but deny directory deletion; create-only, synchronous,
            # OPEN_REPARSE_POINT. No existing directory can be adopted here.
            code = native.NtCreateFile(
                ctypes.byref(result),
                0x130081,
                ctypes.byref(attributes),
                ctypes.byref(status),
                None,
                0x10,
                3,
                2,
                0x200021,
                None,
                0,
            )
            if code < 0:
                error = ctypes.WinError(native.RtlNtStatusToDosError(code))
                error.ntstatus = code & 0xFFFFFFFF
                raise error
            handle = result.value
        finally:
            kernel.LocalFree(sd)
    else:
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
        handle = kernel.CreateFileW(
            long_path(path),
            0x120081 | (0x10000 if delete else 0),
            3,
            None,
            3,
            0x02200000,
            None,
        )
        if handle == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
    descriptor = None
    try:
        descriptor = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
        handle = None
        observed = os.fstat(descriptor)
        if not stat.S_ISDIR(observed.st_mode) or observed.st_file_attributes & 0x400:
            raise ValueError(
                "Root initialization directory is reparse or not a directory"
            )
        if expected and (str(observed.st_dev), str(observed.st_ino)) != (
            expected["dev"],
            expected["ino"],
        ):
            raise ValueError("Root initialization native directory identity changed")
        yield descriptor
    finally:
        if descriptor is not None:
            os.close(descriptor)
        elif handle is not None:
            kernel.CloseHandle(handle)


def publish_root_directory(descriptor, target, parent_descriptor):
    """Rename the retained exact directory; FALSE replace preserves foreign targets."""
    import msvcrt

    class RenameInfo(ctypes.Structure):
        _fields_ = [
            ("replace", wintypes.DWORD),
            ("root", wintypes.HANDLE),
            ("length", wintypes.DWORD),
            ("name", wintypes.WCHAR * 1),
        ]

    encoded = Path(target).name.encode("utf-16le")
    buffer = ctypes.create_string_buffer(RenameInfo.name.offset + len(encoded))
    value = RenameInfo.from_buffer(buffer)
    value.replace, value.root, value.length = (
        0,
        msvcrt.get_osfhandle(parent_descriptor),
        len(encoded),
    )
    ctypes.memmove(
        ctypes.addressof(buffer) + RenameInfo.name.offset, encoded, len(encoded)
    )

    class IoStatus(ctypes.Structure):
        _fields_ = [("status", ctypes.c_void_p), ("information", ctypes.c_size_t)]

    native = ctypes.WinDLL("ntdll")
    native.NtSetInformationFile.argtypes = [
        wintypes.HANDLE,
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.ULONG,
        ctypes.c_int,
    ]
    native.NtSetInformationFile.restype = wintypes.LONG
    native.RtlNtStatusToDosError.argtypes = [wintypes.LONG]
    native.RtlNtStatusToDosError.restype = wintypes.ULONG
    status = IoStatus()
    code = native.NtSetInformationFile(
        msvcrt.get_osfhandle(descriptor), ctypes.byref(status), buffer, len(buffer), 10
    )
    if code < 0:
        error = ctypes.WinError(native.RtlNtStatusToDosError(code))
        error.ntstatus = code & 0xFFFFFFFF
        raise error


def ensure_plain_parents(directory):
    missing = []
    ancestor = Path(directory)
    while not os.path.lexists(long_path(ancestor)):
        missing.append(ancestor)
        ancestor = ancestor.parent
    plain_directory(ancestor)
    for value in reversed(missing):
        plain_directory(value.parent)
        value.mkdir()
        plain_directory(value)
    return plain_directory(directory)


def ensure_destination(plan, index):
    root = plan["roots"][index]
    target = Path(root["target"])
    marker = target / ".agent-hub-relocation-owner.json"
    expected = {
        "operation": plan["operation"],
        "source": root["source"],
        "target": root["target"],
    }
    receipt_file = (
        Path(plan["manifest"]).parent / f"root-init-{plan['operation']}-{index}.json"
    )
    plain_directory(receipt_file.parent)
    receipt = None
    if os.path.lexists(long_path(receipt_file)):
        if reparse(receipt_file) or named_streams(receipt_file):
            raise ValueError("Root initialization receipt changed")
        receipt = json.loads(receipt_file.read_text(encoding="utf-8"))
        if receipt.get("owner") != expected or receipt.get("index") != index:
            raise ValueError("Root initialization receipt owner changed")
    if os.path.lexists(long_path(marker)):
        plain_directory(target)
        refuse_directory_streams(target)
        if (
            reparse(marker)
            or named_streams(marker)
            or json.loads(marker.read_text(encoding="utf-8")) != expected
        ):
            raise ValueError("Destination owner changed")
        if receipt and (
            not receipt.get("identity")
            or any(
                info(target)[key] != receipt["identity"][key] for key in ("dev", "ino")
            )
        ):
            raise ValueError("Published root initialization identity changed")
        if os.name == "nt":
            with held_root_directory(target, info(target), delete=False) as descriptor:
                if not private_root_acl_matches(root_directory_acl(descriptor)):
                    raise ValueError("Owned destination private ACL changed")
        return
    if os.path.lexists(long_path(target)):
        raise ValueError("Unowned destination appeared")
    if os.name != "nt":
        target.mkdir(parents=True, mode=0o700)
        write_json(marker, expected)
        return
    plain_directory(root["source"])
    refuse_directory_streams(root["source"])
    if any(
        info(root["source"])[key] != root["identity"][key] for key in ("dev", "ino")
    ):
        raise ValueError("Root initialization source identity changed")
    ensure_plain_parents(target.parent)
    stage = target.parent / f".relocation-root-{plan['operation']}-{index}"
    parent_identity = info(target.parent)
    if receipt:
        if receipt.get("stage") != str(stage) or any(
            receipt.get("parent", {}).get(key) != parent_identity[key]
            for key in ("dev", "ino")
        ):
            raise ValueError("Root initialization parent/stage changed")
        if not receipt.get("identity"):
            raise ValueError(
                "Root initialization has no durable created identity; preserve"
            )
    else:
        if os.path.lexists(long_path(stage)):
            raise ValueError("Unowned root initialization stage appeared")
        receipt = {
            "owner": expected,
            "index": index,
            "stage": str(stage),
            "parent": parent_identity,
            "phase": "intent",
        }
        write_json(receipt_file, receipt)
    try:
        with (
            held_root_directory(
                target.parent, parent_identity, delete=False
            ) as parent_descriptor,
            held_root_directory(
                stage,
                receipt.get("identity"),
                create=not receipt.get("identity"),
                parent_descriptor=parent_descriptor,
            ) as descriptor,
        ):
            observed = os.fstat(descriptor)
            receipt.update(
                identity={"dev": str(observed.st_dev), "ino": str(observed.st_ino)},
                phase="created",
            )
            write_json(
                receipt_file, receipt
            )  # Created native identity precedes marker/publication.
            if not private_root_acl_matches(root_directory_acl(descriptor)):
                raise ValueError("Root initialization private ACL changed")
            refuse_directory_streams(stage)
            stage_marker = stage / marker.name
            children = {p.name for p in stage.iterdir()}
            if children - {marker.name}:
                raise ValueError("Unknown root initialization child; preserve")
            if marker.name in children:
                if (
                    reparse(stage_marker)
                    or named_streams(stage_marker)
                    or json.loads(stage_marker.read_text(encoding="utf-8")) != expected
                ):
                    raise ValueError("Root initialization marker changed")
            else:
                write_json(stage_marker, expected)
            receipt["phase"] = "marker_ready"
            write_json(receipt_file, receipt)
            plain_directory(target.parent)
            if any(
                info(target.parent)[key] != receipt["parent"][key]
                for key in ("dev", "ino")
            ):
                raise ValueError(
                    "Root initialization parent changed before publication"
                )
            refuse_directory_streams(stage)
            if (
                {p.name for p in stage.iterdir()} != {marker.name}
                or reparse(stage_marker)
                or named_streams(stage_marker)
                or json.loads(stage_marker.read_text(encoding="utf-8")) != expected
            ):
                raise ValueError(
                    "Root initialization marker/children changed before publication"
                )
            publish_root_directory(descriptor, target, parent_descriptor)
            receipt["phase"] = "published"
            write_json(receipt_file, receipt)
    except BaseException as error:
        receipt.update(
            phase="failed",
            error={
                "type": type(error).__name__,
                "message": str(error),
                "winerror": getattr(error, "winerror", None),
                "errno": getattr(error, "errno", None),
                "ntstatus": getattr(error, "ntstatus", None),
                "returncode": getattr(error, "returncode", None),
                "stdout_hex": (getattr(error, "stdout", None) or b"").hex()
                if isinstance(getattr(error, "stdout", None), bytes)
                else getattr(error, "stdout", None),
                "stderr_hex": (getattr(error, "stderr", None) or b"").hex()
                if isinstance(getattr(error, "stderr", None), bytes)
                else getattr(error, "stderr", None),
            },
        )
        write_json(receipt_file, receipt)
        raise


def directory_chain(directory):
    value = plain_directory(directory)
    return [
        {"path": str(p), "dev": info(p)["dev"], "ino": info(p)["ino"]}
        for p in [value, *value.parents]
    ]


def unowned_root_source_boundary(plan, index):
    if index < 0 or index >= len(plan["roots"]):
        raise ValueError("Invalid explicit root index")
    root = plan["roots"][index]
    source = plain_directory(root["source"])
    if any(info(source)[k] != root["identity"][k] for k in ("dev", "ino")):
        raise ValueError("Unowned-root custody source identity changed")
    db = sqlite3.connect(Path(plan["manifest"]).as_uri() + "?mode=ro", uri=True)
    try:
        if phase(db) not in ("planned", "staged"):
            raise ValueError("Unowned-root custody is limited to pre-copy recovery")
    finally:
        db.close()
    return source


def unowned_root_snapshot(plan, index, quarantine):
    """Explicit operator custody only; never grants ownership to an unmarked root."""
    source = unowned_root_source_boundary(plan, index)
    root = plan["roots"][index]
    target = plain_directory(root["target"])
    quarantine = Path(os.path.abspath(quarantine))
    target_chain = directory_chain(target.parent)
    quarantine_chain = directory_chain(quarantine.parent)
    if info(target)["dev"] != info(quarantine.parent)["dev"]:
        raise ValueError("Unowned-root custody must stay on the same volume")
    if any(
        quarantine == Path(r[k]) or inside(r[k], quarantine)
        for r in plan["roots"]
        for k in ("source", "target", "original")
    ):
        raise ValueError("Unowned-root evidence must stay outside all transfer roots")
    if list(target.iterdir()):
        raise ValueError(
            "Unowned-root custody requires exact empty directory; preserve"
        )
    refuse_directory_streams(target)
    if os.path.lexists(long_path(quarantine)):
        raise ValueError("Unowned-root quarantine already exists; preserve")
    return {
        "operation": plan["operation"],
        "index": index,
        "source": str(source),
        "target": str(target),
        "quarantine": str(quarantine),
        "identity": {k: info(target)[k] for k in ("dev", "ino")},
        "target_parent_chain": target_chain,
        "quarantine_parent_chain": quarantine_chain,
        "ownership": "UNPROVEN; preservation custody, not copied/adopted source",
        "empty": True,
        "named_streams": [],
    }


def preview_unowned_root(plan_file, plan_sha256, index, quarantine, output):
    plan = load_plan(plan_file, plan_sha256)
    value = unowned_root_snapshot(plan, index, quarantine)
    value.update(plan_sha256=plan_sha256, plan=str(Path(plan_file).absolute()))
    if os.path.lexists(long_path(output)):
        raise ValueError("Unowned-root preview already exists")
    write_json(output, value)
    return value


def require_no_copy_workers(operation, proof_file=None, proof_sha256=None):
    # Reuse the existing process inventory/custody owner. Missing Python argv
    # needs an independently reviewed, fresh exact foreign identity classification.
    import runtime_relocation_process as custody

    classified = {}
    if proof_file:
        if digest(proof_file) != proof_sha256:
            raise ValueError("Exact copy-worker boundary digest changed")
        proof = json.loads(Path(proof_file).read_text(encoding="utf-8"))
        if (
            proof.get("operation") != operation
            or not 0 <= time.time() - proof.get("checked_at", 0) <= 60
        ):
            raise ValueError(
                "Fresh operation-bound copy-worker classification required"
            )
        entries = proof.get("foreign_unknown_python", [])
        classified = {r["pid"]: r for r in entries}
        if len(classified) != len(entries):
            raise ValueError("Duplicate foreign Python classification")
    for row in custody.process_snapshot():
        if row["pid"] == os.getpid() or row["name"].lower() not in (
            "python.exe",
            "pythonw.exe",
        ):
            continue
        command = str(row.get("command") or "").lower()
        if not command:
            allowed = classified.get(row["pid"])
            if (
                not allowed
                or not allowed.get("native_creation")
                or row["parent"] != allowed.get("parent")
                or int(row["created"]) // 10 != int(allowed["created"]) // 10
            ):
                raise ValueError(
                    "Unknown Python identity prevents copy-worker absence proof"
                )
            evidence = allowed.get("foreign_evidence", {})
            if not evidence.get("path") or digest(evidence["path"]) != evidence.get(
                "sha256"
            ):
                raise ValueError(
                    "Exact foreign Python classification evidence required"
                )
            held = custody.HeldProcess(allowed, terminate=False)
            held.close()
        elif "runtime_relocation_cutover.py" in command or (
            "runtime_relocation.py" in command
            and re.search(r'(?:^|\s|")(?:stage|final-copy)(?:\s|$|")', command)
        ):
            raise ValueError("Relocation copy worker still exists; custody refused")
    return {
        "checked_at": time.time(),
        "copy_workers": 0,
        "classification_sha256": proof_sha256 if proof_file else None,
    }


def custody_unowned_root(
    plan_file,
    plan_sha256,
    preview_file,
    preview_sha256,
    copy_proof=None,
    copy_proof_sha256=None,
):
    plan = load_plan(plan_file, plan_sha256)
    if digest(preview_file) != preview_sha256:
        raise ValueError("Exact unowned-root preview digest changed")
    preview = json.loads(Path(preview_file).read_text(encoding="utf-8"))
    if (
        preview.get("plan_sha256") != plan_sha256
        or preview.get("operation") != plan["operation"]
    ):
        raise ValueError("Unowned-root custody plan changed")
    index = preview["index"]
    if index < 0 or index >= len(plan["roots"]):
        raise ValueError("Invalid explicit root custody index")
    root = plan["roots"][index]
    if (
        preview.get("target") != root["target"]
        or preview.get("source") != root["source"]
    ):
        raise ValueError("Unowned-root custody mapping changed")
    unowned_root_source_boundary(plan, index)
    target, quarantine = Path(root["target"]), Path(preview["quarantine"])
    receipt_file = (
        Path(plan["manifest"]).parent
        / f"unowned-root-custody-{plan['operation']}-{index}.json"
    )
    plain_directory(receipt_file.parent)
    receipt = None
    if os.path.lexists(long_path(receipt_file)):
        if reparse(receipt_file) or named_streams(receipt_file):
            raise ValueError("Unowned-root custody receipt changed")
        receipt = json.loads(receipt_file.read_text(encoding="utf-8"))
        if (
            receipt.get("preview_sha256") != preview_sha256
            or receipt.get("operation") != plan["operation"]
            or receipt.get("identity") != preview["identity"]
            or not receipt.get("attempts")
        ):
            raise ValueError("Unowned-root custody original preview changed")
    if (
        directory_chain(target.parent) != preview["target_parent_chain"]
        or directory_chain(quarantine.parent) != preview["quarantine_parent_chain"]
    ):
        raise ValueError("Unowned-root custody parent ancestry changed")
    boundary = require_no_copy_workers(plan["operation"], copy_proof, copy_proof_sha256)
    if receipt and not os.path.lexists(long_path(target)):
        with held_root_directory(quarantine, preview["identity"]) as held:
            if list(quarantine.iterdir()):
                raise ValueError("Retained unowned-root quarantine is no longer empty")
            refuse_directory_streams(quarantine)
            receipt["attempts"][-1].update(phase="completed", recovered_readback=True)
            receipt.update(phase="completed", resumed=True, copy_boundary=boundary)
            write_json(receipt_file, receipt)
            return receipt
    current = unowned_root_snapshot(plan, index, quarantine)
    expected = {k: v for k, v in preview.items() if k not in ("plan", "plan_sha256")}
    if current != expected:
        raise ValueError("Unowned-root exact preview changed; preserve")
    with (
        held_root_directory(
            target.parent, preview["target_parent_chain"][0], delete=False
        ),
        held_root_directory(
            quarantine.parent, preview["quarantine_parent_chain"][0], delete=False
        ) as destination_parent,
        held_root_directory(target, preview["identity"]) as held,
    ):
        if list(target.iterdir()):
            raise ValueError("Unowned root changed before custody intent")
        refuse_directory_streams(target)
        if receipt is None:
            receipt = {
                "operation": plan["operation"],
                "preview_sha256": preview_sha256,
                "ownership": "UNPROVEN",
                "identity": preview["identity"],
                "target": str(target),
                "quarantine": str(quarantine),
                "attempts": [],
            }
        attempt = {
            "phase": "intent",
            "started_at": time.time(),
            "copy_boundary": boundary,
        }
        receipt["attempts"].append(attempt)
        receipt["phase"] = "intent"
        write_json(receipt_file, receipt)
        try:
            if (
                time.time() - boundary["checked_at"] > 60
                or directory_chain(target.parent) != preview["target_parent_chain"]
                or directory_chain(quarantine.parent)
                != preview["quarantine_parent_chain"]
                or list(target.iterdir())
            ):
                raise ValueError("Unowned-root custody boundary changed after intent")
            refuse_directory_streams(target)
            # Same retained object, same volume, exact held destination parent,
            # native FALSE replace. It never becomes an owned transfer entry.
            publish_root_directory(held, quarantine, destination_parent)
            if (
                os.path.lexists(long_path(target))
                or list(quarantine.iterdir())
                or any(
                    info(quarantine)[k] != preview["identity"][k]
                    for k in ("dev", "ino")
                )
            ):
                raise ValueError("Unowned-root custody readback differs; preserve both")
            refuse_directory_streams(quarantine)
            attempt.update(phase="completed", completed_at=time.time())
            receipt.update(phase="completed", resumed=False)
            write_json(receipt_file, receipt)
            return receipt
        except BaseException as error:
            attempt.update(
                phase="failed",
                error_type=type(error).__name__,
                error=str(error),
                winerror=getattr(error, "winerror", None),
                ntstatus=getattr(error, "ntstatus", None),
            )
            receipt["phase"] = "failed"
            write_json(receipt_file, receipt)
            raise


def copy_temporary(target, operation, hardlink=False):
    prefix = ".relocation-hardlink-" if hardlink else ".relocation-"
    name = target.name + prefix + operation + ".tmp"
    # Extended paths bypass MAX_PATH, not NTFS's 255 UTF-16-unit leaf bound.
    # Retain existing operation names where they fit so earlier copies resume.
    if len(name.encode("utf-16le", errors="surrogatepass")) // 2 > 255:
        leaf_hash = hashlib.sha256(
            target.name.encode("utf-16le", errors="surrogatepass")
        ).hexdigest()
        name = prefix + operation + "-" + leaf_hash + ".tmp"
    return target.with_name(name)


def copy_file(source, target, operation):
    temporary = copy_temporary(target, operation)
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


def refuse_directory_streams(directory):
    # Directory streams are user data too. Until their transfer has a supported
    # atomic owner, mkdir/rmdir must never silently discard them.
    if named_streams(directory):
        raise ValueError(f"Unaccounted directory data streams: {directory}")


def relink_owned_file(canonical, target, operation, target_hash):
    temporary = copy_temporary(target, operation, hardlink=True)
    canonical_identity = info(canonical)
    if os.path.lexists(long_path(temporary)):
        if reparse(temporary) or any(
            info(temporary)[k] != canonical_identity[k] for k in ("dev", "ino")
        ):
            raise ValueError("Unresolved hardlink temporary identity")
    else:
        os.link(long_path(canonical), long_path(temporary))
    if os.path.lexists(long_path(target)):
        if reparse(target) or content_digest(target) != target_hash:
            raise ValueError("Owned hardlink destination changed")
        if info(target)["attributes"] & 1:
            delete_verified_file(target, info(target), target_hash)
    os.replace(long_path(temporary), long_path(target))


def copy_regular_file(source, target, identity, old, linked, operation):
    if os.path.exists(long_path(target)) and not old:
        raise ValueError(f"Unowned file at destination: {target}")
    source_hash = target_hash = None
    if os.path.lexists(long_path(target)):
        if reparse(target):
            raise ValueError("Destination file became a reparse point")
        source_hash, target_hash = content_digest(source), content_digest(target)
        if target_hash not in (old["sha256"], source_hash):
            raise ValueError("Owned destination contents changed")
    key = (identity["dev"], identity["ino"])
    added = 0
    if key in linked:
        canonical = linked[key]
        source_hash = source_hash or content_digest(source)
        if content_digest(canonical) != source_hash:
            raise ValueError("Source hardlink contents changed")
        if not os.path.exists(long_path(target)) or any(
            info(target)[k] != info(canonical)[k] for k in ("dev", "ino")
        ):
            relink_owned_file(canonical, target, operation, target_hash)
        sha = source_hash
    elif source_hash and source_hash == target_hash:
        sha = source_hash
    else:
        sha = copy_file(source, target, operation)
        added = identity["size"]
    observed = info(source)
    if not same_identity(identity, observed) or identity["links"] != observed["links"]:
        raise ValueError(f"Source changed during copy: {source}")
    # Single-link files cannot have a later member of their group. Keeping only
    # actual hardlink groups also bounds memory on million-file dependency trees.
    if identity["links"] > 1:
        linked[key] = target
    return sha, added


def quarantine_temporary(plan, index, rel, expected_identity, expected_sha):
    """Preserve one explicitly inspected interrupted copy after its worker exits.

    The installer must bind worker absence separately. This action neither stops
    a process nor admits another writer; unknown temporaries are never inferred.
    """
    if (
        not isinstance(index, int)
        or not 0 <= index < len(plan["roots"])
        or len(expected_sha) != 64
        or any(c not in "0123456789abcdef" for c in expected_sha)
    ):
        raise ValueError("Exact temporary root and content digest required")
    root = plan["roots"][index]
    target = Path(root["target"]) / rel
    if not inside(root["target"], target) or Path(rel).is_absolute():
        raise ValueError("Temporary path escaped its selected root")
    plain_directory(root["target"])
    ensure_destination(plan, index)
    plain_directory(target.parent)
    temporary = copy_temporary(target, plan["operation"])
    db = connect(plan["manifest"])
    try:
        if phase(db) not in ("planned", "staged"):
            raise ValueError("Temporary recovery is only a paused preparation action")
        row = db.execute(
            "SELECT kind FROM files WHERE root=? AND rel=?", (index, rel)
        ).fetchone()
        if not row or row["kind"] != "file":
            raise ValueError("Unknown copy intent; temporary preserved")
        quarantine = (
            Path(plan["manifest"]).parent
            / ("incomplete-copy-" + plan["operation"])
            / str(index)
            / expected_sha
            / rel
        )
        # Custody retries reject substituted ancestors before accepting bytes.
        ancestor = quarantine.parent
        while not ancestor.exists():
            ancestor = ancestor.parent
        plain_directory(ancestor)
        receipt_rel = "<incomplete-copy>/" + expected_sha + "/" + rel
        previous = db.execute(
            "SELECT * FROM departed WHERE root=? AND rel=?", (index, receipt_rel)
        ).fetchone()
        if previous:
            if (
                previous["kind"] != "incomplete-copy"
                or previous["identity"] != json.dumps(expected_identity)
                or previous["sha256"] != expected_sha
                or previous["quarantine"] != str(quarantine)
            ):
                raise ValueError("Temporary recovery receipt changed")
            if not os.path.lexists(long_path(temporary)):
                if (
                    not os.path.lexists(long_path(quarantine))
                    or reparse(quarantine)
                    or not same_identity(expected_identity, info(quarantine))
                    or content_digest(quarantine) != expected_sha
                ):
                    raise ValueError("Interrupted-copy evidence changed")
                return {"quarantine": str(quarantine), "resumed": True}
        if (
            reparse(temporary)
            or not stat.S_ISREG(info(temporary)["mode"])
            or info(temporary)["links"] != 1
            or not same_identity(expected_identity, info(temporary))
            or content_digest(temporary) != expected_sha
        ):
            raise ValueError("Explicit temporary identity/hash changed; preserved")
        # An existing quarantine is never overwritten, even if its bytes match.
        if os.path.lexists(long_path(quarantine)):
            raise ValueError("Unaccounted interrupted-copy evidence exists")
        if quarantine.drive.casefold() != target.drive.casefold():
            raise ValueError("Temporary quarantine must stay on the destination volume")
        quarantine.parent.mkdir(parents=True, exist_ok=True)
        plain_directory(quarantine.parent)
        db.execute(
            "INSERT OR IGNORE INTO departed VALUES(?,?,?,?,?,?)",
            (
                index,
                receipt_rel,
                "incomplete-copy",
                json.dumps(expected_identity),
                expected_sha,
                str(quarantine),
            ),
        )
        db.commit()  # Evidence custody precedes the same-volume rename.
        if (
            not same_identity(expected_identity, info(temporary))
            or content_digest(temporary) != expected_sha
        ):
            raise ValueError("Temporary changed before quarantine")
        os.rename(long_path(temporary), long_path(quarantine))
        if (
            not same_identity(expected_identity, info(quarantine))
            or content_digest(quarantine) != expected_sha
        ):
            raise ValueError("Quarantined evidence differs")
        return {"quarantine": str(quarantine), "resumed": False}
    finally:
        db.close()


def validate_workers(workers):
    if (
        isinstance(workers, bool)
        or not isinstance(workers, int)
        or not 1 <= workers <= 8
    ):
        raise ValueError("Copy workers must be an integer from 1 to 8")
    return workers


def copy_roots(plan, offline=False, workers=1):
    validate_workers(workers)
    db = connect(plan["manifest"])
    pool = ThreadPoolExecutor(max_workers=workers) if workers > 1 else None
    pending = deque()
    try:
        if phase(db) not in ("planned", "staged", "copied_offline"):
            raise ValueError("Copy cannot run after verification/switch")
        generation = time.time_ns()
        count = copied_bytes = 0
        linked = {}

        def record(entry, sha, copied, added=0):
            nonlocal count, copied_bytes
            i, rel, kind, identity, link_target = entry
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
            copied_bytes += added
            if count % 1000 == 0:
                db.commit()
            if count % 10000 == 0:
                print(
                    json.dumps(
                        {
                            "phase": "offline-copy" if offline else "stage",
                            "entries": count,
                            "copied_bytes": copied_bytes,
                            "workers": workers,
                        }
                    ),
                    flush=True,
                )

        def drain_one():
            future, entry = pending.popleft()
            sha, added = future.result()
            record(entry, sha, 1, added)

        def drain_all():
            while pending:
                drain_one()

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
                entry = (i, rel, kind, identity, link_target)
                if kind == "directory":
                    refuse_directory_streams(source)
                    os.makedirs(long_path(target), exist_ok=True)
                    if reparse(target):
                        raise ValueError("Destination directory became reparse")
                    refuse_directory_streams(target)
                    sha, copied = None, 1
                elif kind == "link":
                    refuse_directory_streams(source)
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
                    or source.name.lower() == ".lock"
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
                    if pool and identity["links"] == 1:
                        future = pool.submit(
                            copy_regular_file,
                            source,
                            target,
                            identity,
                            dict(old) if old else None,
                            {},
                            plan["operation"],
                        )
                        pending.append((future, entry))
                        if len(pending) >= workers * 2:
                            drain_one()
                        continue
                    # Hardlink groups retain their original serialized owner;
                    # independent worker effects finish before sharing a group.
                    drain_all()
                    sha, added = copy_regular_file(
                        source, target, identity, old, linked, plan["operation"]
                    )
                    record(entry, sha, 1, added)
                    continue
                record(entry, sha, copied)
        drain_all()
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
        if pool:
            # Never report failure/return while a queued copy can still mutate
            # the target. No worker writes the manifest or authoritative state.
            pool.shutdown(wait=True, cancel_futures=True)
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
        verify_directory_stream_absence(plan, db)
        set_phase(db, "verified")
    finally:
        db.close()


def verify_directory_stream_absence(plan, db, switch_recovery=False):
    for row in db.execute(
        "SELECT root,rel,kind,link_target FROM files WHERE kind IN ('directory','link') ORDER BY root,length(rel),rel"
    ):
        root = plan["roots"][row["root"]]
        source = Path(root["source"])
        original = Path(root["original"])
        if switch_recovery and original.exists():
            if info(original)["ino"] != root["identity"]["ino"]:
                raise ValueError("Original directory identity changed")
            source = original
        for directory in (source / row["rel"], Path(root["target"]) / row["rel"]):
            if row["kind"] == "directory" and reparse(directory):
                raise ValueError("Verified directory became a reparse point")
            if row["kind"] == "link" and (
                not reparse(directory)
                or os.readlink(long_path(directory)) != row["link_target"]
            ):
                raise ValueError("Verified reparse target changed")
            refuse_directory_streams(directory)


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
        verify_directory_stream_absence(plan, db, switch_recovery=True)
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


def delete_verified_file(
    file, expected, expected_hash, directory=False, link_target=None
):
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
        long_path(file),
        0x10000 | 0x80 | 1,
        1,
        None,
        3,
        0x02200000 if directory else 0x00200000,
        None,
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
            or (not directory and link_target is None and s.st_size != expected["size"])
            or bool(getattr(s, "st_file_attributes", 0) & 0x400)
            != (link_target is not None)
        ):
            raise ValueError("Source deletion file identity changed")
        if link_target is not None:
            if os.readlink(long_path(file)) != link_target:
                raise ValueError("Original reparse target changed")
            refuse_directory_streams(file)
        elif directory:
            refuse_directory_streams(file)
        else:
            h = hashlib.sha256()
            while chunk := os.read(descriptor, 4 * 1024 * 1024):
                h.update(chunk)
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
                if kind in ("directory", "link"):
                    refuse_directory_streams(original / rel)
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
                    delete_verified_file(
                        file,
                        json.loads(row["identity"]),
                        None,
                        directory=bool(
                            json.loads(row["identity"])["attributes"] & 0x10
                        ),
                        link_target=row["link_target"],
                    )
                else:
                    if reparse(file):
                        raise ValueError("Original directory became reparse")
                    delete_verified_file(
                        file, json.loads(row["identity"]), None, directory=True
                    )
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
            "preview-unowned-root",
            "custody-unowned-root",
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
    parser.add_argument("--root-index", type=int)
    parser.add_argument("--quarantine")
    parser.add_argument("--preview")
    parser.add_argument("--expected-preview-sha256")
    parser.add_argument("--copy-worker-proof")
    parser.add_argument("--expected-copy-worker-proof-sha256")
    parser.add_argument("--workers", type=int, default=1, choices=range(1, 9))
    args = parser.parse_args()
    if args.action == "plan":
        result = create_plan(args.plan, args.map)
    else:
        plan = load_plan(args.plan, args.expected_plan_sha256)
        if args.action in ("final-copy", "switch", "rollback"):
            require_stopped(args.stopped_proof, plan)
        if args.action == "preview-unowned-root":
            result = preview_unowned_root(
                args.plan,
                args.expected_plan_sha256,
                args.root_index,
                args.quarantine,
                args.output,
            )
        elif args.action == "custody-unowned-root":
            result = custody_unowned_root(
                args.plan,
                args.expected_plan_sha256,
                args.preview,
                args.expected_preview_sha256,
                args.copy_worker_proof,
                args.expected_copy_worker_proof_sha256,
            )
        elif args.action == "switch":
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
            result = copy_roots(
                plan, offline=args.action == "final-copy", workers=args.workers
            )
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
