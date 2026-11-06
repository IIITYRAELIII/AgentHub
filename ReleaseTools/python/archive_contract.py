"""Public package format verifier extracted from the MIT recipient; no install or state access."""
import hashlib
import os
from pathlib import Path, PurePosixPath
import shutil
import re
import stat
import zipfile
import json


MAX_ARCHIVE_BYTES = 2 * 1024**3

MAX_EXPANDED_BYTES = 4 * 1024**3

MAX_FILES = 100_000

REPOSITORY = "IIITYRAELIII/AgentHub"

VERSION_SCHEME = "semver-build-v1"

_NUMBER = r"(?:0|[1-9][0-9]*)"

_SEMVER = re.compile(rf"({_NUMBER})\.({_NUMBER})\.({_NUMBER})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?")

def semantic_fields(value: dict, *, descriptor=False) -> dict:
    """Validate the new explicit identity; old receipts are read without enrichment."""
    artifact = value.get("version") if descriptor else value.get("releaseVersion")
    scheme = value.get("versionScheme")
    if scheme is None and not (isinstance(artifact, str) and "+build." in artifact):
        if any(key in value for key in ("publicVersion", "buildNumber")):
            raise ValueError("Unrecognized version metadata")
        return {}
    public = value.get("publicVersion")
    build = value.get("buildNumber")
    match = _SEMVER.fullmatch(public) if isinstance(public, str) and len(public) <= 128 else None
    if (scheme != VERSION_SCHEME or not match or any(int(x) > 9007199254740991 for x in match.group(1, 2, 3))
            or type(build) is not int or not 1 <= build <= 2100000000
            or any(x.isdigit() and len(x) > 1 and x[0] == "0" for x in (match[4] or "").split("."))
            or artifact != f"{public}+build.{build}" or (not descriptor and value.get("version") != public)):
        raise ValueError("Semantic public/build/artifact identity mismatch")
    return {"versionScheme": VERSION_SCHEME, "publicVersion": public, "buildNumber": build}

def valid_artifact_version(value: str) -> bool:
    if not isinstance(value, str):
        return False
    if re.fullmatch(r"[0-9]+(?:\.[0-9]+){2,3}", value):
        return True  # Historical immutable receipt grammar; not upgrade authority.
    match = re.fullmatch(r"(.+)\+build\.([1-9][0-9]*)", value)
    if not match:
        return False
    try:
        semantic_fields({"versionScheme": VERSION_SCHEME, "publicVersion": match[1],
                         "buildNumber": int(match[2]), "version": value}, descriptor=True)
        return True
    except ValueError:
        return False

def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with windows_filesystem_path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def windows_filesystem_path(path: Path) -> Path:
    """Use Windows' extended namespace for owned extraction IO and cleanup."""
    if os.name != "nt":
        return path
    value = str(path.absolute())
    if value.startswith("\\\\?\\"):
        return Path(value)
    return Path("\\\\?\\UNC\\" + value[2:] if value.startswith("\\\\") else "\\\\?\\" + value)

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

def extract_verified(archive: Path, expected_sha256: str, destination: Path) -> dict:
    archive = windows_filesystem_path(archive)
    if not archive.is_file() or archive.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ValueError("Ready archive is missing or exceeds its budget")
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256) or file_hash(archive) != expected_sha256:
        raise ValueError("Ready package SHA-256 mismatch")
    destination = windows_filesystem_path(destination)
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
        version_fields = semantic_fields(descriptor, descriptor=True)
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
            if version_fields:
                runtime = json.loads((destination/"runtime/runtime-manifest.json").read_text(encoding="utf-8"))
                if (semantic_fields(runtime) != version_fields or runtime.get("releaseVersion") != descriptor["version"]
                        or runtime.get("releaseId") != descriptor["releaseId"]
                        or runtime.get("publicationRevision") != descriptor.get("sourceCommit")):
                    raise ValueError("Package/runtime version identity mismatch")
        except BaseException:
            # Destination was exclusively created by this call and no child has
            # executed. Preserve the supplied archive; remove only our extraction.
            if destination.resolve(strict=True) != owned_destination or destination.is_symlink():
                raise RuntimeError("Extraction ownership changed; temporary files preserved")
            shutil.rmtree(owned_destination)
            raise
    return descriptor
