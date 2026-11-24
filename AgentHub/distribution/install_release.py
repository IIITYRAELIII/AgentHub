"""Standalone verified Hub replacement, with explicit wait-current/force modes.

The independent worker owns retirement, backup, installation and checked Ready.
No provider turn is resumed or replayed by this installer.
"""
from __future__ import annotations

import argparse
import base64
from contextlib import closing, contextmanager, ExitStack
import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.error
import urllib.request
import zipfile


MAX_ARCHIVE_BYTES = 2 * 1024**3
MAX_EXPANDED_BYTES = 4 * 1024**3
MAX_FILES = 100_000
MAX_METADATA_BYTES = 1024 * 1024
REPOSITORY = "IIITYRAELIII/AgentHub"
PACKAGE_ASSET = "AgentHub-win32-x64.zip"
ASSET_HOSTS = {"release-assets.githubusercontent.com", "objects.githubusercontent.com"}
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
        try:
            validate_source_url(newurl, redirect=True)
        except ValueError:
            if fp is not None:
                fp.close()
            raise
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class ReleaseHTTPSConnection(http.client.HTTPSConnection):
    def putheader(self, header, *values):
        # Read the framed response before closing locally. Requesting early
        # peer closure stalls/truncates canonical release responses on some paths.
        if header.lower() == "connection" and values == ("close",):
            return
        super().putheader(header, *values)


class ReleaseHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, request):
        return self.do_open(ReleaseHTTPSConnection, request, context=self._context)


@contextmanager
def release_response(opener, request):
    try:
        response = opener.open(request, timeout=30)
    except urllib.error.HTTPError as error:
        # An HTTPError owns the response before the with-statement can enter.
        error.close()
        raise
    with response:
        yield response


def download(url: str, target: Path, *, max_bytes=MAX_ARCHIVE_BYTES) -> None:
    validate_source_url(url)
    opener = urllib.request.build_opener(ReleaseHTTPSHandler(), AssetRedirect())
    request = urllib.request.Request(url, headers={"User-Agent": "AgentHub-ReadyPackage-Installer"})
    with release_response(opener, request) as response, windows_filesystem_path(target).open("xb") as out:
        size = 0
        deadline = time.monotonic()+10*60
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            if size > max_bytes or time.monotonic() > deadline:
                raise ValueError("Ready package exceeds download budget")
            out.write(chunk)
        out.flush()
        os.fsync(out.fileno())


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if fp is not None:
            fp.close()
        raise ValueError("Release API redirects refused")


