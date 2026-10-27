"""Offline package checkpoint for one owner-prepared release; never publishes."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile

from build_package import build_package, regular, verified_runtime_payload
from install_release import REPOSITORY, extract_verified, file_hash, semantic_fields, valid_artifact_version, windows_filesystem_path

ROOT = Path(__file__).resolve().parent
ASSETS = ("AgentHub-win32-x64.zip", "AgentHub-win32-x64.zip.json", "install_release.py", "SHA256SUMS")
RECEIPT_FIELDS = {"schema", "phase", "operationId", "generation", "sourceCommit", "releaseId", "version",
                  "releaseRoot", "manifestSha256"}
TOOLS = ("build_release.py", "build_package.py", "install_release.py", "install-prepared.mjs", "config.example.json")


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _json_bytes(value: dict) -> bytes:
    return (json.dumps(value, sort_keys=True, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _plain_chain(path: Path) -> Path:
    path = path.absolute()
    for part in [*reversed(path.parents), path]:
        if part.is_symlink() or (hasattr(part, "is_junction") and part.is_junction()):
            raise ValueError("Reparse checkpoint path refused")
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        if getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0):
            raise ValueError("Reparse checkpoint path refused")
    return path.resolve(strict=False)


def _read_json(path: Path, max_bytes: int = 1024 * 1024) -> tuple[bytes, dict]:
    _plain_chain(path)
    if path.stat().st_size > max_bytes:
        raise ValueError("Checkpoint JSON exceeds its size bound")
    raw = regular(path)
    value = json.loads(raw.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("Checkpoint JSON must be an object")
    return raw, value


def _write(path: Path, data: bytes) -> None:
    with path.open("xb") as target:
        target.write(data)
        target.flush()
        os.fsync(target.fileno())


def _write_json(path: Path, value: dict) -> None:
    _write(path, _json_bytes(value))


def _inputs(receipt_path: Path, receipt_sha256: str, source_commit: str, version: str,
            license_file: Path, notices_file: Path) -> tuple[dict, Path, bytes]:
    raw, receipt = _read_json(receipt_path)
    if not re.fullmatch(r"[0-9a-f]{64}", receipt_sha256) or _sha(raw) != receipt_sha256:
        raise ValueError("Prepared receipt SHA-256 mismatch")
    if (set(receipt) != RECEIPT_FIELDS or type(receipt.get("schema")) is not int
            or receipt["schema"] != 1 or receipt.get("phase") != "PREPARED"):
        raise ValueError("Unsupported owner PREPARED receipt")
    if (not re.fullmatch(r"[0-9a-f]{40}", source_commit) or receipt["sourceCommit"] != source_commit
            or not valid_artifact_version(version) or receipt["version"] != version
            or not isinstance(receipt["operationId"], str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", receipt["operationId"])
            or type(receipt["generation"]) is not int or receipt["generation"] < 1):
        raise ValueError("Prepared receipt source/version/operation identity mismatch")
    if not isinstance(receipt["releaseRoot"], str) or not Path(receipt["releaseRoot"]).is_absolute():
        raise ValueError("Prepared releaseRoot must be absolute")
    prepared = _plain_chain(Path(receipt["releaseRoot"]))
    if not prepared.is_dir():
        raise ValueError("Prepared runtime directory missing")
    original, manifest, _payload = verified_runtime_payload(prepared, source_commit)
    if (receipt["manifestSha256"] != _sha(original) or manifest.get("releaseId") != receipt["releaseId"]
            or manifest.get("releaseVersion", manifest.get("version")) != version):
        raise ValueError("Prepared receipt/manifest identity mismatch")
    _plain_chain(license_file)
    _plain_chain(notices_file)
    inputs = {"repository": REPOSITORY, "operationId": receipt["operationId"], "generation": receipt["generation"],
              **semantic_fields(manifest),
              "sourceCommit": source_commit, "version": version, "releaseId": receipt["releaseId"],
              "preparedReceiptSha256": receipt_sha256, "preparedManifestSha256": _sha(original),
              "licenseSha256": _sha(regular(license_file)), "noticesSha256": _sha(regular(notices_file)),
              "tools": {name: _sha(regular(ROOT / name)) for name in TOOLS}}
    return inputs, prepared, raw


def _verify_assets(namespace: Path, inputs: dict) -> list[dict]:
    assets = _plain_chain(namespace / "assets")
    if not assets.is_dir() or set(p.name for p in assets.iterdir()) != set(ASSETS):
        raise ValueError("Unexpected or incomplete package assets")
    rows = []
    for name in ASSETS:
        item = _plain_chain(assets / name)
        if not stat.S_ISREG(item.lstat().st_mode):
            raise ValueError("Package asset is not a regular file")
        rows.append({"name": name, "bytes": item.stat().st_size, "sha256": file_hash(item)})
    archive, descriptor_file, installer, checksums = [assets / name for name in ASSETS]
    _raw, descriptor = _read_json(descriptor_file)
    if (descriptor.get("schema") != 1 or descriptor.get("repository") != REPOSITORY
            or descriptor.get("platform") != "win32-x64" or descriptor.get("asset") != ASSETS[0]
            or descriptor.get("version") != inputs["version"] or descriptor.get("sourceCommit") != inputs["sourceCommit"]
            or descriptor.get("releaseId") != inputs["releaseId"] or descriptor.get("bytes") != rows[0]["bytes"]
            or descriptor.get("sha256") != rows[0]["sha256"] or descriptor.get("publicApproval") is not False):
        raise ValueError("Package descriptor identity mismatch")
    if semantic_fields(descriptor, descriptor=True) != {k: inputs[k] for k in ("versionScheme", "publicVersion", "buildNumber") if k in inputs}:
        raise ValueError("Package semantic identity mismatch")
    if file_hash(installer) != inputs["tools"]["install_release.py"]:
        raise ValueError("Versioned installer integrity mismatch")
    expected_sums = "".join(f"{row['sha256']}  {row['name']}\n" for row in rows[:3]).encode("ascii")
    if regular(checksums) != expected_sums:
        raise ValueError("Package checksums mismatch")
    # Reuse the recipient's actual archive/inventory verifier. No child executes.
    scratch = Path(tempfile.mkdtemp(prefix=".verify-", dir=windows_filesystem_path(namespace)))
    owned = scratch.resolve(strict=True)
    created = scratch.stat()
    owned_identity = (created.st_dev, created.st_ino, getattr(created, "st_birthtime_ns", None))
    try:
        extracted = scratch / "package"
        inner = extract_verified(archive, rows[0]["sha256"], extracted)
        if (_sha(regular(extracted / "package-manifest.json")) != descriptor.get("packageManifestSha256")
                or inner.get("preparedManifestSha256") != inputs["preparedManifestSha256"]
                or inner.get("sourceCommit") != inputs["sourceCommit"] or inner.get("version") != inputs["version"]
                or inner.get("releaseId") != inputs["releaseId"]
                or file_hash(extracted / "LICENSE") != inputs["licenseSha256"]
                or file_hash(extracted / "THIRD_PARTY_NOTICES.md") != inputs["noticesSha256"]):
            raise ValueError("Inner package/input identity mismatch")
        _data, manifest = _read_json(extracted / "runtime/runtime-manifest.json", max_bytes=8 * 1024 * 1024)
        if ("sourceRoot" in manifest or manifest.get("publicationRevision") != inputs["sourceCommit"]
                or manifest.get("distributionSource", {}).get("preparedManifestSha256") != inputs["preparedManifestSha256"]):
            raise ValueError("Public runtime manifest identity mismatch")
    finally:
        _plain_chain(scratch)
        current = scratch.stat()
        if (scratch.resolve(strict=True) != owned
                or (current.st_dev, current.st_ino, getattr(current, "st_birthtime_ns", None)) != owned_identity):
            raise RuntimeError("Verification scratch ownership changed; files preserved")
        shutil.rmtree(scratch)
    return rows


def package_release(receipt_path: Path, receipt_sha256: str, source_commit: str, version: str,
                    license_file: Path, notices_file: Path, output_root: Path) -> dict:
    """Return the exact saved PACKAGED result on retry; refuse incomplete work."""
    inputs, prepared, receipt = _inputs(receipt_path, receipt_sha256, source_commit, version, license_file, notices_file)
    identity = _sha(_json_bytes(inputs))
    namespace = _plain_chain(output_root / version)
    for source in [prepared, ROOT, _plain_chain(receipt_path), _plain_chain(license_file), _plain_chain(notices_file)]:
        if namespace == source or namespace.is_relative_to(source) or source.is_relative_to(namespace):
            raise ValueError("Package output overlaps an immutable input")
    intent = {"schema": 1, "phase": "PACKAGING", "inputIdentity": identity, "inputs": inputs}
    if namespace.exists():
        if not namespace.is_dir() or set(p.name for p in namespace.iterdir()) != {
                "intent.json", "prepared-receipt.json", "assets", "result.json"}:
            raise ValueError("Incomplete/unknown or foreign package checkpoint preserved; read original outcome")
        if _read_json(namespace / "intent.json")[1] != intent or regular(namespace / "prepared-receipt.json") != receipt:
            raise ValueError("Package checkpoint inputs changed")
        saved = _read_json(namespace / "result.json")[1]
        expected = {"schema": 1, "phase": "PACKAGED", "inputIdentity": identity, "inputs": inputs,
                    "assets": _verify_assets(namespace, inputs)}
        if saved != expected:
            raise ValueError("Saved package result integrity mismatch")
        return saved
    namespace.mkdir(mode=0o700, parents=True, exist_ok=False)
    try:
        # Exclusive durable intent precedes every artifact; partials stay UNKNOWN.
        _write_json(namespace / "intent.json", intent)
        _write(namespace / "prepared-receipt.json", receipt)
        assets = namespace / "assets"
        assets.mkdir(mode=0o700)
        build_package(prepared, license_file, notices_file, source_commit, assets / ASSETS[0])
        _write(assets / ASSETS[2], regular(ROOT / "install_release.py"))
        _write(assets / ASSETS[3], "".join(f"{file_hash(assets / name)}  {name}\n" for name in ASSETS[:3]).encode("ascii"))
        if _inputs(receipt_path, receipt_sha256, source_commit, version, license_file, notices_file)[0] != inputs:
            raise ValueError("Package inputs changed during build")
        result = {"schema": 1, "phase": "PACKAGED", "inputIdentity": identity, "inputs": inputs,
                  "assets": _verify_assets(namespace, inputs)}
        _write_json(namespace / "result.json", result)
        return result
    except BaseException as error:
        try:
            _write_json(namespace / "failure.json", {"phase": "FAILED_OR_UNKNOWN", "inputIdentity": identity,
                        "error": {"name": type(error).__name__, "message": str(error)}})
        except OSError:
            pass  # Preserve the primary failure; the CLI still reports it on stderr.
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepared-receipt", type=Path, required=True)
    parser.add_argument("--receipt-sha256", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--license", type=Path, required=True)
    parser.add_argument("--notices", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(package_release(args.prepared_receipt, args.receipt_sha256, args.source_commit, args.version,
                                    args.license, args.notices, args.output_root), indent=2))


if __name__ == "__main__":
    main()
