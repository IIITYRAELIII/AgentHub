"""Thin stdlib bootstrap for a versioned, checksum-pinned ready Hub package.

No Git, npm, build, provider operation, runtime stop or automatic restart.
Copy only this file and its installation guide to Utilities at managed cutover.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile


MAX_ARCHIVE_BYTES = 2 * 1024**3
MAX_EXPANDED_BYTES = 4 * 1024**3
MAX_FILES = 100_000
REPOSITORY = "IIITYRAELIII/AgentHub"
ASSET_HOSTS = {"release-assets.githubusercontent.com", "objects.githubusercontent.com"}


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_name(value: str) -> str:
    if not value or "\\" in value or ":" in value or value.startswith("/"):
        raise ValueError("Unsafe package path")
    parts = value.split("/")
    if any(x in {"", ".", ".."} or x.endswith((".", " ")) or re.search(r"[\x00-\x1f]", x) for x in parts):
        raise ValueError("Unsafe package path")
    for part in parts:
        if re.fullmatch(r"(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", part, re.I):
            raise ValueError("Windows device path refused")
    return PurePosixPath(value).as_posix()


def validate_source_url(url: str, *, redirect=False) -> str:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError("Only canonical HTTPS release assets are supported")
    if parsed.hostname == "github.com":
        if not parsed.path.startswith(f"/{REPOSITORY}/releases/download/") or parsed.query or parsed.fragment:
            raise ValueError("Only versioned AgentHub release assets are supported")
    elif not redirect or parsed.hostname not in ASSET_HOSTS:
        raise ValueError("Untrusted release redirect")
    return url


class AssetRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_source_url(newurl, redirect=True)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(url: str, target: Path) -> None:
    validate_source_url(url)
    opener = urllib.request.build_opener(AssetRedirect())
    request = urllib.request.Request(url, headers={"User-Agent": "AgentHub-ReadyPackage-Installer"})
    with opener.open(request, timeout=30) as response, target.open("xb") as out:
        size = 0
        deadline = time.monotonic()+10*60
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_ARCHIVE_BYTES or time.monotonic() > deadline:
                raise ValueError("Ready package exceeds download budget")
            out.write(chunk)
        out.flush()
        os.fsync(out.fileno())


def extract_verified(archive: Path, expected_sha256: str, destination: Path) -> dict:
    if not archive.is_file() or archive.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ValueError("Ready archive is missing or exceeds its budget")
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256) or file_hash(archive) != expected_sha256:
        raise ValueError("Ready package SHA-256 mismatch")
    if destination.exists():
        raise ValueError("Extraction destination must not exist")
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        if not entries or len(entries) > MAX_FILES or sum(x.file_size for x in entries) > MAX_EXPANDED_BYTES:
            raise ValueError("Ready package exceeds expansion budget")
        names, folded = {}, set()
        for entry in entries:
            name = safe_name(entry.filename)
            mode = entry.external_attr >> 16
            if entry.is_dir() or (stat.S_IFMT(mode) not in (0, stat.S_IFREG)) or entry.flag_bits & 1:
                raise ValueError("Directories, links, special or encrypted entries refused")
            if name.casefold() in folded:
                raise ValueError("Duplicate package path")
            folded.add(name.casefold())
            names[name] = entry
        for name in names:
            if any(parent.casefold() in folded for parent in [str(p) for p in PurePosixPath(name).parents if str(p) != "."]):
                raise ValueError("File/directory package collision")
        descriptor_entry = names.get("package-manifest.json")
        if not descriptor_entry or descriptor_entry.file_size > 8*1024**2:
            raise ValueError("Missing or oversized package descriptor")
        descriptor = json.loads(source.read(descriptor_entry).decode("utf-8"))
        if (descriptor.get("schema") != 1 or descriptor.get("repository") != REPOSITORY
                or descriptor.get("platform") != "win32-x64" or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", descriptor.get("releaseId", ""))):
            raise ValueError("Unsupported ready package identity")
        records = descriptor.get("files")
        if not isinstance(records, list) or len(records) != len(names)-1:
            raise ValueError("Package inventory mismatch")
        indexed = {}
        for item in records:
            name = safe_name(item["path"])
            if name in indexed or name == "package-manifest.json" or not re.fullmatch(r"[0-9a-f]{64}", item.get("sha256", "")):
                raise ValueError("Invalid package inventory")
            if type(item.get("bytes")) is not int or item["bytes"] < 0:
                raise ValueError("Invalid package length")
            indexed[name] = item
        if set(indexed) != set(names)-{"package-manifest.json"}:
            raise ValueError("Undeclared package content")
        required = {"install-prepared.mjs", "config.example.json", "LICENSE", "THIRD_PARTY_NOTICES.md",
                    "runtime/runtime-manifest.json", "runtime/AgentHub.RuntimeHost.exe"}
        if not required.issubset(names):
            raise ValueError("Incomplete Windows ready package")
        destination.mkdir(parents=True, exist_ok=False)
        owned_destination = destination.resolve(strict=True)
        try:
            for name, entry in names.items():
                target = destination.joinpath(*PurePosixPath(name).parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                digest = hashlib.sha256()
                size = 0
                with source.open(entry) as incoming, target.open("xb") as outgoing:
                    while chunk := incoming.read(1024*1024):
                        size += len(chunk)
                        digest.update(chunk)
                        outgoing.write(chunk)
                if name in indexed and (size != indexed[name]["bytes"] or digest.hexdigest() != indexed[name]["sha256"]):
                    raise ValueError("Ready package file integrity mismatch")
        except BaseException:
            # Destination was exclusively created by this call and no child has
            # executed. Preserve the supplied archive; remove only our extraction.
            if destination.resolve(strict=True) != owned_destination or destination.is_symlink():
                raise RuntimeError("Extraction ownership changed; temporary files preserved")
            shutil.rmtree(owned_destination)
            raise
    return descriptor


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--url")
    source.add_argument("--archive", type=Path)
    parser.add_argument("--sha256", required=True, help="Checksum of the exact reviewed release ZIP")
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--scratch-root", type=Path, required=True, help="Private temporary area on the intended volume")
    parser.add_argument("--rollback", action="store_true")
    args = parser.parse_args()
    if os.name != "nt":
        raise RuntimeError("Ready packages currently support Windows x64 only")
    if args.runtime_root.resolve().is_relative_to(args.scratch_root.resolve()):
        raise ValueError("Runtime must be outside the disposable package scratch root")
    args.scratch_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="agenthub-package-", dir=args.scratch_root) as temporary:
        scratch = Path(temporary)
        archive = args.archive
        if args.url:
            archive = scratch/"release.zip"
            download(args.url, archive)
        descriptor = extract_verified(archive, args.sha256, scratch/"verified")
        node = shutil.which("node")
        if not node:
            raise RuntimeError("Node.js runtime with node:sqlite is required; no npm or compiler is needed")
        subprocess.run([node, "-e", "require('node:sqlite')"], check=True, capture_output=True)
        # Explicit offline update only; the existing owner checks live/unknown
        # process evidence. No automatic start, stop, autostart or retry.
        result = subprocess.run([node, str(scratch/"verified/install-prepared.mjs"),
                                 "rollback" if args.rollback else "install", str(args.runtime_root.resolve())],
                                check=False, env={k: v for k, v in os.environ.items()
                                                  if not k.startswith("AGENT_HUB_PUBLICATION_")})
        if result.returncode:
            raise RuntimeError("Installation did not report success; inspect the existing runtime owner before retrying")
        print(f"Package {descriptor['releaseId']} processed. Runtime was not started.")


if __name__ == "__main__":
    main()