def release_metadata(release: str) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", release):
        raise ValueError("Use latest or an exact simple release tag")
    selector = "latest" if release == "latest" else "tags/"+release
    url = f"https://api.github.com/repos/{REPOSITORY}/releases/{selector}"
    request = urllib.request.Request(url, headers={
        "User-Agent": "AgentHub-ReadyPackage-Installer", "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"})
    # Public anonymous endpoint only: no gh, environment token or credentials.
    with release_response(urllib.request.build_opener(ReleaseHTTPSHandler(), NoRedirect()), request) as response:
        raw = response.read(MAX_METADATA_BYTES+1)
    if len(raw) > MAX_METADATA_BYTES:
        raise ValueError("Release metadata exceeds budget")
    metadata = json.loads(raw.decode("utf-8"))
    if not isinstance(metadata, dict):
        raise ValueError("Invalid release metadata")
    tag = metadata.get("tag_name", "")
    if (not isinstance(tag, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", tag)
            or (release != "latest" and tag != release)
            or metadata.get("draft") is not False or metadata.get("prerelease") is not False
            or not metadata.get("published_at")):
        raise ValueError("Only a published stable release is supported")
    return metadata


def select_asset(metadata: dict, name: str, max_bytes: int) -> dict:
    assets = metadata.get("assets")
    if not isinstance(assets, list) or len(assets) > 100:
        raise ValueError("Invalid release asset inventory")
    matches = [x for x in assets if isinstance(x, dict) and x.get("name") == name]
    if len(matches) != 1:
        raise ValueError("Required ready package asset is missing or ambiguous")
    asset = matches[0]
    url = f"https://github.com/{REPOSITORY}/releases/download/{metadata['tag_name']}/{name}"
    if (asset.get("browser_download_url") != url or asset.get("state") != "uploaded"
            or type(asset.get("size")) is not int or not 0 < asset["size"] <= max_bytes
            or not re.fullmatch(r"sha256:[0-9a-f]{64}", asset.get("digest") or "")):
        raise ValueError("Release asset URL, digest, state or size is invalid")
    return asset


def fetch_release(release: str, scratch: Path, *, metadata=None, stage=lambda value: None) -> tuple[Path, str, dict]:
    metadata = release_metadata(release) if metadata is None else metadata
    asset = select_asset(metadata, PACKAGE_ASSET, MAX_ARCHIVE_BYTES)
    checksum_asset = select_asset(metadata, PACKAGE_ASSET+".json", MAX_METADATA_BYTES)
    checksum_file = scratch/"release.json"
    stage("descriptor-body")
    download(checksum_asset["browser_download_url"], checksum_file, max_bytes=MAX_METADATA_BYTES)
    if (windows_filesystem_path(checksum_file).stat().st_size != checksum_asset["size"]
            or "sha256:"+file_hash(checksum_file) != checksum_asset["digest"]):
        raise ValueError("Release descriptor SHA-256 or size mismatch")
    descriptor = json.loads(windows_filesystem_path(checksum_file).read_text(encoding="utf-8"))
    if (not isinstance(descriptor, dict) or descriptor.get("schema") != 1
            or descriptor.get("repository") != REPOSITORY or descriptor.get("platform") != "win32-x64"
            or descriptor.get("asset") != PACKAGE_ASSET or descriptor.get("bytes") != asset["size"]
            or "sha256:"+str(descriptor.get("sha256")) != asset["digest"]
            or not re.fullmatch(r"[0-9a-f]{40}", str(descriptor.get("sourceCommit")))
            or not re.fullmatch(r"[0-9a-f]{64}", str(descriptor.get("packageManifestSha256")))
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", str(descriptor.get("releaseId")))):
        raise ValueError("Release descriptor and published asset disagree")
    fields = semantic_fields(descriptor, descriptor=True)
    if fields and "-" in fields["publicVersion"]:
        raise ValueError("Prerelease is not eligible for stable discovery")
    if fields and metadata["tag_name"] != fields["publicVersion"]:
        raise ValueError("Published tag differs from public version")
    archive = scratch/"release.zip"
    stage("archive-body")
    download(asset["browser_download_url"], archive, max_bytes=asset["size"])
    if windows_filesystem_path(archive).stat().st_size != asset["size"] or file_hash(archive) != descriptor["sha256"]:
        raise ValueError("Release ZIP SHA-256 or size mismatch")
    return archive, metadata["tag_name"], descriptor


def verify_release_descriptor(package: dict, extracted: Path, release: dict) -> None:
    if (any(package.get(key) != release.get(key) for key in ("releaseId", "sourceCommit", "version"))
            or file_hash(extracted/"package-manifest.json") != release["packageManifestSha256"]):
        raise ValueError("Extracted package differs from the selected release descriptor")
    if semantic_fields(package, descriptor=True) != semantic_fields(release, descriptor=True):
        raise ValueError("Extracted public version/build differs from release")


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


def read_update_original(runtime_root: Path, operation_id: str):
    """Internal authoritative absence is distinct from the public UNKNOWN projection."""
    _plain_chain(runtime_root/"data")
    try:
        _plain(runtime_root/"data/runtime.sqlite")
    except FileNotFoundError:
        # Pre-maintenance installations have no canonical database yet. The
        # external retained dispatch fence still prevents a second worker.
        return None
    with closing(sqlite3.connect((runtime_root/"data/runtime.sqlite").as_uri()+"?mode=ro", uri=True, timeout=0)) as database:
        if not database.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='maintenance_operations'").fetchone():
            return None
        row = database.execute("SELECT operation_json FROM maintenance_operations WHERE operation_id = ?", (operation_id,)).fetchone()
    if row is None:
        return None
    original = json.loads(row[0])
    if original.get("operationId") != operation_id or original.get("kind") != "restart":
        raise ValueError("Different original maintenance identity")
    return original


def original_status(operation_id: str, original) -> dict:
    if original is None:
        return {"operationId": operation_id, "state": "unknown", "effectsReplayed": False}
    result = {"operationId": operation_id, "status": original.get("status"), "phase": original.get("phase"),
              "outcome": original.get("outcome"), "effectsReplayed": False}
    metadata = original.get("metadata") or {}
    if metadata.get("autonomousCodexPreflight"):
        result["codexPreflight"] = metadata["autonomousCodexPreflight"]
    if metadata.get("autonomousCodexStartupRejection"):
        result["codexStartupRejection"] = metadata["autonomousCodexStartupRejection"]
    envelope = metadata.get("packageHandoff") or {}
    binding = envelope.get("binding") or {}
    if (original.get("status") in {"requested", "blocked", "running"} and original.get("outcome") is None
            and metadata.get("packageInputSha256") and envelope.get("schema") == 1
            and binding.get("operationId") == operation_id
            and hashlib.sha256(json.dumps(binding, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
            == envelope.get("sha256")
            and (not metadata.get("packageIncoming") or
                 (metadata["packageIncoming"].get("native") and metadata["packageIncoming"].get("outsideAllJobs") is True))):
        result["handoff"] = {"action": "yield_current_turn", "reason": "public_package_restart",
                             "operationId": operation_id}
    return result


def reconcile_incoming_owner(runtime: Path, original: dict, cache: Path, installer: Path) -> None:
    """Resume only incoming-owner admission, never old lifecycle dispatch."""
    if (original.get("status") not in {"requested", "blocked", "running"}
            or original.get("outcome") is not None
            or not (original.get("metadata") or {}).get("packageInputSha256")
            or (original.get("metadata") or {}).get("packageIncoming")):
        return
    dispatch = cache/"dispatch-intent.json"
    if not windows_filesystem_path(dispatch).exists():
        return
    request_file, selection_file = cache/"update-request.json", cache/"selection.json"
    intent = _read_record(dispatch)
    expected = dict(schema=1, kind="package-bootstrap-dispatch-v1", operationId=original["operationId"],
                    preparationSha256=file_hash(cache/"preparation.json"),
                    selectionSha256=file_hash(selection_file), requestSha256=file_hash(request_file))
    if intent != expected:
        raise ValueError("Original package dispatch identity changed")
    request, selected = _read_record(request_file), _read_record(selection_file)
    if (request.get("operationId") != original["operationId"] or Path(request.get("runtimeRoot", "")).resolve(strict=True) != runtime
            or Path(request.get("installer", "")).resolve(strict=True) != installer):
        raise ValueError("Original incoming continuation input changed")
    assets = {entry["name"]: entry for entry in selected["assets"]}
    for key, name in [("archive", "AgentHub-win32-x64.zip"), ("descriptor", "AgentHub-win32-x64.zip.json"), ("installer", "install_release.py")]:
        file = Path(request[key]); _plain_chain(file.parent); _plain(file)
        if file_hash(file) != assets[name]["digest"].removeprefix("sha256:"):
            raise ValueError("Original incoming public asset changed")
    package = Path(request["packageRoot"]); _plain_chain(package)
    descriptor = _read_record(Path(request["descriptor"]))
    manifest_file = package/"package-manifest.json"
    if _plain(manifest_file).st_size > 8*1024**2:
        raise ValueError("Oversized incoming package inventory")
    manifest_bytes = windows_filesystem_path(manifest_file).read_bytes()
    if hashlib.sha256(manifest_bytes).hexdigest() != descriptor["packageManifestSha256"]:
        raise ValueError("Original incoming package inventory changed")
    manifest = json.loads(manifest_bytes)
    verify_release_descriptor(manifest, package, descriptor)
    for record in manifest["files"]:
        file = package.joinpath(*PurePosixPath(safe_name(record["path"])).parts)
        _plain_chain(file.parent)
        if _plain(file).st_size != record["bytes"] or file_hash(file) != record["sha256"]:
            raise ValueError("Original incoming package bytes changed")
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js with node:sqlite is required")
    entry = package/"runtime/src/runtime/runtime-package-handoff.mjs"
    result = subprocess.run([node, str(entry), "bootstrap-reconcile", str(request_file)], check=False)
    if result.returncode:
        raise RuntimeError("Incoming owner reconciliation is unknown; retain the original")


def update_status(runtime_root: Path, operation_id: str) -> dict:
    """Bounded read projection only; this never grants retry/install authority."""
    return original_status(operation_id, read_update_original(runtime_root, operation_id))


def _plain(path: Path, *, directory=False):
    value = windows_filesystem_path(path).lstat()
    if (stat.S_ISLNK(value.st_mode) or getattr(value, "st_file_attributes", 0) & 0x400
            or not (stat.S_ISDIR(value.st_mode) if directory else stat.S_ISREG(value.st_mode))
            or (not directory and value.st_nlink != 1)):
        raise ValueError("Linked, shared or nonregular update preparation path refused")
    return value


def _directory_identity(path: Path) -> dict:
    value = _plain(path, directory=True)
    return dict(path=str(path), dev=str(value.st_dev), ino=str(value.st_ino))


def _plain_chain(path: Path):
    for ancestor in reversed([path, *path.parents]):
        _plain(ancestor, directory=True)


def _read_record(path: Path) -> dict:
    before = _plain(path)
    if before.st_size > MAX_METADATA_BYTES:
        raise ValueError("Oversized update preparation record")
    body = windows_filesystem_path(path).read_bytes()
    after = _plain(path)
    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
        raise ValueError("Update preparation record changed during read")
    result = json.loads(body.decode("utf-8"))
    if not isinstance(result, dict):
        raise ValueError("Invalid update preparation record")
    return result


def _write_record(path: Path, value: dict):
    # Exclusive publication: a process crash can leave a partial record, which
    # refuses rather than being repaired, adopted or interpreted as absence.
    with windows_filesystem_path(path).open("x", encoding="utf-8") as output:
        json.dump(value, output, sort_keys=True, separators=(",", ":"))
        output.flush()
        os.fsync(output.fileno())


@contextmanager
def _preparation_lock(cache: Path):
    lock = windows_filesystem_path(cache/"preparation.lock")
    if not lock.exists():
        with lock.open("xb") as output:
            output.write(b"0")
            output.flush()
            os.fsync(output.fileno())
    before = _plain(lock)
    with lock.open("r+b") as stream:
        opened = os.fstat(stream.fileno())
        if (opened.st_dev, opened.st_ino, opened.st_size) != (before.st_dev, before.st_ino, 1) or opened.st_nlink != 1:
            raise ValueError("Update preparation lock changed")
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def _transport_selection(release: str, installer_sha256: str) -> dict:
    metadata = release_metadata(release)
    selected = [select_asset(metadata, name, limit) for name, limit in [
        (PACKAGE_ASSET, MAX_ARCHIVE_BYTES), (PACKAGE_ASSET+".json", MAX_METADATA_BYTES),
        ("install_release.py", MAX_METADATA_BYTES)]]
    # Store only canonical public identities, never expiring redirect URLs or
    # unrelated API/body/authentication fields.
    assets = [{key: asset[key] for key in ("name", "state", "size", "digest", "browser_download_url")} for asset in selected]
    if assets[2]["digest"] != "sha256:"+installer_sha256:
        raise ValueError("Executing installer differs from the selected public asset")
    return dict(tag_name=metadata["tag_name"], assets=assets)


def prepare_update(args) -> None:
    # One retained transport, not another updater registry. All lifecycle writes
    # and effects belong to the existing maintenance/restart/Host owners.
    runtime = args.runtime_root.resolve(strict=True)
    scratch = args.scratch_root.resolve(strict=True)
    _plain_chain(runtime)
    _plain_chain(scratch)
    identity = hashlib.sha256((str(runtime)+"\0"+args.operation_id).encode()).hexdigest()[:32]
    cache = scratch/("agenthub-update-"+identity)
    preparation = cache/"preparation.json"
    if windows_filesystem_path(cache).exists() and not windows_filesystem_path(preparation).exists():
        # Historical unbound caches are immutable/readback-only. In particular,
        # absence of update-request.json never proves pre-dispatch ownership.
        _plain_chain(cache)
        prior_file = cache/"update-request.json"
        if windows_filesystem_path(prior_file).exists():
            prior = _read_record(prior_file)
            if (prior.get("tag") != args.release or prior.get("operationId") != args.operation_id
                    or Path(prior.get("runtimeRoot", "")).resolve() != runtime):
                raise ValueError("Original update selection changed; no new effects were submitted")
        print(json.dumps(update_status(runtime, args.operation_id)))
        return
    installer = Path(__file__).resolve(strict=True)
    _plain(installer)
    binding = dict(schema=1, kind="public-update-preparation-v1", runtime=_directory_identity(runtime),
                   scratch=_directory_identity(scratch), operationId=args.operation_id, release=args.release,
                   archiveSha256=args.sha256, installerSha256=file_hash(installer))
    if not windows_filesystem_path(cache).exists():
        original = read_update_original(runtime, args.operation_id)
        if original is not None:
            print(json.dumps(original_status(args.operation_id, original)))
            return
        windows_filesystem_path(cache).mkdir()
        _write_record(preparation, dict(binding=binding, cache=_directory_identity(cache)))
    _plain_chain(cache)
    with _preparation_lock(cache):
        record = _read_record(preparation)
        def assert_bound():
            _plain_chain(cache)
            if (record != dict(binding=binding, cache=_directory_identity(cache))
                    or _directory_identity(runtime) != binding["runtime"]
                    or args.runtime_root.resolve(strict=True) != runtime
                    or args.scratch_root.resolve(strict=True) != scratch
                    or _directory_identity(scratch) != binding["scratch"]
                    or file_hash(installer) != binding["installerSha256"]
                    or _read_record(preparation) != record):
                raise ValueError("Original update selection or physical preparation identity changed")
        assert_bound()
        original = read_update_original(runtime, args.operation_id)
        if (original is not None or windows_filesystem_path(cache/"dispatch-intent.json").exists()
                or windows_filesystem_path(cache/"update-request.json").exists()):
            # Neither absent SQL nor a lost subprocess reply can reopen this fence.
            if original is not None:
                reconcile_incoming_owner(runtime, original, cache, installer)
                original = read_update_original(runtime, args.operation_id)
            print(json.dumps(original_status(args.operation_id, original)))
            return
        selected = _transport_selection(args.release, binding["installerSha256"])
        selection_file = cache/"selection.json"
        if windows_filesystem_path(selection_file).exists():
            if _read_record(selection_file) != selected:
                raise ValueError("Original public asset selection changed")
        else:
            if {child.name for child in windows_filesystem_path(cache).iterdir()} != {"preparation.json", "preparation.lock"}:
                raise ValueError("Original public asset selection is missing; retained transport cannot be adopted")
            _write_record(selection_file, selected)
        archive_pin = selected["assets"][0]["digest"].removeprefix("sha256:")
        if args.sha256 and args.sha256 != archive_pin:
            raise ValueError("Selected release differs from the additional SHA-256 pin")
        assert_bound()
        # Every explicit PRE-dispatch continuation gets its own exclusive child;
        # failed downloads and uncommitted extraction are never reused/overwritten.
        attempt = cache/Path(tempfile.mkdtemp(prefix="attempt-", dir=windows_filesystem_path(cache))).name
        _plain_chain(attempt)
        attempt_identity = _directory_identity(attempt)
        phase = "descriptor-body"
        def stage(value):
            nonlocal phase
            assert_bound()
            _plain_chain(attempt)
            if _directory_identity(attempt) != attempt_identity:
                raise ValueError("Update preparation attempt identity changed")
            phase = value
        try:
            archive, tag, descriptor = fetch_release(args.release, attempt, metadata=selected, stage=stage)
        except Exception as error:
            # No exception text, redirect URLs, headers or response bodies enter
            # this bounded transport record. It is evidence, not retry authority.
            code = type(error).__name__
            try:
                stage(phase)
                _write_record(attempt/"transport-result.json", dict(schema=1, operationId=args.operation_id,
                              phase=phase, outcome="interrupted", failureCode=code if code in
                              {"TimeoutError", "URLError", "HTTPError", "OSError", "ValueError", "JSONDecodeError"} else "Error"))
            except Exception as recording_error:
                error.add_note("Transport result was not saved: "+type(recording_error).__name__)
            raise
        stage("verified-assets")
        _write_record(attempt/"transport-result.json", dict(schema=1, operationId=args.operation_id,
                      phase="verified-assets", outcome="succeeded", archiveSha256=file_hash(archive),
                      descriptorSha256=file_hash(attempt/"release.json")))
        package = attempt/"verified"
        inner = extract_verified(archive, descriptor["sha256"], package)
        verify_release_descriptor(inner, package, descriptor)
        stage("verified-package")
        _plain_chain(package)
        node = shutil.which("node")
        if not node:
            raise RuntimeError("Node.js with node:sqlite is required")
        assert_bound()
        if _read_record(selection_file) != selected:
            raise ValueError("Original public asset selection changed")
        original = read_update_original(runtime, args.operation_id)
        if original is not None:
            print(json.dumps(original_status(args.operation_id, original)))
            return
        request = dict(schema=1, operationId=args.operation_id, runtimeRoot=str(runtime),
                       packageRoot=str(package.resolve()), tag=tag, archive=str(archive.resolve()),
                       descriptor=str((attempt/"release.json").resolve()), installer=str(installer))
        request_file = cache/"update-request.json"
        _write_record(request_file, request)
        _write_record(cache/"dispatch-intent.json", dict(schema=1, kind="package-bootstrap-dispatch-v1",
                      operationId=args.operation_id, preparationSha256=file_hash(preparation),
                      selectionSha256=file_hash(selection_file), requestSha256=file_hash(request_file)))
        assert_bound()
        entry = package/"runtime/src/runtime/runtime-package-handoff.mjs"
        print("Keep the retained package/backup until the original update completes. "
              "After yield_current_turn, finish this Hub turn so the admitted restart can proceed. "
              "Read the same original after restart.", flush=True)
        result = subprocess.run([node, str(entry), "bootstrap-start", str(request_file)], check=False)
        if result.returncode:
            raise RuntimeError("Update admission was not confirmed; retained original must be read, not re-launched")


def historical_main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--url")
    source.add_argument("--archive", type=Path)
    source.add_argument("--release", help="Exact stable tag, or latest, from the public AgentHub release origin")
    parser.add_argument("--sha256", help="Required for --url/--archive; optional additional pin for --release")
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--scratch-root", type=Path, required=True, help="Private temporary area on the intended volume")
    parser.add_argument("--rollback", action="store_true")
    parser.add_argument("--offline", action="store_true", help="Install into a fully stopped Hub without starting a worker")
    parser.add_argument("--inspect-package", action="store_true", help="Verify/extract public input only; no runtime effect")
    parser.add_argument("--prepare-update", action="store_true", help="Admit one exact package update through the existing runtime owner")
    parser.add_argument("--update-status", action="store_true", help="Read the exact original without replaying effects")
    parser.add_argument("--operation-id", help="Original stable identity for package update/readback")
    parser.add_argument("--project-root", type=Path, help="Selected project for a first installation; existing configuration is preserved")
    args = parser.parse_args()
    if not args.release and not args.sha256:
        parser.error("--sha256 is required with --url or --archive")
    if args.sha256 and not re.fullmatch(r"[0-9a-f]{64}", args.sha256):
        parser.error("--sha256 must be 64 lowercase hexadecimal characters")
    if sum((args.rollback, args.inspect_package, args.prepare_update, args.update_status, args.offline)) > 1:
        parser.error("Choose one installer operation")
    if args.prepare_update or args.update_status:
        if not args.release or args.release == "latest" or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", args.operation_id or ""):
            parser.error("Update requires an exact --release and original --operation-id")
    if args.project_root and (args.rollback or args.inspect_package or args.prepare_update or args.update_status):
        parser.error("--project-root belongs only to a first installation")
    if os.name != "nt":
        raise RuntimeError("Ready packages currently support Windows x64 only")
    if args.offline:
        root = args.runtime_root.resolve(strict=True)
        _plain_chain(root)
        identity = _directory_identity(root)
        args.scratch_root = args.scratch_root.resolve()
        if root.is_relative_to(args.scratch_root) or args.scratch_root.is_relative_to(root):
            raise ValueError("Offline scratch must be outside the selected runtime")
        with installer_runtime_mutex(root):
            assert_offline_root(args.runtime_root, root, identity)
            stop_selected(root, inspect_only=True)
            return install_recipient_package(args, offline=(root, identity))
    if args.runtime_root.resolve().is_relative_to(args.scratch_root.resolve()):
        raise ValueError("Runtime must be outside the disposable package scratch root")
    if args.update_status:
        print(json.dumps(update_status(args.runtime_root.resolve(), args.operation_id)))
        return
    if args.prepare_update:
        args.scratch_root.mkdir(parents=True, exist_ok=True)
        prepare_update(args)
        return
    return install_recipient_package(args)


def assert_offline_root(selected, root, identity):
    _plain_chain(root)
    if selected.resolve(strict=True) != root or _directory_identity(root) != identity:
        raise RuntimeError("Selected offline runtime root changed")


def install_recipient_package(args, *, offline=None):
    args.scratch_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="agenthub-package-", dir=windows_filesystem_path(args.scratch_root)) as temporary:
        scratch = Path(temporary)
        archive = args.archive
        selected = None
        checksum = args.sha256
        if args.release:
            archive, tag, selected = fetch_release(args.release, scratch)
            if checksum and checksum != selected["sha256"]:
                raise ValueError("Selected release differs from the additional SHA-256 pin")
            checksum = selected["sha256"]
            print(f"Selected {REPOSITORY} {tag}: {selected['releaseId']} SHA-256 {checksum}", flush=True)
        elif args.url:
            archive = scratch/"release.zip"
            download(args.url, archive)
        descriptor = extract_verified(archive, checksum, scratch/"verified")
        if selected:
            verify_release_descriptor(descriptor, scratch/"verified", selected)
        if args.inspect_package:
            manifest = (scratch/"verified/runtime/runtime-manifest.json").read_bytes()
            print(json.dumps({"schema": 1, "kind": "verified-package-input", "releaseId": descriptor["releaseId"],
                              "packageManifestSha256": file_hash(scratch/"verified/package-manifest.json"),
                              "runtimeManifestSha256": hashlib.sha256(manifest).hexdigest(),
                              "runtimeManifestBase64": base64.b64encode(manifest).decode("ascii")}))
            return
        node = shutil.which("node")
        if not node:
            raise RuntimeError("Node.js runtime with node:sqlite is required; no npm or compiler is needed")
        subprocess.run([node, "-e", "require('node:sqlite')"], check=True, capture_output=True)
        # Python extraction/cleanup uses the extended filesystem namespace;
        # Node's entry-point resolver accepts the ordinary absolute spelling.
        entry = str(scratch/"verified/install-prepared.mjs")
        if os.name == "nt" and entry.startswith("\\\\?\\"):
            entry = "\\\\" + entry[8:] if entry.startswith("\\\\?\\UNC\\") else entry[4:]
        # Explicit offline update only; the existing owner checks live/unknown
        # process evidence. No automatic start, stop, autostart or retry.
        if offline is None:
            root = args.runtime_root.resolve()
        else:
            root, identity = offline
            assert_offline_root(args.runtime_root, root, identity)
        result = subprocess.run([node, entry,
                                 "rollback" if args.rollback else "install", str(root),
                                 *(["--project-root", str(args.project_root.resolve())] if args.project_root else [])],
                                check=False, env={k: v for k, v in os.environ.items()
                                                  if not k.startswith("AGENT_HUB_PUBLICATION_")})
        if result.returncode:
            raise RuntimeError("Installation did not report success; inspect the existing runtime owner before retrying")
        print(f"Package {descriptor['releaseId']} processed. Runtime was not started.")


# Autonomous recipient installation. The verified extraction and stopped-only
# installer above are deliberately shared with the historical recipient tool.
# No installed API, stdin prompt or release orchestration is involved.
def native_api():
    import ctypes
    from ctypes import wintypes as w
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    for name, restype, args in [
        ("OpenProcess", w.HANDLE, [w.DWORD, w.BOOL, w.DWORD]),
        ("CloseHandle", w.BOOL, [w.HANDLE]),
        ("GetProcessTimes", w.BOOL, [w.HANDLE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]),
        ("QueryFullProcessImageNameW", w.BOOL, [w.HANDLE, w.DWORD, w.LPWSTR, ctypes.POINTER(w.DWORD)]),
        ("WaitForSingleObject", w.DWORD, [w.HANDLE, w.DWORD]),
        ("TerminateProcess", w.BOOL, [w.HANDLE, w.UINT]),
        ("IsProcessInJob", w.BOOL, [w.HANDLE, w.HANDLE, ctypes.POINTER(w.BOOL)]),
        ("OpenJobObjectW", w.HANDLE, [w.DWORD, w.BOOL, w.LPCWSTR]),
        ("GetCurrentProcess", w.HANDLE, []),
        ("CreateMutexW", w.HANDLE, [ctypes.c_void_p, w.BOOL, w.LPCWSTR]),
        ("ReleaseMutex", w.BOOL, [w.HANDLE]),
    ]:
        f = getattr(k, name); f.restype = restype; f.argtypes = args
    return ctypes, w, k


def native_process_error(code, operation):
    c, _, _ = native_api()
    error = c.WinError(code)
    error.native_operation = operation
    return error


@contextmanager
def installer_runtime_mutex(root):
    c, _, k = native_api()
    name = "Local\\AgentHubInstaller-" + hashlib.sha256(str(root).lower().encode()).hexdigest()
    mutex = k.CreateMutexW(None, False, name)
    if not mutex:
        raise c.WinError(c.get_last_error())
    try:
        if k.WaitForSingleObject(mutex, 0) not in (0, 128):
            raise RuntimeError("Another installer owns this runtime")
        try:
            yield
        finally:
            k.ReleaseMutex(mutex)
    finally:
        k.CloseHandle(mutex)


def process_birth(handle):
    c, w, k = native_api()
    times = [c.c_ulonglong() for _ in range(4)]
    if not k.GetProcessTimes(handle, *[c.byref(x) for x in times]):
        raise native_process_error(c.get_last_error(),"GetProcessTimes")
    return str(times[0].value)


def process_parent(handle):
    c, w, _ = native_api()
    nt = c.WinDLL("ntdll")
    nt.NtQueryInformationProcess.argtypes = [w.HANDLE,w.DWORD,c.c_void_p,w.DWORD,c.c_void_p]
    nt.NtQueryInformationProcess.restype = c.c_long
    basic = (c.c_void_p*6)()
    status = nt.NtQueryInformationProcess(handle,0,basic,c.sizeof(basic),None)
    if status:
        raise RuntimeError("NtQueryInformationProcess parent failed: "+str(status))
    return int(basic[5] or 0)


def process_identity(handle):
    c, w, k = native_api()
    created = process_birth(handle)
    name = c.create_unicode_buffer(32768); size = w.DWORD(len(name))
    if not k.QueryFullProcessImageNameW(handle, 0, name, c.byref(size)):
        raise native_process_error(c.get_last_error(),"QueryFullProcessImageNameW")
    return dict(created=created, image=str(Path(name.value).resolve()))


def outside_jobs(handle, job=None):
    c, w, k = native_api(); member = w.BOOL()
    if not k.IsProcessInJob(handle, job, c.byref(member)):
        raise c.WinError(c.get_last_error())
    return not member.value


def process_security(handle):
    """Compare the actual process tokens, not provider success or a user name."""
    c, w, k = native_api()
    adv = c.WinDLL("advapi32", use_last_error=True)
    adv.OpenProcessToken.argtypes = [w.HANDLE, w.DWORD, c.POINTER(w.HANDLE)]
    adv.GetTokenInformation.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD, c.POINTER(w.DWORD)]
    adv.GetLengthSid.argtypes = [c.c_void_p]; adv.GetLengthSid.restype = w.DWORD
    token = w.HANDLE()
    if not adv.OpenProcessToken(handle, 8, c.byref(token)):
        raise c.WinError(c.get_last_error())
    try:
        def info(kind):
            size = w.DWORD()
            adv.GetTokenInformation(token, kind, None, 0, c.byref(size))
            if not size.value: raise c.WinError(c.get_last_error())
            data = c.create_string_buffer(size.value)
            if not adv.GetTokenInformation(token, kind, data, size, c.byref(size)):
                raise c.WinError(c.get_last_error())
            return data
        user = info(1); sid = c.cast(user, c.POINTER(c.c_void_p))[0]
        stats = info(10)
        return dict(userSidSha256=hashlib.sha256(c.string_at(sid, adv.GetLengthSid(sid))).hexdigest(),
                    logonId=stats.raw[8:16].hex(), sessionId=w.DWORD.from_buffer(info(12)).value,
                    elevationType=w.DWORD.from_buffer(info(18)).value)
    finally:
        k.CloseHandle(token)


def suspended_worker_thread(pid):
    """The never-resumed process must have exactly one native owned thread."""
    c, w, k = native_api()
    class Entry(c.Structure):
        _fields_ = [("size", w.DWORD), ("usage", w.DWORD), ("id", w.DWORD),
                    ("owner", w.DWORD), ("priority", w.LONG), ("delta", w.LONG), ("flags", w.DWORD)]
    k.CreateToolhelp32Snapshot.argtypes = [w.DWORD, w.DWORD]
    k.CreateToolhelp32Snapshot.restype = w.HANDLE
    k.Thread32First.argtypes = [w.HANDLE, c.POINTER(Entry)]
    k.Thread32Next.argtypes = [w.HANDLE, c.POINTER(Entry)]
    k.OpenThread.argtypes = [w.DWORD, w.BOOL, w.DWORD]; k.OpenThread.restype = w.HANDLE
    k.GetProcessIdOfThread.argtypes = [w.HANDLE]; k.GetProcessIdOfThread.restype = w.DWORD
    snapshot = k.CreateToolhelp32Snapshot(4, 0)
    if snapshot == c.c_void_p(-1).value: raise c.WinError(c.get_last_error())
    try:
        entry = Entry(); entry.size = c.sizeof(entry); threads = []
        present = k.Thread32First(snapshot, c.byref(entry))
        while present:
            if entry.owner == pid: threads.append(entry.id)
            present = k.Thread32Next(snapshot, c.byref(entry))
        if c.get_last_error() != 18: raise c.WinError(c.get_last_error())
        if len(threads) != 1: raise RuntimeError("Suspended installer thread identity is not unique")
        thread = k.OpenThread(2 | 0x0800, False, threads[0])
        if not thread: raise c.WinError(c.get_last_error())
        if k.GetProcessIdOfThread(thread) != pid:
            k.CloseHandle(thread); raise RuntimeError("Suspended installer thread changed")
        return thread
    finally:
        k.CloseHandle(snapshot)


class WorkerDispatchError(RuntimeError):
    def __init__(self, error, checks, record_saved):
        super().__init__(str(error))
        self.checks = checks
        self.record_saved = record_saved


WORKER_DISPATCH_STAGES = (
    "prepare-worker", "working-directory", "native-api", "caller-job-check",
    "creation-intent", "wmi-launch", "wmi-reply",
    "worker-identity", "worker-security", "worker-job-check", "worker-thread",
    "record-worker-proof", "resume-thread",
)
WMI_REPLY_FAILURE_REASONS = (
    "wmi-reply-invalid", "wmi-result-unreadable", "wmi-reply-mismatch",
    "wmi-create-refused", "wmi-worker-pid-invalid",
)


def report_worker_dispatch_failure(selection, checks, record_saved):
    # A retained file is local evidence, not trusted console text. Print only
    # known stages and scalar observations, never exception messages or paths.
    stage = checks.get("stage")
    stage = stage if stage in WORKER_DISPATCH_STAGES else None
    reason = checks.get("reason")
    if stage != "wmi-reply" or reason not in WMI_REPLY_FAILURE_REASONS:
        if stage == "worker-job-check" and checks.get("workerOutsideAllJobs") is False:
            reason = "worker-in-job"
        else:
            reason = f"{stage}-failed" if stage is not None else None
    report = dict(kind="installer-worker-dispatch-failed", schema=1,
                  operationId=selection["operationId"], installerSha256=selection["installerSha256"],
                  mechanism="Win32_Process.Create", failureRecordSaved=record_saved,
                  stage=stage, reason=reason)
    if reason == "worker-in-job" and checks.get("workerJoined") is True and checks.get("resumeAttempted") is False:
        report["stoppedInstallAvailable"] = True
    for key in ("callerOutsideAllJobs", "workerIdentityVerified", "workerOutsideAllJobs",
                "workerJoined", "resumeAttempted"):
        value = checks.get(key)
        report[key] = value if type(value) is bool else None
    for key in ("windowsBuild", "providerExitCode", "providerReturnValue", "workerPid",
                "workerParentPid", "winerror"):
        value = checks.get(key)
        report[key] = value if type(value) is int and -(2**31) <= value < 2**32 else None
    print(json.dumps(report, sort_keys=True), file=sys.stderr, flush=True)
    raise SystemExit(1)


def retain_worker_dispatch_failure(directory, error, checks, started):
    try:
        _write_record(directory/"worker-dispatch-failure.json",dict(code=type(error).__name__,
            diagnostic=str(error)[:1000],elapsedMs=(time.monotonic()-started)*1000,
            workerIdentityVerified=checks["workerIdentityVerified"], checks=checks))
    except OSError:
        # Console diagnostics must survive failure to write the scratch record.
        return False
    return True


def independent_worker(command, directory, environment, *, runtime_root=None):
    """Use the local Windows process provider; prove independence before Resume.

    Neither Explorer nor the calling Hub is the parent. When breakaway leaves
    the worker in a Job, prove independence from the exact runtime retirement.
    There is one creation attempt. A lost reply retains its original transport.
    """
    # JSON stdin is data; argv, paths and environment are never shell source.
    script = r'''$ErrorActionPreference='Stop';
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
$x=[Console]::In.ReadToEnd()|ConvertFrom-Json;
$s=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{
 CreateFlags=[uint32]16777220; ShowWindow=[uint16]0; EnvironmentVariables=[string[]]$x.environment};
$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
 CommandLine=$x.command;CurrentDirectory=$x.directory;ProcessStartupInformation=$s};
$v=@{returnValue=$r.ReturnValue;pid=$r.ProcessId}|ConvertTo-Json -Compress;
$f=[IO.File]::Open($x.result,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read);
try {$b=[Text.UTF8Encoding]::new($false).GetBytes($v);$f.Write($b,0,$b.Length);$f.Flush($true)} finally {$f.Dispose()};
[Console]::WriteLine($v);'''
    process = thread = None
    owned = False
    checks = dict(stage="working-directory", windowsBuild=sys.getwindowsversion().build,
                  workerIdentityVerified=False, resumeAttempted=False)
    resolved_directory = None
    started = time.monotonic()
    try:
        resolved_directory = directory.resolve(strict=True)
        directory = resolved_directory
        checks["stage"] = "native-api"
        c, w, k = native_api()
        k.ResumeThread.argtypes = [w.HANDLE]; k.ResumeThread.restype = w.DWORD
        checks["stage"] = "caller-job-check"
        checks["callerOutsideAllJobs"] = outside_jobs(k.GetCurrentProcess())
        checks["stage"] = "creation-intent"
        intent = dict(schema=1, mechanism="Win32_Process.Create", creationFlags=0x01000004,
                      commandSha256=hashlib.sha256(subprocess.list2cmdline(command).encode()).hexdigest(),
                      caller=dict(pid=os.getpid(), outsideAllJobs=checks["callerOutsideAllJobs"],
                                  **process_identity(k.GetCurrentProcess())))
        request_file = directory/"request.json"
        if request_file.exists():
            intent.update(operationId=_read_record(request_file)["operationId"], requestSha256=file_hash(request_file))
        _write_record(directory/"worker-create-intent.json", intent)
        started = time.monotonic()
        earliest = time.time_ns()//100 + 116444736000000000
        checks["stage"] = "wmi-launch"
        reply_file = directory/"worker-create-result.json"
        result = subprocess.run([str(Path(os.environ["SystemRoot"])/"System32/WindowsPowerShell/v1.0/powershell.exe"),
                                 "-NoProfile", "-NonInteractive", "-Command", script],
            input=json.dumps(dict(command=subprocess.list2cmdline(command), directory=str(directory),
                                  environment=[f"{a}={b}" for a,b in environment.items()],result=str(reply_file))),
            capture_output=True, encoding="utf-8", env=environment, creationflags=0x08000000)
        checks["providerExitCode"] = result.returncode
        if result.returncode:
            (directory/"worker-provider.stderr").write_text(result.stderr[:4000],encoding="utf-8")
            raise RuntimeError("Windows process provider failed: exit "+str(result.returncode))
        checks["stage"] = "wmi-reply"
        checks["reason"] = "wmi-reply-invalid"
        reply = json.loads(result.stdout)
        if not isinstance(reply, dict): raise ValueError("Invalid Windows process provider reply")
        checks["reason"] = "wmi-result-unreadable"
        retained_reply = _read_record(reply_file)
        checks["reason"] = "wmi-reply-mismatch"
        if reply != retained_reply: raise RuntimeError("Windows process provider reply changed")
        return_value = reply.get("returnValue")
        if type(return_value) is int:
            checks["providerReturnValue"] = return_value
        if type(return_value) is not int:
            checks["reason"] = "wmi-reply-invalid"
            raise ValueError("Invalid Windows process provider return value")
        if return_value != 0:
            checks["reason"] = "wmi-create-refused"
            raise RuntimeError("Windows process provider refused creation: "+str(reply.get("returnValue")))
        if type(reply.get("pid")) is not int or reply["pid"] <= 0:
            checks["reason"] = "wmi-worker-pid-invalid"
            raise RuntimeError("Windows process provider did not return a valid worker PID")
        checks.pop("reason")
        checks["stage"] = "worker-identity"
        process = k.OpenProcess(0x1000 | 0x100000 | 1, False, reply["pid"])
        if not process: raise c.WinError(c.get_last_error())
        identity = process_identity(process)
        if (int(identity["created"]) < earliest or int(identity["created"]) > time.time_ns()//100+116444736000000000
                or os.path.normcase(identity["image"]) != os.path.normcase(str(Path(command[0]).resolve()))):
            raise RuntimeError("Windows process provider returned a different process identity")
        rows = [row for row in process_snapshot() if row["ProcessId"] == reply["pid"]]
        if (len(rows) != 1 or command_arguments(rows[0].get("CommandLine")) != command
                or k.WaitForSingleObject(process,0) != 258):
            raise RuntimeError("Windows process provider worker command or lifetime changed")
        owned = True
        checks.update(workerIdentityVerified=True, workerPid=reply["pid"], stage="worker-security")
        security = process_security(process)
        if security != process_security(k.GetCurrentProcess()):
            raise RuntimeError("Installer worker security context differs from initiator")
        checks["stage"] = "worker-job-check"
        checks["workerOutsideAllJobs"] = outside_jobs(process)
        scope = {}
        if not checks["workerOutsideAllJobs"]:
            try:
                checks["workerParentPid"] = process_parent(process)
            except (OSError, RuntimeError):
                pass
            if runtime_root is None:
                raise RuntimeError("Windows process provider worker belongs to a Job; independence unproved")
            scope["retirementScope"] = selected_runtime_job_scope(runtime_root, process)
        checks["stage"] = "worker-thread"
        thread = suspended_worker_thread(reply["pid"])
        checks["stage"] = "record-worker-proof"
        proof = dict(pid=reply["pid"], **identity, outsideAllJobs=checks["workerOutsideAllJobs"], security=security,
                     mechanism=intent["mechanism"], parentPid=process_parent(process),
                     elapsedMs=(time.monotonic()-started)*1000, **scope)
        _write_record(directory/"worker-verified-suspended.json",proof)
        checks.update(stage="resume-thread", resumeAttempted=True)
        suspended = k.ResumeThread(thread)
        if suspended == 0xffffffff: raise c.WinError(c.get_last_error())
        if suspended != 1: raise RuntimeError("Installer worker had an unexpected native suspend count")
        return proof
    except BaseException as error:
        checks["winerror"] = getattr(error, "winerror", None)
        failure = error
        if owned:
            k.TerminateProcess(process, 1)
            checks["workerJoined"] = k.WaitForSingleObject(process, 10000) == 0
            if not checks["workerJoined"]:
                failure = RuntimeError("Installer dispatch refusal could not join its exact worker")
        record_saved = (resolved_directory is not None
                        and retain_worker_dispatch_failure(resolved_directory, error, checks, started))
        if isinstance(error, Exception):
            raise WorkerDispatchError(failure, checks, record_saved) from error
        raise
    finally:
        if thread: k.CloseHandle(thread)
        if process: k.CloseHandle(process)


def process_snapshot():
    # Read-only discovery. Every effect uses a retained native process HANDLE,
    # creation time and image, never a later process looked up by PID alone.
    script = ('[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); '
              'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,'
              '@{n="Created";e={$_.CreationDate.ToFileTimeUtc().ToString()}} | ConvertTo-Json -Compress')
    result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                            capture_output=True, check=True, encoding="utf-8", creationflags=0x08000000)
    value = json.loads(result.stdout)
    return value if isinstance(value, list) else [value]


def command_arguments(text):
    c, w, _ = native_api(); shell = c.WinDLL("shell32", use_last_error=True)
    shell.CommandLineToArgvW.argtypes = [w.LPCWSTR, c.POINTER(c.c_int)]
    shell.CommandLineToArgvW.restype = c.POINTER(w.LPWSTR)
    count = c.c_int(); argv = shell.CommandLineToArgvW(text or "", c.byref(count))
    if not argv: return []
    try: return [argv[i] for i in range(count.value)]
    finally:
        c.windll.kernel32.LocalFree.argtypes = [c.c_void_p]
        c.windll.kernel32.LocalFree(argv)


HUB_NODE_ENTRIES = {"agent-hub-main.mjs", "agent-hub-server.mjs", "server.mjs", "bot.mjs"}


def node_entrypoint(row):
    """Return Node's program position, never an application data argument."""
    if Path(row.get("ExecutablePath") or "").name.lower() not in {"node.exe", "node"}:
        return None
    args = command_arguments(row.get("CommandLine"))[1:]
    values = {"-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions",
              "--inspect-port", "--env-file", "--env-file-if-exists", "--icu-data-dir", "--openssl-config",
              "--title", "--trace-event-categories", "--trace-event-file-pattern", "--diagnostic-dir",
              "--report-directory", "--report-filename", "--redirect-warnings", "--snapshot-blob",
              "--build-snapshot-config", "--security-revert", "--watch-path"}
    flags = {"--no-warnings", "--experimental-sqlite", "--experimental-vm-modules", "--experimental-strip-types",
             "--enable-source-maps", "--no-deprecation", "--trace-warnings", "--trace-deprecation",
             "--preserve-symlinks", "--preserve-symlinks-main", "--inspect", "--inspect-brk", "--watch"}
    i = 0
    while i < len(args):
        arg = args[i]
        option_name = arg.partition("=")[0]
        if arg == "--":
            return Path(args[i+1]) if i+1 < len(args) and args[i+1] != "-" else None
        if not arg.startswith("-"):
            return Path(arg)
        if option_name in {"-e", "--eval", "-p", "--print", "-c", "--check", "--run", "--test", "-"}:
            return None
        if arg in values:
            if i+1 >= len(args): return None
            i += 2
        elif arg in flags or (arg.startswith("--") and "=" in arg and option_name in values | flags) or (arg.startswith("-r") and len(arg)>2):
            i += 1
        else:
            # Unknown option arity cannot turn its value into executable code.
            return None
    return None


def descendant_birth_matches(parent, child):
    try:
        return 0 < int(parent["Created"]) <= int(child["Created"])
    except (KeyError, TypeError, ValueError):
        return False


def selected_process(row, root):
    image = row.get("ExecutablePath")
    if not image: return False
    image = Path(image).resolve()
    if image == root/"AgentHub.RuntimeHost.exe": return True
    p = node_entrypoint(row)
    try:
        if p and p.is_absolute() and p.name in HUB_NODE_ENTRIES:
            relative = p.resolve().relative_to(root)
            if len(relative.parts) == 1 or (len(relative.parts) == 3 and relative.parts[0].lower() == "releases"):
                return True
    except (OSError, ValueError): pass
    return False


def foreign_hub_installation(row, selected_root):
    """A generic server.mjs is not an installation identity."""
    image = Path(row.get("ExecutablePath") or "").resolve()
    entry = node_entrypoint(row)
    native = image.name.lower() == "agenthub.runtimehost.exe"
    if native:
        candidate = image.parent
    elif entry and entry.is_absolute() and entry.name.lower() in HUB_NODE_ENTRIES:
        entry = entry.resolve()
        candidate = entry.parents[2] if entry.parent.parent.name.lower() == "releases" else entry.parent
    else:
        return False
    if candidate == selected_root:
        return False
    markers = [candidate/"current.json", candidate/"AgentHub.RuntimeHost.exe", candidate/"data"]
    if not all(p.exists() for p in markers):
        return False
    # A recognizable installation with changed/unreadable identity refuses;
    # absence of these markers on an ordinary MCP package does not.
    _plain_chain(candidate); _plain(candidate/"data", directory=True)
    pointer = _read_record(candidate/"current.json")
    release = pointer.get("current")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", release or ""):
        raise RuntimeError("Foreign Hub installation pointer is invalid")
    release_root = candidate/"releases"/release
    if not native and entry.parent.parent.name.lower() == "releases":
        release_root = entry.parent
    manifest = _read_record(release_root/"runtime-manifest.json")
    if manifest.get("releaseId") != release_root.name:
        raise RuntimeError("Foreign Hub manifest identity differs")
    files = {x.get("path"): x for x in manifest.get("files", []) if isinstance(x, dict)}
    host = files.get("AgentHub.RuntimeHost.exe")
    if not host or file_hash(candidate/"AgentHub.RuntimeHost.exe") != host.get("sha256"):
        raise RuntimeError("Foreign Hub native image is not bound")
    if entry:
        record = files.get(entry.name)
        if not record or file_hash(entry) != record.get("sha256"):
            raise RuntimeError("Foreign Hub entry is not bound to its manifest")
    return True


def process_exited(handle):
    c, _, k = native_api()
    result = k.WaitForSingleObject(handle, 0)
    if result == 0:
        return True
    if result == 258:
        return False
    raise c.WinError(c.get_last_error())


def terminate_retained(pid, handle, identity):
    """An original signalled handle remains exit proof after its Job closes."""
    c, _, k = native_api()
    if process_exited(handle):
        return dict(pid=pid, **identity, alreadyExited=True)
    try:
        if process_identity(handle) != identity:
            raise RuntimeError("Retained process identity changed")
    except OSError:
        if process_exited(handle):
            return dict(pid=pid, **identity, alreadyExited=True)
        raise
    if not k.TerminateProcess(handle, 0x467):
        error = c.get_last_error()
        if process_exited(handle):
            return dict(pid=pid, **identity, alreadyExited=True)
        raise native_process_error(error,"TerminateProcess")
    return dict(pid=pid, **identity, forced=True)


class RetirementScopeChanged(RuntimeError):
    """The updater has no authority to retire or replace the current Host."""


def stop_selected(root, *, inspect_only=False, trace=None, capture=None, scope=None, expected_host=None):
    c, w, k = native_api(); records = []
    retained = scope.setdefault("handles",{}) if scope is not None else {}
    known_rows = scope.setdefault("rows",{}) if scope is not None else {}
    authorized = scope.setdefault("authorized",set()) if scope is not None else set()
    started = time.monotonic(); deadline = started + 45
    metrics = dict(snapshotCalls=0, snapshotMs=0, captureMs=0, terminateMs=0, waitMs=0, captured=0)
    def budget():
        if time.monotonic() >= deadline:
            raise RuntimeError("Selected process retirement did not converge")
    def snapshot():
        budget(); before = time.monotonic()
        try:
            rows = {int(row["ProcessId"]): row for row in process_snapshot()}
            if expected_host is not None:
                for pid, row in rows.items():
                    image = row.get("ExecutablePath")
                    if image and Path(image).resolve() == root/"AgentHub.RuntimeHost.exe" and (
                            pid != expected_host["pid"] or int(row["Created"])//10 != int(expected_host["created"])//10):
                        raise RetirementScopeChanged("Selected native Host changed before retirement")
            return rows
        finally:
            metrics["snapshotCalls"] += 1
            metrics["snapshotMs"] += (time.monotonic()-before)*1000
    def emit(outcome):
        if trace:
            trace(dict(stage="stop-selected", outcome=outcome, **metrics,
                       elapsedMs=(time.monotonic()-started)*1000, retired=len(records)))
    def native_failure(pid,handle,identity,error):
        if trace:
            trace(dict(stage="native-error",pid=pid,handle=int(handle),**identity,
                       nativeOperation=getattr(error,"native_operation","OpenProcess"),
                       winerror=getattr(error,"winerror",None),handleState=k.WaitForSingleObject(handle,0)))
    try:
        # Root discovery is version independent; descendants are captured before
        # parents are stopped. A foreign Hub root cuts off that branch.
        while True:
            bypid = snapshot()
            for pid, (handle, _) in list(retained.items()):
                if process_exited(handle) or pid not in authorized:
                    k.CloseHandle(handle); del retained[pid]
            wanted = {pid for pid, row in bypid.items() if selected_process(row, root)}
            edges = {}
            for pid, item in retained.items():
                if not process_exited(item[0]): wanted.add(pid)
            changed = True
            while changed:
                changed = False
                for pid, row in bypid.items():
                    if pid in wanted or int(row["ParentProcessId"]) not in wanted: continue
                    parent_pid = int(row["ParentProcessId"])
                    parent_row = bypid.get(parent_pid)
                    if not parent_row or not descendant_birth_matches(parent_row, row): continue
                    if foreign_hub_installation(row, root):
                        # Killing a Host can close its kill-on-close Job. Do
                        # not silently prune another Hub then kill its parent.
                        raise RuntimeError("Another Hub installation is nested in the selected process tree")
                    edges[pid] = (parent_pid, parent_row["Created"])
                    wanted.add(pid); changed = True
            if inspect_only:
                if wanted: raise RuntimeError("Selected runtime still has live processes")
                return []
            if os.getpid() in wanted:
                raise RuntimeError("Installer is still in the selected process tree")
            before = time.monotonic()
            def depth(pid):
                seen=set(); current=pid
                while current in wanted:
                    if current in seen: raise RuntimeError("Selected process ancestry has a cycle")
                    seen.add(current)
                    row=bypid.get(current) or known_rows.get(current)
                    if not row: break
                    parent_pid = int(row["ParentProcessId"])
                    parent = bypid.get(parent_pid) or known_rows.get(parent_pid)
                    # A reused PID can point to a younger process in this same tree.
                    if parent_pid not in wanted or not parent or not descendant_birth_matches(parent, row):
                        break
                    current = parent_pid
                return len(seen)
            for pid in sorted(wanted,key=depth):
                budget()
                if pid in retained: continue
                handle = k.OpenProcess(0x1000 | 0x100000 | 1, False, pid)
                if not handle:
                    if c.get_last_error() == 87: continue
                    raise native_process_error(c.get_last_error(),"OpenProcess")
                try:
                    row = bypid.get(pid)
                    created=process_birth(handle)
                    if not row or int(row.get("Created") or 0)//10 != int(created)//10:
                        raise RuntimeError("Selected process image changed during capture")
                    if process_exited(handle):
                        # A terminal ancestor still binds the original birth.
                        # Its image is never used to authorize a live effect.
                        identity=dict(created=created,image=str(Path(row.get("ExecutablePath") or "").resolve()))
                    else:
                        try: identity = process_identity(handle)
                        except OSError as error:
                            native_failure(pid,handle,dict(created=created),error)
                            if not process_exited(handle): raise
                            identity=dict(created=created,image=str(Path(row.get("ExecutablePath") or "").resolve()))
                        if not process_exited(handle) and (not row.get("ExecutablePath")
                                or Path(row["ExecutablePath"]).resolve() != Path(identity["image"])):
                            raise RuntimeError("Selected process image changed during capture")
                    retained[pid] = (handle, identity)
                    known_rows[pid] = row
                except OSError:
                    exited = process_exited(handle)
                    if pid not in retained: k.CloseHandle(handle)
                    if exited: continue
                    raise
                except BaseException:
                    if pid not in retained: k.CloseHandle(handle)
                    raise
            metrics["captureMs"] += (time.monotonic()-before)*1000
            metrics["captured"] = max(metrics["captured"],len(retained))
            # One fresh discovery for the complete batch, while every original
            # native handle is retained. Never query all WMI processes per PID.
            fresh = snapshot() if retained else {}
            for pid, (handle, _) in retained.items():
                budget()
                if process_exited(handle): continue
                if fresh.get(pid) != bypid.get(pid):
                    raise RuntimeError("Selected process image changed during capture")
            # Every discovered edge must also bind the captured native parent,
            # not just an integer PPID from discovery. A reused/missing parent
            # never grants authority over its alleged children.
            for pid, (parent_pid, parent_created) in edges.items():
                parent = retained.get(parent_pid)
                child = retained.get(pid)
                if not child or process_exited(child[0]): continue
                if (not parent or int(parent[1]["created"])//10 != int(parent_created)//10):
                    if trace:
                        trace(dict(stage="parent-binding-error",pid=pid,parentPid=parent_pid,
                            parentCreated=parent_created,parentRetained=bool(parent),
                            childHandleState=k.WaitForSingleObject(child[0],0)))
                    raise RuntimeError("Selected descendant parent identity changed")
                try: native_parent=process_parent(child[0])
                except RuntimeError:
                    if process_exited(child[0]): continue
                    raise
                if native_parent != parent_pid and not process_exited(child[0]):
                    raise RuntimeError("Selected native parent differs from discovery")
            live = [(pid, h, identity) for pid, (h, identity) in retained.items() if not process_exited(h)]
            if not live:
                emit("stopped"); return records
            budget()
            if capture:
                capture([dict(pid=pid,**identity,parentPid=int(known_rows[pid]["ParentProcessId"]),
                              parentCreated=edges.get(pid,(None,None))[1]) for pid,_,identity in live])
            authorized.update(pid for pid,_,_ in live)
            before = time.monotonic()
            pending={}
            for pid, handle, identity in sorted(live,key=lambda item:depth(item[0]),reverse=True):
                budget()
                try: records.append(terminate_retained(pid,handle,identity))
                except OSError as error:
                    native_failure(pid,handle,identity,error)
                    if getattr(error,"winerror",None) not in (5,31): raise
                    # Rundown may deny image/termination before final signalling.
                    # Complete other authorized targets, then wait on this same
                    # object. An error code alone never completes retirement.
                    pending[pid]=error
            metrics["terminateMs"] += (time.monotonic()-before)*1000
            before = time.monotonic()
            for pid, handle, identity in live:
                budget()
                timeout = min(10000,max(0,int((deadline-time.monotonic())*1000)))
                state=k.WaitForSingleObject(handle, timeout)
                if state != 0:
                    if pid in pending:
                        native_failure(pid,handle,identity,pending[pid]); raise pending[pid]
                    raise RuntimeError("Selected process did not exit")
                if pid in pending:
                    records.append(dict(pid=pid,**identity,alreadyExited=True,afterNativeError=pending[pid].winerror))
            metrics["waitMs"] += (time.monotonic()-before)*1000
    except BaseException:
        emit("failed")
        raise
    finally:
        if scope is None:
            for handle, _ in retained.values(): k.CloseHandle(handle)


PRESTOP_LEGACY_INSTALLER_SHA = "8c0937601384d3a67398dec48961d8bc08c87b2f3d21e4140cf0f6713cd6ae1f"
PARTIAL_STOP_INSTALLER_SHA = "d148831f858160ead70f98ed3e5ea6c478cf99b508daa049cbe2dac9e2b844f9"
PARTIAL_RETRY_INSTALLER_SHA = "a297c0b049fd59472b660ee2099eabbfea9dcd7e537d3f61286af99b8b82deab"


def verify_retired_worker(retained, pid):
    worker = _read_record(retained/"worker-started.json")
    dispatch = _read_record(retained/"dispatch.json")
    if worker["pid"] != pid or worker.get("outsideAllJobs") is not True or any(
            worker.get(key) != dispatch.get(key) for key in ["pid","created","image","outsideAllJobs"]):
        raise RuntimeError("Previous worker identity is not bound")
    c, _, k = native_api()
    handle = k.OpenProcess(0x1000|0x100000, False, pid)
    if handle:
        try:
            if not process_exited(handle):
                try:
                    current_created = process_birth(handle)
                except OSError:
                    if not process_exited(handle): raise
                else:
                    if current_created == worker["created"]:
                        raise RuntimeError("Previous installer worker is still live")
        finally:
            k.CloseHandle(handle)
    elif c.get_last_error() != 87:
        raise RuntimeError("Previous installer worker retirement is unknown")
    return worker


def previous_runtime_roots(root, release_id, entrypoint):
    # RuntimeHost passes the lexical launch root to Node. The wait admission
    # owner instead uses the configured data directory without realpath.
    if not entrypoint or not entrypoint.is_absolute():
        raise RuntimeError("Waiting Hub has no absolute native entry point")
    launch_root = entrypoint.parent
    if entrypoint.resolve().parent == root/"releases"/release_id:
        launch_root = entrypoint.parents[2]
    if not launch_root.samefile(root):
        raise RuntimeError("Waiting Hub launch root has different physical ownership")
    configured_data = _read_record(root/"config.json").get("dataDir")
    data = Path(os.path.abspath(launch_root/("data" if configured_data is None else configured_data)))
    if not data.samefile(root/"data") or not data.parent.samefile(root):
        raise RuntimeError("Waiting Hub data root has different physical ownership")
    return launch_root, data.parent


def ready_process_proof(root, previous, *, before_ms=None, with_roots=False):
    if (_read_record(root/"current.json").get("current") != previous["releaseId"]
            or file_hash(root/"releases"/previous["releaseId"]/"runtime-manifest.json") != previous["manifestSha256"]):
        raise RuntimeError("Previous installation changed")
    lock = _read_record(root/"data/bot.lock")
    if lock.get("ready") is not True or lock.get("releaseId") != previous["releaseId"]:
        raise RuntimeError("Previous instance is not Ready")
    rows = process_snapshot(); node = next((x for x in rows if x["ProcessId"] == lock["pid"]), None)
    host = next((x for x in rows if node and x["ProcessId"] == node["ParentProcessId"]), None)
    c, _, k = native_api(); proof = []
    for row in [host,node]:
        if not row or not selected_process(row,root): raise RuntimeError("Previous Host/Node ownership changed")
        handle = k.OpenProcess(0x1000|0x100000,False,row["ProcessId"])
        if not handle: raise RuntimeError("Previous Host/Node is not live")
        try:
            identity = process_identity(handle)
            if (process_exited(handle) or int(identity["created"])//10 != int(row["Created"])//10
                    or Path(identity["image"]) != Path(row["ExecutablePath"]).resolve()):
                raise RuntimeError("Previous process identity changed")
            if before_ms is not None and (int(identity["created"])-116444736000000000)/10000 >= before_ms:
                raise RuntimeError("Old process does not predate the original admission")
            proof.append(dict(pid=row["ProcessId"],**identity))
        finally: k.CloseHandle(handle)
    if Path(proof[0]["image"]) != root/"AgentHub.RuntimeHost.exe":
        raise RuntimeError("Previous native Host identity differs")
    if with_roots:
        return proof, previous_runtime_roots(root, previous["releaseId"], node_entrypoint(node))
    return proof


def selected_runtime_job_scope(root, worker):
    """Bind the named Job to the actual Ready Host and its Node before relying on it."""
    release_id = _read_record(root/"current.json").get("current")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", release_id or ""):
        raise RuntimeError("Selected runtime release is unavailable for Job verification")
    previous = dict(releaseId=release_id,
                    manifestSha256=file_hash(root/"releases"/release_id/"runtime-manifest.json"))
    host, node = ready_process_proof(root, previous)
    c, _, k = native_api()
    job = k.OpenJobObjectW(4, False, f"Local\\IIITYRAELIII.AgentHub.{host['pid']}")
    if not job:
        raise RuntimeError("Selected runtime Job is unavailable; independence unproved")
    try:
        for entry in (host, node):
            handle = k.OpenProcess(0x1000 | 0x100000, False, entry["pid"])
            if not handle:
                raise c.WinError(c.get_last_error())
            try:
                if (process_exited(handle) or root_process_identity(entry["pid"], handle) != entry
                        or outside_jobs(handle, job)
                        or (entry is node and process_parent(handle) != host["pid"])):
                    raise RuntimeError("Selected runtime Job or process identity changed")
            finally:
                k.CloseHandle(handle)
        if not outside_jobs(worker, job):
            raise RuntimeError("Installer worker belongs to the selected runtime Job; independence unproved")
    finally:
        k.CloseHandle(job)
    return dict(kind="selected-runtime-job-v1", host=host, node=node, **previous)


def root_process_identity(pid, handle):
    return dict(pid=pid, **process_identity(handle))


def verified_worker_scope(root, cache, handle):
    identity = root_process_identity(os.getpid(), handle)
    if outside_jobs(handle):
        return dict(**identity, outsideAllJobs=True)
    proof = _read_record(cache/"worker-verified-suspended.json")
    live_scope = selected_runtime_job_scope(root, handle)
    if (any(proof.get(key) != value for key, value in identity.items())
            or proof.get("outsideAllJobs") is not False
            or proof.get("retirementScope") != live_scope):
        raise RuntimeError("Selected runtime Job dispatch proof changed")
    return dict(**identity, outsideAllJobs=False, retirementScope=live_scope)


def verify_partial_stop_resume(root, retained, original):
    """Continue admitted partial retirement, preserving its unknown effects."""
    if original.get("revision") == 5:
        return verify_partial_retry_resume(root, retained, original)
    if (original.get("kind") != "restart" or original.get("streamId") != "agent-hub-installer"
            or Path(original.get("threadId", "")).resolve() != root
            or (original.get("status"),original.get("phase"),original.get("outcome"),original.get("revision"))
            != ("reconciling","installer-stopping","unknown",3)):
        raise RuntimeError("Original is not the bound partial-stop continuation")
    metadata = original.get("metadata", {})
    if set(metadata) != {"autonomousInstaller","autonomousError","autonomousResume"}:
        raise RuntimeError("Original has different or later effects")
    resume = metadata["autonomousResume"]; binding = metadata["autonomousInstaller"]
    request = _read_record(retained/"request.json")
    proof = _read_record(retained/"input-resume-prestop.json")
    if (resume.get("installerSha256") != PARTIAL_STOP_INSTALLER_SHA
            or request.get("installerSha256") != PARTIAL_STOP_INSTALLER_SHA
            or file_hash(retained/"install_release.py") != PARTIAL_STOP_INSTALLER_SHA
            or original["operationId"] != request.get("operationId")
            or Path(request["runtimeRoot"]).resolve() != root
            or _directory_identity(root) != request["runtimeIdentity"]
            or file_hash(Path(request["archive"])) != binding["archiveSha256"]
            or request["sha256"] != binding["archiveSha256"]
            or metadata["autonomousInstaller"] != proof["expectedOriginal"]["metadata"]["autonomousInstaller"]
            or metadata["autonomousError"] != proof["expectedOriginal"]["metadata"]["autonomousError"]
            or resume != {**proof,"workerPid":resume.get("workerPid")}):
        raise RuntimeError("Partial-stop original or retained input changed")
    prior = Path(resume["priorCache"])
    if (retained != prior/("resume-"+PARTIAL_STOP_INSTALLER_SHA[:16])
            or file_hash(prior/"request.json") != resume["priorRequestSha256"]
            or file_hash(prior/"install_release.py") != PRESTOP_LEGACY_INSTALLER_SHA
            or request.get("resume") != dict(cache=str(prior),original=resume["expectedOriginal"])):
        raise RuntimeError("Partial-stop previous history changed")
    if any((retained/name).exists() for name in ["backup","retired.json","input-backup.json","install.stdout",
            "install.stderr","launch-intent.json","recovery-launch-intent.json","result.json"]):
        raise RuntimeError("Partial-stop has admitted later boundaries")
    failure = _read_record(retained/"failure.json")
    if (failure.get("code") != "PermissionError" or failure.get("effectsAdmitted") is not True
            or not str(failure.get("diagnostic", "")).startswith("[WinError 5]")):
        raise RuntimeError("Partial-stop failure is not the bound native refusal")
    old_worker = verify_retired_worker(retained,resume["workerPid"])
    old_original_worker = verify_retired_worker(prior,binding["workerPid"])
    processes = ready_process_proof(root,binding["previous"])
    return dict(expectedOriginal=original,oldProcesses=processes,previous=binding["previous"],
                priorCache=str(retained),priorRequestSha256=file_hash(retained/"request.json"),
                oldWorker=old_worker,originalWorker=old_original_worker,partialEffectsRetained=True,
                installerSha256=file_hash(Path(__file__).resolve()),python=sys.executable,
                installer=str(Path(__file__).resolve()))


def verify_partial_retry_resume(root, retained, original):
    """Continue the pinned a297 partial retirement before its first backup."""
    if (original.get("kind") != "restart" or original.get("streamId") != "agent-hub-installer"
            or Path(original.get("threadId", "")).resolve() != root
            or (original.get("status"),original.get("phase"),original.get("outcome"),original.get("revision"))
            != ("reconciling","installer-recovery-required","unknown",5)):
        raise RuntimeError("Original is not the bound a297 partial-stop failure")
    metadata = original.get("metadata", {})
    if set(metadata) != {"autonomousInstaller","autonomousError","autonomousResume","autonomousPartialResume"}:
        raise RuntimeError("Partial retry has different or later effects")
    partial = metadata["autonomousPartialResume"]
    request = _read_record(retained/"request.json")
    proof = _read_record(retained/"input-resume-partialstop.json")
    expected_error = {"code":"RuntimeError","diagnostic":"Selected descendant parent identity changed"}
    if (metadata["autonomousError"] != expected_error
            or partial.get("installerSha256") != PARTIAL_RETRY_INSTALLER_SHA
            or request.get("installerSha256") != PARTIAL_RETRY_INSTALLER_SHA
            or file_hash(retained/"install_release.py") != PARTIAL_RETRY_INSTALLER_SHA
            or request.get("operationId") != original.get("operationId")
            or Path(request["runtimeRoot"]).resolve() != root
            or request["runtimeIdentity"] != _directory_identity(root)
            or request.get("resumePartial") != {"cache":partial["priorCache"],"original":partial["expectedOriginal"]}
            or partial != {**proof,"workerPid":partial["workerPid"]}
            or metadata["autonomousInstaller"] != partial["expectedOriginal"]["metadata"]["autonomousInstaller"]
            or metadata["autonomousResume"] != partial["expectedOriginal"]["metadata"]["autonomousResume"]):
        raise RuntimeError("Partial retry history or input changed")
    prior = Path(partial["priorCache"])
    if (retained != prior/("resume-partial-"+PARTIAL_RETRY_INSTALLER_SHA[:16])
            or file_hash(prior/"request.json") != partial["priorRequestSha256"]):
        raise RuntimeError("Partial retry cache binding changed")
    if any((retained/name).exists() for name in ["backup","retired.json","input-backup.json","install.stdout",
            "install.stderr","launch-intent.json","recovery-launch-intent.json","result.json"]):
        raise RuntimeError("Partial retry has admitted later boundaries")
    if _read_record(retained/"failure.json") != {**expected_error,"effectsAdmitted":True}:
        raise RuntimeError("Partial retry failure differs")
    previous_proof = verify_partial_stop_resume(root, prior, partial["expectedOriginal"])
    binding = metadata["autonomousInstaller"]
    if request.get("sha256") != binding["archiveSha256"] or file_hash(Path(request["archive"])) != binding["archiveSha256"]:
        raise RuntimeError("Partial retry archive changed")
    worker = verify_retired_worker(retained, partial["workerPid"])
    return dict(expectedOriginal=original,oldProcesses=previous_proof["oldProcesses"],previous=binding["previous"],
                priorCache=str(retained),priorRequestSha256=file_hash(retained/"request.json"),oldWorker=worker,
                partialEffectsRetained=True,installerSha256=file_hash(Path(__file__).resolve()),
                python=sys.executable,installer=str(Path(__file__).resolve()))


def verify_pre_stop_resume(root, retained, original):
    """Positive proof for the one published pre-capture refusal, not UNKNOWN=none."""
    from datetime import datetime
    if original.get("kind") != "restart" or original.get("streamId") != "agent-hub-installer" or Path(original.get("threadId", "")).resolve() != root:
        raise RuntimeError("Original installer scope differs")
    if (original.get("status"), original.get("phase"), original.get("outcome"), original.get("revision")) != ("reconciling", "installer-recovery-required", "unknown", 2):
        raise RuntimeError("Original is not the exact pre-stop refusal")
    metadata = original.get("metadata", {})
    if set(metadata) != {"autonomousInstaller", "autonomousError"} or metadata["autonomousError"] != {
        "code": "RuntimeError", "diagnostic": "Another Hub installation is nested in the selected process tree"}:
        raise RuntimeError("Original has different or later effects")
    binding = metadata["autonomousInstaller"]
    old_request = _read_record(retained/"request.json")
    if (old_request.get("operationId") != original["operationId"] or Path(old_request["runtimeRoot"]).resolve() != root
            or _directory_identity(root) != old_request["runtimeIdentity"]
            or binding.get("installerSha256") != PRESTOP_LEGACY_INSTALLER_SHA
            or file_hash(retained/"install_release.py") != PRESTOP_LEGACY_INSTALLER_SHA
            or binding["archiveSha256"] != file_hash(Path(old_request["archive"]))):
        raise RuntimeError("Retained pre-stop input differs")
    if any((retained/name).exists() for name in ["backup", "retired.json", "install.stdout", "install.stderr", "launch-intent.json", "recovery-launch-intent.json", "result.json"]):
        raise RuntimeError("Original has admitted later boundaries")
    failure = _read_record(retained/"failure.json")
    if failure.get("code") != "RuntimeError" or failure.get("diagnostic") != metadata["autonomousError"]["diagnostic"] or failure.get("effectsAdmitted") is not True:
        raise RuntimeError("Retained failure is not the bound pre-stop refusal")
    old_worker = verify_retired_worker(retained,binding["workerPid"])
    previous = binding["previous"]
    admission_ms = datetime.fromisoformat(original["createdAt"].replace("Z", "+00:00")).timestamp()*1000
    proof = ready_process_proof(root,previous,before_ms=admission_ms)
    return dict(expectedOriginal=original, oldProcesses=proof, previous=previous,
                priorRequestSha256=file_hash(retained/"request.json"), priorCache=str(retained),
                oldWorker=old_worker, installerSha256=file_hash(Path(__file__).resolve()),
                python=sys.executable,installer=str(Path(__file__).resolve()))


def assert_listener_owner(pid, host, port):
    if host not in ("127.0.0.1", "::1", "localhost") or not 1 <= int(port) <= 65535:
        raise RuntimeError("Invalid configured local web endpoint")
    script = ("Get-NetTCPConnection -State Listen -LocalPort "+str(int(port))
              +" -ErrorAction Stop | Select-Object LocalAddress,OwningProcess | ConvertTo-Json -Compress")
    result = subprocess.run(["powershell.exe","-NoProfile","-NonInteractive","-Command",script],
                            check=True,capture_output=True,encoding="utf-8",creationflags=0x08000000)
    rows = json.loads(result.stdout)
    if isinstance(rows,dict): rows = [rows]
    addresses = {"127.0.0.1","::1"} if host == "localhost" else {host}
    owners = {int(row["OwningProcess"]) for row in rows if row["LocalAddress"] in addresses}
    if owners != {int(pid)}:
        raise RuntimeError("Configured web listener is not owned by the verified Node")


def assert_launched(root, pid, created, web=None):
    c, w, k = native_api(); handle = k.OpenProcess(0x1000 | 0x100000, False, pid)
    if not handle: raise RuntimeError("New Host exited before Ready")
    try:
        identity = process_identity(handle)
        if identity["created"] != created or Path(identity["image"]) != root/"AgentHub.RuntimeHost.exe" or k.WaitForSingleObject(handle,0)!=258:
            raise RuntimeError("New Host identity changed before Ready")
        lock = _read_record(root/"data/bot.lock")
        row = next((r for r in process_snapshot() if int(r["ProcessId"])==lock.get("pid")),None)
        if not row or int(row["ParentProcessId"])!=pid or not selected_process(row,root):
            raise RuntimeError("Ready Node is not the launched Host child")
        if web is not None:
            if web["pid"] != lock["pid"]: raise RuntimeError("Web readiness Node differs")
            assert_listener_owner(web["pid"],web["host"],web["port"])
    finally: k.CloseHandle(handle)


INSTALL_MODES = {"wait": "Дождаться текущих ходов", "force": "Завершить все ходы"}


def choose_install_mode(value, chooser=None):
    if value is not None:
        if value not in INSTALL_MODES: raise ValueError("Unknown installation mode")
        return value
    if chooser is not None:
        value = chooser()
        if value not in INSTALL_MODES: raise ValueError("Installation mode was not selected")
        return value
    if not sys.stdin.isatty():
        raise ValueError("Choose --mode wait (Дождаться текущих ходов) or --mode force (Завершить все ходы)")
    import tkinter as tk
    window = tk.Tk(); window.title("Обновление Agent Hub")
    selected = []
    tk.Label(window, text="Как остановить выбранную установку перед обновлением?", padx=24, pady=16).pack()
    def select(mode):
        selected.append(mode); window.destroy()
    for mode, label in INSTALL_MODES.items():
        tk.Button(window, text=label, command=lambda mode=mode: select(mode), width=38, pady=8).pack(padx=24, pady=6)
    window.mainloop()
    if not selected: raise ValueError("Installation mode was not selected; update not dispatched")
    return selected[0]


def wait_for_current_turns(probe, operation_id, expected, record=lambda value: None, delay=time.sleep):
    """Observe the existing run/admission owner; never infer idle from failure."""
    while True:
        health = probe()
        state = health.get("installerCutover") or {}
        if (not health.get("live") or not health.get("ready") or health.get("process") != expected
                or state.get("protocol") != 1 or state.get("operationId") != operation_id
                or state.get("mode") != "wait" or state.get("admissionClosed") is not True):
            raise RuntimeError("Cannot confirm waiting installation identity/admission; no force stop authorized")
        counts = [state.get("activeCount"), state.get("unknownCount")]
        if any(type(count) is not int or count < 0 for count in counts) or type(state.get("pendingAdmission")) is not bool:
            raise RuntimeError("Current turn state is unavailable; select force explicitly if interruption is wanted")
        record(state)
        if state["unknownCount"]:
            raise RuntimeError("Current turn activity is unknown; wait cannot become force")
        if not state["activeCount"] and not state["pendingAdmission"]: return state
        delay(1)


OWNER_MODULE = r'''
import path from 'node:path';
import fs from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const [pkg,root,id,action,input] = process.argv.slice(2);
const load = p => import(pathToFileURL(path.join(pkg,'runtime',p)).href);
if(action==='previous') {
  const pointer=JSON.parse(await fs.readFile(path.join(root,'current.json'),'utf8'));
  const {verifyRuntimeManifest}=await load('src/infrastructure/filesystem/runtime-manifest-verifier.mjs');
  await verifyRuntimeManifest(path.join(root,'releases',pointer.current),pointer.current);
  const {createHash}=await import('node:crypto');
  const manifest=await fs.readFile(path.join(root,'releases',pointer.current,'runtime-manifest.json'));
  console.log(JSON.stringify({releaseId:pointer.current,manifestSha256:createHash('sha256').update(manifest).digest('hex')}));
  process.exit(0);
}
if(action==='codex-preflight') {
  try {
    process.env.AGENT_HUB_CONFIG=path.join(root,'config.json');
    process.env.AGENT_HUB_RUNTIME_ROOT=root;
    const {loadConfig}=await load('src/infrastructure/filesystem/config.mjs');
    const {CodexExecutableUpdateService}=await load('src/infrastructure/process/codex-executable-update-service.mjs');
    const config=await loadConfig();
    const selector=new CodexExecutableUpdateService({stateFile:path.join(config.dataDir,'codex-executable-state.json'),
      requestedExecutable:config.codexExecutable, autoUpdateEnabled:config.codexExecutableAutoUpdate,
      versionPin:config.codexExecutableVersionPin, executableArgs:config.codexExecutableArgs,
      runCanary:()=>{throw Error('Pre-stop inspection cannot launch a compatibility canary');}});
    console.log(JSON.stringify(await selector.inspectUpgradeReadiness()));
  } catch {
    // An inconclusive observation cannot replace the installed runtime's checks.
    console.log(JSON.stringify({status:'unchecked',reason:'inspection-inconclusive'}));
  }
  process.exit(0);
}
const {MaintenanceOperationStore} = await load('src/infrastructure/persistence/maintenance-operation-store.mjs');
const store = new MaintenanceOperationStore({dataDir:path.join(root,'data')});
// A live replacement shares SQLite with the installer. Contention must wait
// for this SAME persistence call, never become a reason to reinstall/rollback.
const mutate = async fn => store.runMaintenanceMutation(fn,{requestId:id,timeoutMs:Number.POSITIVE_INFINITY,
  recordMutationTiming:timing=>{
    appendFileSync(path.join(path.dirname(process.argv[1]),'stop-timing.jsonl'),
      JSON.stringify({operationId:id,stage:'owner-'+action+'-persistence',...timing})+'\n');
  }});
let op = await mutate(()=>store.get(id)); const value = input ? JSON.parse(await fs.readFile(input,'utf8')) : {};
async function storageCheckpoint() {
  let storage;
  try { storage = await load('src/infrastructure/persistence/autonomous-installer-storage.mjs'); }
  catch(error) { if(error.code==='ERR_MODULE_NOT_FOUND') return {autonomousStorageUnavailable:true}; throw error; }
  try {
    return {autonomousStorage:await storage.sealAutonomousInstallerStorage({runtimeRoot:root,operation:op,cache:path.dirname(process.argv[1])})};
  } catch(error) {
    // Failure to prove cleanup never changes the update/recovery outcome.
    return {autonomousStorageUnavailable:true};
  }
}
async function storageWake() {
  try {
    const storage=await load('src/infrastructure/persistence/autonomous-installer-storage.mjs');
    const {withStorageRetentionLease}=await load('src/composition/storage-retention-composition.mjs');
    await withStorageRetentionLease(path.join(root,'data'),()=>storage.wakeInstallerRetention(store));
  }
  catch { /* Periodic owner discovery retains its normal fallback cadence. */ }
}
async function assertReadyEndpoint(health, releaseId, hostPid, hostCreated) {
  if(!health?.live || !health?.ready || health.process?.releaseId!==releaseId)
    throw Error('Expected live Ready release');
  const args=[value.installer,'--assert-launch',root,String(hostPid),hostCreated];
  const web=health.capabilities?.find(item=>item.name==='mini_app');
  if(!web) throw Error('Configured web capability is unknown');
  if(web.state!=='disabled') {
    if(web.state!=='ready') throw Error('Configured web capability is not ready');
    const raw=JSON.parse(await fs.readFile(path.join(root,'config.json'),'utf8'));
    const {miniAppSettings}=await load('src/infrastructure/filesystem/config.mjs');
    const settings=miniAppSettings(raw.miniApp,{configDirectory:root});
    args.push(JSON.stringify({pid:health.process.pid,host:settings.host,port:settings.port}));
  }
  execFileSync(value.python,args,{windowsHide:true,stdio:'pipe'});
}
if(action==='wait-probe') {
  const {callDesktopControl}=await load('src/infrastructure/process/desktop-control.mjs');
  console.log(JSON.stringify(await callDesktopControl('runtime-health',{}, {runtimeRoot:root,timeoutMs:5000})));
  process.exit(0);
} else if(action==='codex-preflight-blocked') {
  const {isCodexPreflightRejectionMessage}=await load('src/infrastructure/process/codex-executable.mjs');
  if(!op || op.status!=='running' || !['installer-waiting','installer-stopping'].includes(op.phase)
     || !op.metadata?.autonomousInstaller || value.status!=='blocked'
     || !['pin-unavailable','no-eligible-trusted-codex','automatic-update-disabled'].includes(value.reason)
     || !isCodexPreflightRejectionMessage(value.rejection)) throw Error('Invalid Codex pre-stop refusal');
  const changed=await mutate(()=>store.transition(id,{status:'failed',outcome:'codex-preflight-refused',
    phase:'codex-preflight-blocked',metadata:{autonomousCodexPreflight:{status:value.status,reason:value.reason,rejection:value.rejection}}},
    {expectedRevision:op.revision}));
  if(!changed.applied) throw Error('Codex pre-stop checkpoint changed'); op=changed.operation;
} else if(action==='wait-failed') {
  if(!op || op.phase!=='installer-waiting' || op.metadata?.autonomousInstaller?.mode!=='wait')
    throw Error('Not a pre-stop waiting original');
  const changed=await mutate(()=>store.transition(id,{status:'failed',outcome:'wait-refused',phase:'installer-wait-refused',
    metadata:{autonomousWaitError:value}},{expectedRevision:op.revision}));
  if(!changed.applied) throw Error('Waiting refusal checkpoint changed'); op=changed.operation;
} else if(action==='wait-complete') {
  if(!op || op.phase!=='installer-waiting' || op.metadata?.autonomousInstaller?.mode!=='wait')
    throw Error('Not a waiting original');
  if(process.platform==='win32' && (await fs.realpath(op.metadata.autonomousInstaller.runtimeRoot)).toLowerCase()!==root.toLowerCase())
    throw Error('Waiting admission root changed before stopping');
  const changed=await mutate(()=>store.transition(id,{phase:'installer-stopping',metadata:{autonomousWait:value}},
    {expectedRevision:op.revision}));
  if(!changed.applied) throw Error('Waiting checkpoint changed'); op=changed.operation;
} else if(action==='create') {
  if(value.physicalRuntimeRoot!==undefined && (value.mode!=='wait'
     || value.physicalRuntimeRoot!==root
     || (await fs.realpath(value.runtimeRoot)).toLowerCase()!==root.toLowerCase()))
    throw Error('Waiting admission root is outside the selected runtime');
  if(!op) op=await mutate(()=>store.create({operationId:id,kind:'restart',streamId:'agent-hub-installer',
    threadId:value.mode && process.platform==='win32'?(value.physicalRuntimeRoot ? value.runtimeRoot : root).toLowerCase():root,
    status:'running',phase:value.mode==='wait'?'installer-waiting':'installer-stopping',metadata:{autonomousInstaller:value}}));
} else if(action==='resume-prestop' || action==='resume-partialstop') {
  const {isDeepStrictEqual}=await import('node:util');
  if(!isDeepStrictEqual(op,value.expectedOriginal)) throw Error('Original changed before resume CAS');
  const {callDesktopControl}=await load('src/infrastructure/process/desktop-control.mjs');
  const health=await callDesktopControl('runtime-health',{}, {runtimeRoot:root,timeoutMs:5000});
  if(!health.live || !health.ready || health.process.pid!==value.oldProcesses[1].pid
    || health.process.releaseId!==value.previous.releaseId) throw Error('Old Ready identity changed');
  await assertReadyEndpoint(health,value.previous.releaseId,value.oldProcesses[0].pid,value.oldProcesses[0].created);
  const key=action==='resume-prestop'?'autonomousResume':'autonomousPartialResume';
  const changed=await mutate(()=>store.transition(id,{phase:'installer-stopping',metadata:{[key]:{...value,workerPid:process.ppid}}},{expectedRevision:op.revision}));
  if(!changed.applied) throw Error('Pre-stop continuation CAS refused'); op=changed.operation;
} else if(action==='backup') {
  const {backupStoppedRuntime}=await load('src/infrastructure/persistence/runtime-maintenance-backup.mjs');
  const proof=await backupStoppedRuntime({runtimeRoot:root,destination:value.destination,
    onCreated:async scope=>{
      const {installerBackupIntent}=await load('src/infrastructure/persistence/autonomous-installer-storage.mjs');
      const attempt=await installerBackupIntent(scope);
      const saved=await mutate(()=>store.transition(id,{metadata:{autonomousBackupAttempt:attempt}},{expectedRevision:op.revision}));
      if(!saved.applied) throw Error('Backup creation checkpoint refused'); op=saved.operation;
    },
    assertStopped:async()=>execFileSync(value.python,[value.installer,'--assert-stopped',root],{windowsHide:true,stdio:'pipe'})});
  const {sealRuntimeUpdateBackup}=await load('src/infrastructure/persistence/runtime-update-backup-retention.mjs');
  const sealed=await sealRuntimeUpdateBackup(proof);
  const changed=await mutate(()=>store.transition(id,{phase:'installer-backed-up',metadata:{autonomousBackup:sealed}},{expectedRevision:op.revision}));
  if(!changed.applied) throw Error('Original backup checkpoint refused'); op=changed.operation;
} else if(action==='restore') {
  const {createHash}=await import('node:crypto');
  const pointer=JSON.parse(await fs.readFile(path.join(root,'current.json'),'utf8'));
  if(![value.previous.releaseId,value.targetReleaseId].includes(pointer.current)) throw Error('Current installation changed during recovery');
  const oldRoot=path.join(root,'releases',value.previous.releaseId);
  const manifest=await fs.readFile(path.join(oldRoot,'runtime-manifest.json'));
  if(createHash('sha256').update(manifest).digest('hex')!==value.previous.manifestSha256) throw Error('Previous version manifest changed');
  const {verifyRuntimeManifest}=await load('src/infrastructure/filesystem/runtime-manifest-verifier.mjs');
  await verifyRuntimeManifest(oldRoot,value.previous.releaseId);
  const {preserveRuntimeCommandsForRollback}=await load('src/infrastructure/process/runtime-command-rollback.mjs');
  execFileSync(value.python,[value.installer,'--assert-stopped',root],{windowsHide:true,stdio:'pipe'});
  const receiptHandoff=await preserveRuntimeCommandsForRollback({
    runtimeRoot:root,previousLaunchRoot:value.launchRoot,previousRoot:oldRoot,manifest:JSON.parse(manifest),
    readLegacyProjectRoot:async()=>{
      process.chdir(path.join(value.launchRoot,'releases',value.previous.releaseId));
      process.env.AGENT_HUB_CONFIG=path.join(value.launchRoot,'config.json');
      process.env.AGENT_HUB_RUNTIME_ROOT=value.launchRoot;
      const {loadConfig}=await import(pathToFileURL(path.join(oldRoot,'src/infrastructure/filesystem/config.mjs')));
      return (await loadConfig()).projectRoot;
    }});
  const {installPreparedRuntime}=await load('src/runtime/runtime-manager.mjs');
  await installPreparedRuntime({runtimeRoot:root,releaseId:value.previous.releaseId});
  console.log(JSON.stringify(receiptHandoff));
  process.exit(0);
} else if(action==='previous-ready') {
  const {callDesktopControl}=await load('src/infrastructure/process/desktop-control.mjs');
  const health=await callDesktopControl('runtime-health',{}, {runtimeRoot:root,timeoutMs:5000});
  if(!health.live || !health.ready || health.process.pid!==value.oldProcesses[1].pid
    || health.process.releaseId!==value.previous.releaseId) throw Error('Previous Ready identity changed');
  await assertReadyEndpoint(health,value.previous.releaseId,value.oldProcesses[0].pid,value.oldProcesses[0].created);
  const metadata={...await storageCheckpoint(),autonomousRecovery:{releaseId:value.previous.releaseId,pid:health.process.pid,
      hostPid:value.oldProcesses[0].pid,preservedRunning:true}};
  const changed=await mutate(()=>store.transition(id,{status:'failed',outcome:'rolled-back',phase:'previous-ready',metadata},{expectedRevision:op.revision}));
  if(!changed.applied) throw Error('Previous Ready checkpoint refused'); op=changed.operation;
  await storageWake();
} else if(action==='ready' || action==='recovered') {
  const {waitForRuntimeReplacement}=await load('src/runtime/publication-readiness.mjs');
  const {processIsAlive}=await load('src/infrastructure/process/process-liveness.mjs');
  const {callDesktopControl}=await load('src/infrastructure/process/desktop-control.mjs');
  let startupFailed=false, signatureRejection=null;
  try {
    await waitForRuntimeReplacement({runtimeRoot:root,expectedReleaseId:value.releaseId,timeoutMs:Number.POSITIVE_INFINITY,
      probe:async(...args)=>{
        const health=await callDesktopControl(...args);
        const diagnostic=health.diagnostics?.codexExecutableUpdate?.recordedSignatureRejection;
        if(action==='ready' && health.process?.releaseId===value.releaseId && typeof diagnostic==='string') {
          const {isCodexBundleSignatureRejectionMessage}=await load('src/infrastructure/process/codex-executable-bundle.mjs');
          if(isCodexBundleSignatureRejectionMessage(diagnostic)) signatureRejection=diagnostic;
        }
        startupFailed=health.capabilities?.some(item=>item.state==='failed' && (item.critical || item.name==='mini_app'))===true;
        return health;
      },
      now:()=>processIsAlive(value.hostPid) && !startupFailed?Date.now():Number.POSITIVE_INFINITY});
  } catch(error) {
    if(signatureRejection) {
      try { await mutate(()=>store.transition(id,{metadata:{autonomousCodexStartupRejection:signatureRejection}},
        {expectedRevision:op.revision})); }
      catch { /* Preserve the actual readiness failure and rollback route. */ }
    }
    throw error;
  }
  const health=await callDesktopControl('runtime-health',{}, {runtimeRoot:root,timeoutMs:10000});
  await assertReadyEndpoint(health,value.releaseId,value.hostPid,value.hostCreated);
  const lock=JSON.parse(await fs.readFile(path.join(root,'data/bot.lock'),'utf8'));
  const recovered=action==='recovered';
  const unresolved=recovered && value.retirementUnknown===true;
  let codexPreflight;
  if(value.codexPreflight?.status==='eligible' && typeof value.codexPreflight.rejection==='string') {
    const {isCodexPreflightRejectionMessage}=await load('src/infrastructure/process/codex-executable.mjs');
    const {isCodexBundleSignatureRejectionMessage}=await load('src/infrastructure/process/codex-executable-bundle.mjs');
    if(isCodexPreflightRejectionMessage(value.codexPreflight.rejection)
       || isCodexBundleSignatureRejectionMessage(value.codexPreflight.rejection))
      codexPreflight={status:'eligible',rejection:value.codexPreflight.rejection};
  }
  const metadata={...await storageCheckpoint(),...(signatureRejection?{autonomousCodexStartupRejection:signatureRejection}:{}),
    ...(codexPreflight?{autonomousCodexPreflight:codexPreflight}:{}),
    [recovered?'autonomousRecovery':'autonomousReady']:{releaseId:value.releaseId,pid:lock.pid,hostPid:value.hostPid,
      ...(unresolved?{retirementUnknown:true}: {})}};
  const changed=await mutate(()=>store.transition(id,{status:unresolved?'reconciling':recovered?'failed':'succeeded',outcome:unresolved?'unknown':recovered?'rolled-back':'succeeded',phase:recovered?'previous-ready':'ready',
    metadata},{expectedRevision:op.revision}));
  if(!changed.applied) throw Error('Original Ready checkpoint refused'); op=changed.operation;
  await storageWake();
} else if(action==='unknown') {
  if(op && !['succeeded','failed'].includes(op.status)) op=(await mutate(()=>store.transition(id,{status:'reconciling',outcome:'unknown',
    phase:'installer-recovery-required',metadata:{autonomousError:value}},{expectedRevision:op.revision}))).operation;
} else if(action!=='read') throw Error('Unknown installer owner action');
console.log(JSON.stringify(op));
'''


def clean_installer_environment():
    allowed = {"SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "PATH", "PATHEXT", "COMSPEC", "OS", "TEMP", "TMP",
               "USERPROFILE", "LOCALAPPDATA", "APPDATA", "USERNAME", "USERDOMAIN", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432"}
    result = {k: v for k, v in os.environ.items() if k.upper() in allowed}
    result.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    return result


def continuation_cache(scratch, root, operation_id, installer_sha256):
    # Canonical whole-row history and priorCache retain preceding attempts.
    # Recursively nesting their directories breaks SQLite's sidecar paths.
    identity = str(root)+'\0'+operation_id+'\0'+installer_sha256
    return scratch/('agenthub-resume-'+hashlib.sha256(identity.encode('utf-8')).hexdigest()[:32])


def autonomous_worker(request_file):
    request = _read_record(request_file); cache = request_file.parent
    _, _, k = native_api()
    root = Path(request["runtimeRoot"]); _plain_chain(root)
    if _directory_identity(root) != request["runtimeIdentity"]: raise RuntimeError("Selected runtime root changed")
    worker_handle = k.GetCurrentProcess()
    def recheck_job_scope():
        if job_scope is not None and selected_runtime_job_scope(root, worker_handle) != job_scope:
            raise RetirementScopeChanged("Selected runtime changed before retirement")
    lock = ExitStack()
    admitted = False; previous = None; install_started = False; descriptor = None
    waiting = False
    retirement_scope = {}
    replacement_host = None
    codex_preflight = None
    environment = clean_installer_environment()
    log = (cache/"worker.log").open("a", encoding="utf-8")
    def stage(name):
        print(time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime())+" "+name,file=log,flush=True)
    def stop_trace(value):
        with (cache/"stop-timing.jsonl").open("a",encoding="utf-8") as out:
            out.write(json.dumps(dict(operationId=request["operationId"],**value))+"\n")
    def stop_capture(value):
        with (cache/"stop-targets.jsonl").open("a",encoding="utf-8") as out:
            out.write(json.dumps(dict(operationId=request["operationId"],processes=value))+"\n")
            out.flush(); os.fsync(out.fileno())
    node = shutil.which("node"); package = cache/"verified"
    def owner(action, value=None):
        data = cache/("input-"+action+".json")
        if value is not None: _write_record(data,value)
        before = time.monotonic()
        result = subprocess.run([node,str(cache/"installer-owner.mjs"),str(package),str(root),request["operationId"],action,
                                 *([str(data)] if value is not None else [])],
                                check=False, capture_output=True,encoding="utf-8",env=environment,creationflags=0x08000000)
        stop_trace(dict(stage="owner-"+action,elapsedMs=(time.monotonic()-before)*1000,exitCode=result.returncode))
        if result.returncode:
            (cache/("owner-"+action+".stderr")).write_text(result.stderr,encoding="utf-8")
            raise RuntimeError("Installer owner "+action+" exited "+str(result.returncode))
        return json.loads(result.stdout)
    try:
        lock.enter_context(installer_runtime_mutex(root))
        worker_proof = verified_worker_scope(root, cache, worker_handle)
        job_scope = worker_proof.get("retirementScope")
        _write_record(cache/"worker-started.json",worker_proof)
        stage("verifying-package")
        archive = Path(request["archive"]) if request.get("archive") else None
        checksum = request.get("sha256")
        if request.get("release"):
            archive, tag, selected = fetch_release(request["release"],cache)
            if checksum and checksum != selected["sha256"]: raise ValueError("Additional package pin differs")
            checksum = selected["sha256"]
        descriptor = extract_verified(archive,checksum,package)
        if request.get("release"): verify_release_descriptor(descriptor,package,selected)
        if not node: raise RuntimeError("Node.js 22.5 or newer is required")
        subprocess.run([node,"-e","require('node:sqlite')"],check=True,capture_output=True,env=environment,creationflags=0x08000000)
        (cache/"installer-owner.mjs").write_text(OWNER_MODULE,encoding="utf-8")
        previous = owner("previous")
        if job_scope is not None and any(previous.get(key) != job_scope[key]
                                         for key in ("releaseId", "manifestSha256")):
            raise RuntimeError("Selected runtime changed before installation admission")
        _write_record(cache/"previous.json",previous)
        mode = request["mode"]
        if mode not in INSTALL_MODES: raise ValueError("Missing explicit installation mode")
        wait_process = None
        admission_root = root
        previous_launch_root = None
        previous_processes = None
        if mode == "wait":
            # Old APIs cannot promise a fenced drain. Never silently fall back
            # to force; keep the old Hub running and offer the explicit mode.
            support = owner("wait-probe")
            if (not support.get("live") or not support.get("ready")
                    or support.get("installerCutover",{}).get("protocol") != 1):
                raise RuntimeError("This Hub cannot confirm wait-current mode; choose --mode force explicitly")
            wait_process = support.get("process")
            previous_processes, (previous_launch_root, admission_root) = ready_process_proof(root,previous,with_roots=True)
            if not wait_process or wait_process.get("pid") != previous_processes[1]["pid"]:
                raise RuntimeError("Waiting endpoint is not the selected native Hub")
        else:
            try:
                previous_processes, (previous_launch_root, _) = ready_process_proof(root,previous,with_roots=True)
            except (OSError,RuntimeError,ValueError,KeyError):
                # Without a proven live launch address, only a positively
                # stopped installation can use the selected root for recovery.
                try: stop_selected(root,inspect_only=True)
                except (OSError,RuntimeError,ValueError,KeyError): pass
                else: previous_launch_root = root
        binding = dict(runtimeRoot=str(root),archiveSha256=file_hash(archive),releaseId=descriptor["releaseId"],previous=previous,
                       mode=mode,
                       installerSha256=request["installerSha256"],workerPid=os.getpid(),
                       packageManifestSha256=file_hash(package/"package-manifest.json"),
                       storageScope=dict(cache=_directory_identity(cache),worker=worker_proof,
                                         requestSha256=file_hash(request_file)))
        if admission_root != root:
            binding.update(runtimeRoot=str(admission_root),physicalRuntimeRoot=str(root))
        old = read_update_original(root,request["operationId"])
        if request.get("resumePartial"):
            if old != request["resumePartial"]["original"]: raise RuntimeError("Original changed before partial-stop continuation")
            proof = verify_partial_stop_resume(root,Path(request["resumePartial"]["cache"]),old)
            if previous != proof["previous"] or binding["archiveSha256"] != old["metadata"]["autonomousInstaller"]["archiveSha256"]:
                raise RuntimeError("Partial-stop continuation package changed")
            owner("resume-partialstop",proof)
        elif request.get("resume"):
            if old != request["resume"]["original"]: raise RuntimeError("Original changed before continuation")
            proof = verify_pre_stop_resume(root,Path(request["resume"]["cache"]),old)
            if previous != proof["previous"] or binding["archiveSha256"] != old["metadata"]["autonomousInstaller"]["archiveSha256"]:
                raise RuntimeError("Continuation package or previous release changed")
            owner("resume-prestop",proof)
        elif old is not None:
            stage("existing-original-read-only"); _write_record(cache/"result.json",original_status(request["operationId"],old)); return
        else:
            if mode != "wait":
                recheck_job_scope()
            op = owner("create",binding)
            if op["metadata"].get("autonomousInstaller") != binding: raise RuntimeError("Original installer binding differs")
        stage("checking-codex-before-stop")
        codex_preflight = owner("codex-preflight")
        _write_record(cache/"codex-preflight.json",codex_preflight)
        if codex_preflight.get("status") == "blocked":
            refused = owner("codex-preflight-blocked",codex_preflight)
            _write_record(cache/"result.json",refused)
            stage("codex-preflight-blocked")
            return
        if mode == "wait":
            waiting = True; stage("waiting-current-turns")
            settled = wait_for_current_turns(lambda: owner("wait-probe"),request["operationId"],wait_process,
                record=lambda state: stop_trace(dict(stage="waiting-current-turns",state=state)))
            proof, current_roots = ready_process_proof(root,previous,with_roots=True)
            if proof != previous_processes or current_roots != (previous_launch_root, admission_root):
                raise RuntimeError("Waiting Hub changed before stop")
            recheck_job_scope()
            owner("wait-complete",dict(process=wait_process,state=settled,oldProcesses=proof))
            waiting = False
        admitted = True; stage("stopping-selected-runtime")
        expected_previous_host = job_scope["host"] if job_scope is not None else (
            previous_processes[0] if previous_processes else None)
        stopped = stop_selected(root,trace=stop_trace,capture=stop_capture,scope=retirement_scope,
                                expected_host=expected_previous_host)
        _write_record(cache/"retired.json",dict(processes=stopped))
        stage("backing-up-durable-state")
        owner("backup",dict(destination=str(cache/"backup"),python=sys.executable,installer=str(Path(__file__).resolve())))
        stage("installing-verified-package")
        stop_selected(root,inspect_only=True)
        install_started = True
        with (cache/"install.stdout").open("w",encoding="utf-8") as out, (cache/"install.stderr").open("w",encoding="utf-8") as err:
            subprocess.run([node,str(package/"install-prepared.mjs"),"install",str(root)],check=True,
                           stdout=out,stderr=err,env=environment,creationflags=0x08000000)
        stage("starting-new-host")
        _write_record(cache/"launch-intent.json",dict(releaseId=descriptor["releaseId"],installerPid=os.getpid()))
        with (cache/"host.stdout").open("w",encoding="utf-8") as out, (cache/"host.stderr").open("w",encoding="utf-8") as err:
            host=subprocess.Popen([str(root/"AgentHub.RuntimeHost.exe")],cwd=str(root),env=environment,
                                  stdin=subprocess.DEVNULL,stdout=out,stderr=err,creationflags=0x08000000)
        replacement_host = root_process_identity(host.pid, int(host._handle))
        ready=owner("ready",dict(releaseId=descriptor["releaseId"],hostPid=host.pid,hostCreated=replacement_host["created"],
                                python=sys.executable,installer=str(Path(__file__).resolve()),codexPreflight=codex_preflight))
        _write_record(cache/"result.json",ready); stage("ready")
    except BaseException as error:
        stage("error "+type(error).__name__+": "+str(error))
        if waiting:
            # A failed observation is not permission to kill/restore a live Hub.
            owner("wait-failed",dict(code=type(error).__name__,diagnostic=str(error)[:1000]))
        if admitted and previous and not isinstance(error, RetirementScopeChanged):
            # The synchronous installer child is already joined. Retire only
            # this selected installation, restore verified prior code through
            # its existing installation owner, and leave all data in place.
            try:
                stage("restoring-previous-version")
                if not install_started:
                    try: still_ready = ready_process_proof(root,previous)
                    except (OSError,RuntimeError,ValueError,KeyError): still_ready = None
                    if still_ready:
                        restored=owner("previous-ready",dict(previous=previous,oldProcesses=still_ready,
                            python=sys.executable,installer=str(Path(__file__).resolve())))
                        _write_record(cache/"result.json",restored); stage("previous-version-still-ready"); return
                retirement_unknown = False
                try:
                    expected_host = (replacement_host or job_scope["host"]) if job_scope is not None else None
                    stop_selected(root,trace=stop_trace,capture=stop_capture,scope=retirement_scope,
                                  expected_host=expected_host)
                    stop_selected(root,inspect_only=True)
                except RetirementScopeChanged:
                    raise
                except (OSError,RuntimeError):
                    if install_started: raise
                    # No code installation was invoked. Availability can recover
                    # independently once Hub entry processes are absent. This
                    # grants no stopped-backup/install authority over survivors.
                    stop_selected(root,inspect_only=True)
                    retirement_unknown = True
                if previous_launch_root is None:
                    raise RuntimeError("Previous runtime lexical launch root could not be verified")
                if not previous_launch_root.samefile(root):
                    raise RuntimeError("Previous runtime launch root changed during recovery")
                if install_started:
                    handoff = owner("restore",dict(previous=previous,targetReleaseId=descriptor["releaseId"],
                        launchRoot=str(previous_launch_root),python=sys.executable,installer=str(Path(__file__).resolve())))
                    _write_record(cache/"recovery-command-receipts.json",handoff)
                elif owner("previous") != previous:
                    raise RuntimeError("Previous code changed before recovery launch")
                stop_selected(root,inspect_only=True)
                _write_record(cache/"recovery-launch-intent.json",previous)
                with (cache/"recovery.stdout").open("w",encoding="utf-8") as out, (cache/"recovery.stderr").open("w",encoding="utf-8") as err:
                    recovered_host=subprocess.Popen([str(previous_launch_root/"AgentHub.RuntimeHost.exe")],cwd=str(previous_launch_root),env=environment,
                        stdin=subprocess.DEVNULL,stdout=out,stderr=err,creationflags=0x08000000)
                restored=owner("recovered",dict(releaseId=previous["releaseId"],hostPid=recovered_host.pid,
                    hostCreated=process_identity(int(recovered_host._handle))["created"],python=sys.executable,
                    installer=str(Path(__file__).resolve()),retirementUnknown=retirement_unknown,codexPreflight=codex_preflight))
                _write_record(cache/"result.json",restored)
                stage("previous-version-ready")
                return
            except BaseException as recovery_error:
                stage("recovery-error "+str(recovery_error))
        if admitted:
            try: owner("unknown",dict(code=type(error).__name__,diagnostic=str(error)[:1000]))
            except BaseException as checkpoint_error: stage("checkpoint-error "+str(checkpoint_error))
        _write_record(cache/"failure.json",dict(code=type(error).__name__,diagnostic=str(error)[:1000],effectsAdmitted=admitted))
        raise
    finally:
        try:
            log.close()
            for handle,_ in retirement_scope.get("handles",{}).values(): k.CloseHandle(handle)
        finally:
            lock.close()


def autonomous_main():
    global sys
    import sys
    if len(sys.argv)>1 and sys.argv[1]=="--autonomous-worker":
        return autonomous_worker(Path(sys.argv[2]))
    if len(sys.argv)>1 and sys.argv[1]=="--assert-stopped":
        return stop_selected(Path(sys.argv[2]).resolve(),inspect_only=True)
    if len(sys.argv)>1 and sys.argv[1]=="--assert-launch":
        return assert_launched(Path(sys.argv[2]).resolve(),int(sys.argv[3]),sys.argv[4],
                               json.loads(sys.argv[5]) if len(sys.argv)>5 else None)
    parser=argparse.ArgumentParser(description="Autonomous AgentHub installer: verify, stop selected Hub, back up, install, start and verify Ready.")
    source=parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--release"); source.add_argument("--archive",type=Path)
    parser.add_argument("--sha256"); parser.add_argument("--runtime-root",type=Path,required=True)
    parser.add_argument("--scratch-root",type=Path,required=True)
    parser.add_argument("--operation-id"); parser.add_argument("--prepare-update",action="store_true")
    parser.add_argument("--mode",choices=INSTALL_MODES,
                        help="wait: Дождаться текущих ходов; force: Завершить все ходы")
    parser.add_argument("--update-status",action="store_true")
    parser.add_argument("--resume-prestop",action="store_true",help="Continue the exact published pre-stop refusal, retaining its UNKNOWN history")
    parser.add_argument("--resume-partialstop",action="store_true",help="Continue the bound d148 partial-stop failure after previous Ready is restored")
    parser.add_argument("--inspect-package",action="store_true")
    parser.add_argument("--offline",action="store_true",
                        help="Install after Hub is fully stopped, without launching a worker or starting Hub")
    args=parser.parse_args()
    if args.offline:
        if (args.mode or args.operation_id or args.inspect_package or args.prepare_update or args.update_status
                or args.resume_prestop or args.resume_partialstop):
            parser.error("--offline is separate from autonomous installation, continuation and readback")
        return historical_main()
    if args.inspect_package: return historical_main()
    if os.name!="nt": raise RuntimeError("This installer requires Windows")
    root=args.runtime_root.resolve(strict=True); _plain_chain(root)
    if args.update_status and args.operation_id:
        print(json.dumps(original_status(args.operation_id,read_update_original(root,args.operation_id)))); return
    mode = choose_install_mode(args.mode)
    if (args.resume_prestop or args.resume_partialstop) and mode != "force":
        parser.error("Historical stop continuation requires explicit --mode force")
    scratch=args.scratch_root.resolve(); scratch.mkdir(parents=True,exist_ok=True); _plain_chain(scratch)
    if scratch.is_relative_to(root) or root.is_relative_to(scratch): raise ValueError("Installer scratch must be outside the selected runtime")
    if args.archive and (not args.sha256 or not re.fullmatch('[0-9a-f]{64}',args.sha256)): parser.error("--archive requires exact --sha256")
    selection=dict(runtimeRoot=str(root),runtimeIdentity=_directory_identity(root),release=args.release,
                   archive=str(args.archive.resolve(strict=True)) if args.archive else None,sha256=args.sha256,
                   installerSha256=file_hash(Path(__file__).resolve()),mode=mode)
    op=args.operation_id or 'install-'+hashlib.sha256(json.dumps(selection,sort_keys=True).encode()).hexdigest()[:32]
    if not re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,127}',op): parser.error("Invalid original operation ID")
    selection['operationId']=op
    original=read_update_original(root,op)
    if (args.resume_prestop or args.resume_partialstop) and (not args.operation_id or not args.archive or args.update_status
            or (args.resume_prestop and args.resume_partialstop)):
        parser.error("Continuation requires one mode, exact original and archive input")
    if (original is not None and not (args.resume_prestop or args.resume_partialstop)) or args.update_status:
        print(json.dumps(original_status(op,original))); return
    cache=scratch/('agenthub-autonomous-'+hashlib.sha256((str(root)+'\0'+op).encode()).hexdigest()[:32])
    if args.resume_prestop or args.resume_partialstop:
        completed_key = "autonomousPartialResume" if args.resume_partialstop else "autonomousResume"
        completed = original.get("metadata",{}).get(completed_key) if original else None
        retry_a297 = (args.resume_partialstop and completed
                      and completed.get("installerSha256")==PARTIAL_RETRY_INSTALLER_SHA
                      and original.get("revision")==5 and original.get("outcome")=="unknown")
        if completed and not retry_a297:
            print(json.dumps(original_status(op,original))); return
        if not original: raise RuntimeError("Original pre-stop refusal is missing")
        previous_request=_read_record(cache/'request.json')
        if any(previous_request.get(key)!=selection.get(key) for key in ['runtimeRoot','runtimeIdentity','archive','sha256','release','operationId']):
            raise RuntimeError("Original continuation input changed")
        if args.resume_partialstop:
            if retry_a297:
                cache=Path(completed["priorCache"])/('resume-partial-'+PARTIAL_RETRY_INSTALLER_SHA[:16])
            else:
                cache=cache/('resume-'+PARTIAL_STOP_INSTALLER_SHA[:16])
            verify_partial_stop_resume(root,cache,original)
            selection['resumePartial']=dict(cache=str(cache),original=original)
            cache=continuation_cache(scratch,root,op,selection['installerSha256'])
        else:
            verify_pre_stop_resume(root,cache,original)
            selection['resume']=dict(cache=str(cache),original=original)
            cache=continuation_cache(scratch,root,op,selection['installerSha256'])
    if cache.exists():
        prior=_read_record(cache/'request.json')
        if prior!=selection: raise RuntimeError("Original input differs; no effects replayed")
        retained_result = cache/'result.json'
        dispatch_failure = cache/'worker-dispatch-failure.json'
        if not retained_result.exists() and dispatch_failure.exists():
            record = _read_record(dispatch_failure)
            checks = record.get("checks")
            report_worker_dispatch_failure(selection, checks if isinstance(checks, dict) else {}, True)
        print(json.dumps(dict(operationId=op,retained=str(cache),effectsReplayed=False,
                             result=_read_record(retained_result) if retained_result.exists() else None))); return
    request_written = False
    started = time.monotonic()
    try:
        cache.mkdir()
        _write_record(cache/'request.json',selection)
        request_written = True
        worker=cache/'install_release.py'
        shutil.copyfile(Path(__file__).resolve(),worker)
        if file_hash(worker)!=selection['installerSha256']: raise RuntimeError("Retained installer differs")
        # A Windows virtual-environment redirector starts another Python
        # process after Resume. Bind the actual interpreter we already run in.
        _, _, kernel = native_api()
        worker_executable = process_identity(kernel.GetCurrentProcess())["image"]
    except (OSError, ValueError, RuntimeError) as error:
        checks = dict(stage="prepare-worker", windowsBuild=sys.getwindowsversion().build,
                      workerIdentityVerified=False, resumeAttempted=False, winerror=getattr(error,"winerror",None))
        record_saved = request_written and retain_worker_dispatch_failure(cache, error, checks, started)
        report_worker_dispatch_failure(selection, checks, record_saved)
    try:
        proof=independent_worker([worker_executable,'-X','utf8','-B',str(worker),'--autonomous-worker',str(cache/'request.json')],
                                 cache,clean_installer_environment(),
                                 runtime_root=None if selection.get("resume") or selection.get("resumePartial") else root)
    except WorkerDispatchError as error:
        report_worker_dispatch_failure(selection, error.checks, error.record_saved)
    _write_record(cache/'dispatch.json',proof)
    # Acknowledgement is dispatch only. Durable original/result is the outcome.
    print(json.dumps(dict(operationId=op,worker=proof,retained=str(cache),resultFile=str(cache/'result.json'),status='dispatched')),flush=True)


if __name__ == "__main__":
    autonomous_main()


